/**
 * src/lib/persona-enrichment.ts
 * Persona enrichment + contact registry (#519)
 *
 * When the intelligence graph finds a Play that TARGETS_PERSONA but no matching
 * Person node exists for the customer, this module triggers automatic contact
 * discovery through tiered enrichment (cheapest source first):
 *
 *   1. Existing contacts (people-service)
 *   2. Meeting attendees (cache)
 *   3. Case submitters (cache)
 *   4. Gemini grounding search (last resort, async)
 *
 * Found contacts are written to the contact registry via people-service patterns.
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { Contact } from '../people-service.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface EnrichmentResult {
  personaRole: string
  status: 'found' | 'not_found'
  contact?: {
    name: string
    email?: string
    title?: string
    linkedinUrl?: string
    source: 'meeting' | 'case' | 'grounding'
  }
}

export interface EnrichmentOptions {
  customerSlug: string
  customerName: string
  targetPersonas: string[]
  existingContacts: Contact[]
  cacheDir: string
}

// ── Title abbreviation map ───────────────────────────────────────────────────

const ABBREVIATIONS: Record<string, string[]> = {
  'vp': ['vice president'],
  'vice president': ['vp'],
  'svp': ['senior vice president'],
  'senior vice president': ['svp'],
  'evp': ['executive vice president'],
  'executive vice president': ['evp'],
  'cto': ['chief technology officer'],
  'chief technology officer': ['cto'],
  'cio': ['chief information officer'],
  'chief information officer': ['cio'],
  'ciso': ['chief information security officer'],
  'chief information security officer': ['ciso'],
  'cfo': ['chief financial officer'],
  'chief financial officer': ['cfo'],
  'ceo': ['chief executive officer'],
  'chief executive officer': ['ceo'],
  'coo': ['chief operating officer'],
  'chief operating officer': ['coo'],
  'dir': ['director'],
  'director': ['dir'],
}

// Noise words to strip from titles when doing keyword matching
const NOISE_WORDS = new Set(['of', 'and', 'the', '&', ',', '-', 'for', 'in'])

// ── Title matching ───────────────────────────────────────────────────────────

/**
 * Fuzzy title-to-persona matching using keyword extraction + abbreviation expansion.
 *
 * "VP Infrastructure" matches:
 *   "Vice President, Infrastructure"
 *   "VP of Infrastructure Engineering"
 *   "Vice President Infrastructure and Operations"
 *
 * Strategy: expand both title and persona into canonical keyword sets (with
 * abbreviation normalization), then check if ALL persona keywords appear in
 * the title keywords.
 */
export function matchesPersona(title: string, personaRole: string): boolean {
  const titleKeywords = expandKeywords(title)
  const personaKeywords = expandKeywords(personaRole)

  // Every persona keyword must appear in the title keywords
  return [...personaKeywords].every(pk => titleKeywords.has(pk))
}

/**
 * Normalize a title string by replacing multi-word abbreviations with their
 * canonical forms, then extract keywords.
 *
 * Strategy: first replace all known multi-word phrases with their abbreviation
 * (and vice versa), then tokenize and collect all forms.
 */
function expandKeywords(text: string): Set<string> {
  let normalized = text.toLowerCase()

  // Replace multi-word phrases with canonical short form + keep originals
  // Sort by length descending so longer phrases match first
  const phrases = Object.keys(ABBREVIATIONS)
    .filter(k => k.includes(' '))
    .sort((a, b) => b.length - a.length)

  for (const phrase of phrases) {
    if (normalized.includes(phrase)) {
      // Add the abbreviation equivalent alongside
      const abbrevs = ABBREVIATIONS[phrase]
      for (const abbr of abbrevs) {
        normalized = normalized + ' ' + abbr
      }
    }
  }

  // Split on whitespace, commas, ampersands, hyphens
  const tokens = normalized.split(/[\s,&\-]+/).filter(t => t.length > 0 && !NOISE_WORDS.has(t))

  const keywords = new Set<string>()

  for (const token of tokens) {
    keywords.add(token)
    // Add single-word abbreviation expansions
    const expansions = ABBREVIATIONS[token]
    if (expansions) {
      for (const exp of expansions) {
        for (const word of exp.split(/\s+/)) {
          keywords.add(word)
        }
      }
    }
  }

  return keywords
}

// ── Enrichment flow ──────────────────────────────────────────────────────────

/**
 * Enrich target personas with real contact data from cheapest source first.
 * Synchronous for deterministic sources (contacts, meetings, cases).
 */
export function enrichPersonas(opts: EnrichmentOptions): EnrichmentResult[] {
  const { customerSlug, customerName, targetPersonas, existingContacts, cacheDir } = opts
  const results: EnrichmentResult[] = []
  const found = new Set<string>() // persona roles already matched

  // Layer 1: Check existing contacts
  for (const persona of targetPersonas) {
    if (found.has(persona)) continue

    const match = existingContacts.find(c => c.title && matchesPersona(c.title, persona))
    if (match) {
      results.push({
        personaRole: persona,
        status: 'found',
        contact: {
          name: match.name,
          email: match.email || undefined,
          title: match.title,
          linkedinUrl: match.linkedinUrl,
          source: 'meeting',
        },
      })
      found.add(persona)
    }
  }

  // Layer 2: Check meeting attendees
  const meetingAttendees = loadMeetingAttendees(customerSlug, cacheDir)
  for (const persona of targetPersonas) {
    if (found.has(persona)) continue

    const match = meetingAttendees.find(a => a.title && matchesPersona(a.title, persona))
    if (match) {
      results.push({
        personaRole: persona,
        status: 'found',
        contact: {
          name: match.displayName,
          email: match.email,
          title: match.title,
          linkedinUrl: match.linkedinUrl,
          source: 'meeting',
        },
      })
      found.add(persona)
    }
  }

  // Layer 3: Check case submitters
  const caseSubmitters = loadCaseSubmitters(customerName, cacheDir)
  for (const persona of targetPersonas) {
    if (found.has(persona)) continue

    const match = caseSubmitters.find(s => s.title && matchesPersona(s.title, persona))
    if (match) {
      results.push({
        personaRole: persona,
        status: 'found',
        contact: {
          name: match.name,
          email: match.email,
          title: match.title,
          source: 'case',
        },
      })
      found.add(persona)
    }
  }

  // Layer 4: Gemini grounding search — async, not implemented in this pass.
  // Will be added when intelligence-graph integration calls enrichPersonasAsync().

  // Fill in not_found for any remaining personas
  for (const persona of targetPersonas) {
    if (!found.has(persona)) {
      results.push({
        personaRole: persona,
        status: 'not_found',
      })
    }
  }

  return results
}

// ── Data loaders ─────────────────────────────────────────────────────────────

interface MeetingAttendee {
  displayName: string
  email?: string
  title?: string
  linkedinUrl?: string
}

function loadMeetingAttendees(customerSlug: string, cacheDir: string): MeetingAttendee[] {
  const filePath = resolve(cacheDir, `${customerSlug}-meetings.json`)
  if (!existsSync(filePath)) return []

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    const meetings: Array<{ attendeeDetails?: MeetingAttendee[] }> = raw.data ?? []
    const attendees: MeetingAttendee[] = []

    for (const meeting of meetings) {
      if (!meeting.attendeeDetails) continue
      for (const a of meeting.attendeeDetails) {
        if (a.displayName) attendees.push(a)
      }
    }

    return attendees
  } catch {
    return []
  }
}

interface CaseSubmitter {
  name: string
  email?: string
  title?: string
}

function loadCaseSubmitters(customerName: string, cacheDir: string): CaseSubmitter[] {
  const filePath = resolve(cacheDir, 'cases.json')
  if (!existsSync(filePath)) return []

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    const cases: Array<{
      accountName?: string
      contactName?: string
      contactTitle?: string
      contactEmail?: string
    }> = raw.cases ?? []

    const submitters: CaseSubmitter[] = []
    const seen = new Set<string>()

    for (const c of cases) {
      if (!c.contactName) continue
      // Match by customer name (case-insensitive)
      if (c.accountName && c.accountName.toLowerCase() !== customerName.toLowerCase()) continue
      if (seen.has(c.contactName.toLowerCase())) continue
      seen.add(c.contactName.toLowerCase())

      submitters.push({
        name: c.contactName,
        email: c.contactEmail,
        title: c.contactTitle,
      })
    }

    return submitters
  } catch {
    return []
  }
}
