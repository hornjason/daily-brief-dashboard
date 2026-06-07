/**
 * Attendee Profile Cache — Multi-strategy attendee identity resolution (#645)
 *
 * Deep module that resolves attendee identities from email addresses using a
 * priority-ordered strategy chain:
 *   1. Cache hit — read from persistent domain-level JSON files
 *   2. Calendar display name — use provided name + grounding for title/LinkedIn
 *   3. Email-derived + grounding — parse name from email pattern, search via Gemini
 *   4. Broad grounded search — for ambiguous emails (jsmith@), wider search
 *   5. Cross-reference — check meeting history for prior appearances
 *   6. Persist — write every successful resolution to cache immediately
 *
 * Cache structure: data/cache/attendee-profiles/{domain}.json
 *   One file per email domain, keyed by full email address.
 *
 * See CONTEXT.md "Attendee profile cache" for domain terminology.
 */

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from './atomic-write.ts'
import { CACHE_DIR } from './paths.ts'
import type { PrepHistoryEntry } from '../meeting-prep-service.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export interface AttendeeProfile {
  email: string
  name: string
  title: string
  company: string
  linkedinUrl?: string
  resolved: boolean
  resolvedAt?: string
  source: 'cache' | 'calendar' | 'grounding' | 'cross-ref' | 'email-derived'
}

interface ParsedName {
  name: string
  confidence: 'high' | 'medium' | 'low'
}

// ── Module state ────────────────────────────────────────────────────────────

let _cacheDir = resolve(CACHE_DIR, 'attendee-profiles')

/** Test-only: override cache directory */
export function _setCacheDir(dir: string): void {
  _cacheDir = dir
}

function getCacheFilePath(domain: string): string {
  return resolve(_cacheDir, `${domain}.json`)
}

// ── Cache I/O ───────────────────────────────────────────────────────────────

export function readProfileCache(domain: string): Record<string, AttendeeProfile> | null {
  const path = getCacheFilePath(domain)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

export function writeProfileCache(domain: string, profiles: Record<string, AttendeeProfile>): void {
  if (!existsSync(_cacheDir)) mkdirSync(_cacheDir, { recursive: true })
  writeJsonAtomic(getCacheFilePath(domain), profiles)
}

function persistProfile(profile: AttendeeProfile): void {
  const domain = profile.email.split('@')[1] ?? ''
  if (!domain) return

  const existing = readProfileCache(domain) ?? {}
  existing[profile.email] = profile
  writeProfileCache(domain, existing)
}

// ── Email name parsing ──────────────────────────────────────────────────────

export function parseNameFromEmail(email: string): ParsedName {
  const local = email.split('@')[0] ?? ''

  // Check for separators: dot, underscore, hyphen
  const separators = /[.\-_]/
  if (separators.test(local)) {
    const parts = local.split(separators).filter(Boolean)
    const capitalized = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    const name = capitalized.join(' ')

    // Single character first part → initial (medium confidence)
    if (parts[0]?.length === 1) {
      return { name: capitalized.join(' '), confidence: 'medium' }
    }
    // Two or more parts with reasonable length → high confidence
    if (parts.length >= 2 && parts.every(p => p.length >= 2)) {
      return { name, confidence: 'high' }
    }
    return { name, confidence: 'high' }
  }

  // No separators — single token (jsmith, j, etc.)
  const capitalized = local.charAt(0).toUpperCase() + local.slice(1).toLowerCase()
  return { name: capitalized, confidence: 'low' }
}

// ── Grounding search (Gemini) ───────────────────────────────────────────────

async function groundingSearch(
  name: string,
  company: string,
  email: string,
): Promise<Partial<AttendeeProfile> | null> {
  try {
    const { callGemini } = await import('../gemini-call.ts')
    const result = await callGemini(
      'You are a professional identity researcher. Given a person\'s name and their company, find their current LinkedIn profile. Return ONLY a JSON object with these fields: title (current job title), linkedinUrl (full LinkedIn URL). If you cannot find the person with certainty, return {"title":"","linkedinUrl":""}. Never guess — return empty strings if unsure.',
      `Find the LinkedIn profile for "${name}" who works at "${company}" (email: ${email}).
Search: "${name}" site:linkedin.com ${company}
If a linkedinUrl is already known, Research this LinkedIn profile to confirm the title.
Return JSON: {"title":"...","linkedinUrl":"..."}`,
      {
        callType: 'attendee-profile-resolution',
        customerName: company,
        grounding: true,
        timeoutMs: 30_000,
      }
    )

    // Parse JSON from response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        title: parsed.title ?? '',
        linkedinUrl: parsed.linkedinUrl || undefined,
      }
    }
  } catch (e: any) {
    console.warn(`[attendee-cache] Grounding search failed for ${name} at ${company}:`, e.message)
  }
  return null
}

// ── Resolution strategies ───────────────────────────────────────────────────

async function resolveFromCache(email: string): Promise<AttendeeProfile | null> {
  const domain = email.split('@')[1] ?? ''
  const cached = readProfileCache(domain)
  if (cached && cached[email]) {
    return { ...cached[email], source: 'cache' }
  }
  return null
}

function resolveFromCalendar(
  email: string,
  calendarDisplayNames?: Map<string, string>,
  companyName?: string,
): AttendeeProfile | null {
  if (!calendarDisplayNames?.has(email)) return null
  const name = calendarDisplayNames.get(email)!
  const domain = email.split('@')[1] ?? ''
  const company = companyName ?? deriveCompany(domain)

  return {
    email,
    name,
    title: '',
    company,
    resolved: true,
    resolvedAt: new Date().toISOString(),
    source: 'calendar',
  }
}

async function resolveFromEmailDerived(
  email: string,
  companyName: string,
): Promise<AttendeeProfile | null> {
  const parsed = parseNameFromEmail(email)
  const domain = email.split('@')[1] ?? ''
  const company = companyName || deriveCompany(domain)

  // For low-confidence names, try grounding but expect it might fail
  const grounded = await groundingSearch(parsed.name, company, email)

  if (grounded && (grounded.title || grounded.linkedinUrl)) {
    return {
      email,
      name: parsed.name,
      title: grounded.title ?? '',
      company,
      linkedinUrl: grounded.linkedinUrl,
      resolved: true,
      resolvedAt: new Date().toISOString(),
      source: 'grounding',
    }
  }

  // Even without grounding, if we parsed a name, it's still useful
  if (parsed.confidence !== 'low') {
    return {
      email,
      name: parsed.name,
      title: '',
      company,
      resolved: true,
      resolvedAt: new Date().toISOString(),
      source: 'email-derived',
    }
  }

  return null
}

function resolveFromCrossRef(
  email: string,
  meetingHistory?: PrepHistoryEntry[],
): AttendeeProfile | null {
  if (!meetingHistory?.length) return null

  // #655: Search meeting history for prior appearances of this email
  for (const entry of meetingHistory) {
    if (entry.attendeeEmails?.includes(email)) {
      // Found in a prior meeting — check cache for the resolved profile
      const domain = email.split('@')[1] ?? ''
      const cached = readProfileCache(domain)
      if (cached && cached[email]) {
        return { ...cached[email], source: 'cross-ref' }
      }
    }
  }

  // Fallback: check cache directly (may have been populated by parallel process)
  const domain = email.split('@')[1] ?? ''
  const cached = readProfileCache(domain)
  if (cached && cached[email]) {
    return { ...cached[email], source: 'cross-ref' }
  }
  return null
}

function buildUnresolved(email: string, companyName: string): AttendeeProfile {
  const parsed = parseNameFromEmail(email)
  const domain = email.split('@')[1] ?? ''
  return {
    email,
    name: parsed.name,
    title: '',
    company: companyName || deriveCompany(domain),
    resolved: false,
    source: 'email-derived',
  }
}

function deriveCompany(domain: string): string {
  const company = domain.split('.')[0] ?? ''
  return company.charAt(0).toUpperCase() + company.slice(1)
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve attendee identities from email addresses using a multi-strategy chain.
 *
 * Resolution priority:
 *   1. Cache hit
 *   2. Calendar display name
 *   3. Email-derived + Gemini grounded search
 *   4. Cross-reference meeting history
 *   5. Unresolved fallback
 *
 * Every successful resolution is persisted to cache immediately.
 */
export async function resolveAttendees(
  emails: string[],
  companyName: string,
  options: {
    calendarDisplayNames?: Map<string, string>
    meetingHistory?: PrepHistoryEntry[]
    customerName?: string
  }
): Promise<AttendeeProfile[]> {
  const results: AttendeeProfile[] = []

  for (const email of emails) {
    let profile: AttendeeProfile | null = null

    // Strategy 1: Cache hit
    profile = await resolveFromCache(email)
    if (profile) {
      results.push(profile)
      continue
    }

    // Strategy 2: Calendar display name
    profile = resolveFromCalendar(email, options.calendarDisplayNames, companyName)
    if (profile) {
      persistProfile(profile)
      results.push(profile)
      continue
    }

    // Strategy 3: Email-derived + grounding
    try {
      profile = await resolveFromEmailDerived(email, companyName)
      if (profile) {
        persistProfile(profile)
        results.push(profile)
        continue
      }
    } catch {
      // Grounding failed — continue to next strategy
    }

    // Strategy 4: Cross-reference meeting history
    profile = resolveFromCrossRef(email, options.meetingHistory)
    if (profile) {
      results.push(profile)
      continue
    }

    // Strategy 5: Unresolved fallback
    const unresolved = buildUnresolved(email, companyName)
    results.push(unresolved)
  }

  return results
}
