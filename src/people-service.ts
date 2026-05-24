/**
 * People Service — Contact Profiles, Outreach History, Org Chart, Partner Matching
 *
 * Data layer for the "people" dimension of customer intelligence.
 * Complements the existing signal system (company/product intelligence)
 * with per-person context: who they are, what we've sent them, where they
 * sit in the org, and which partners match their tech stack.
 *
 * Storage: JSON files in data/config/ (same pattern as partners.json, aes.json).
 * No external dependencies. Pure sync reads, atomic writes.
 *
 * GitHub #327
 */

import { readFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from './lib/atomic-write.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export type ContactRole = 'champion' | 'neutral' | 'blocker' | 'unknown'
export type OutreachType = 'email' | 'campaign' | 'meeting' | 'call' | 'linkedin'
export type OutreachResponse = 'no_response' | 'opened' | 'replied' | 'meeting_booked' | 'declined'
export type DecisionAuthority = 'high' | 'medium' | 'low' | 'unknown'
export type MeddpiccRole = 'E' | 'D1' | 'D2' | 'C1' | 'C2' | null
export type PreferredChannel = 'email' | 'phone' | 'linkedin' | 'teams' | 'slack'

export interface Contact {
  id: string
  customerName: string
  name: string
  email: string
  title?: string
  linkedinUrl?: string
  role: ContactRole
  interests?: string[]
  communicationPreferences?: { preferredChannel: PreferredChannel }
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface OutreachEntry {
  contactId: string
  type: OutreachType
  subject: string
  topics: string[]
  sentAt: string
  campaignId?: string
  response: OutreachResponse
}

export interface OrgChartEntry {
  customerName: string
  contactId: string
  reportsTo: string | null
  decisionAuthority: DecisionAuthority
  relationship: ContactRole
  meddpiccRole: MeddpiccRole
}

export interface PartnerMatch {
  partner: PartnerConfig
  matchedSpecializations: string[]
  matchedProducts: string[]
}

export interface AttendeeProfile {
  contact: Contact
  outreachHistory: OutreachEntry[]
  orgEntry: OrgChartEntry | null
}

interface PartnerConfig {
  name: string
  aliases: string[]
  domain: string
  partnershipLevel: string
  specializations: string[]
  geo: string
  country: string
  catalogUrl?: string
  sourceUrl?: string
}

// ── Storage schema ───────────────────────────────────────────────────────────

interface PeopleStore {
  contacts: Contact[]
  outreach: OutreachEntry[]
  orgChart: OrgChartEntry[]
}

// ── Specialization → product slug mapping ────────────────────────────────────

const SPEC_TO_PRODUCT: Record<string, string[]> = {
  'Mission Critical Automation': ['aap'],
  'Container Mgmt': ['ocp'],
  'Application Platform': ['ocp', 'rhdh'],
  'Virtualization': ['ocp'],
  'Server Cloud': ['rhel'],
  'Server Cloud OS': ['rhel'],
}

// ── Service factory ──────────────────────────────────────────────────────────

export interface PeopleServiceOptions {
  configDir: string
}

export function createPeopleService(opts: PeopleServiceOptions) {
  const storePath = resolve(opts.configDir, 'contacts.json')
  const partnersPath = resolve(opts.configDir, 'partners.json')

  function readStore(): PeopleStore {
    if (!existsSync(storePath)) return { contacts: [], outreach: [], orgChart: [] }
    try {
      return JSON.parse(readFileSync(storePath, 'utf-8'))
    } catch {
      return { contacts: [], outreach: [], orgChart: [] }
    }
  }

  function writeStore(store: PeopleStore): void {
    mkdirSync(opts.configDir, { recursive: true })
    writeJsonAtomic(storePath, store)
  }

  function loadPartners(): PartnerConfig[] {
    if (!existsSync(partnersPath)) return []
    try { return JSON.parse(readFileSync(partnersPath, 'utf-8')) } catch { return [] }
  }

  // ── Contact CRUD ─────────────────────────────────────────────────────────

  function listContacts(customerName: string): Contact[] {
    const store = readStore()
    return store.contacts.filter(
      c => c.customerName.toLowerCase() === customerName.toLowerCase()
    )
  }

  function getContact(id: string): Contact | null {
    const store = readStore()
    return store.contacts.find(c => c.id === id) ?? null
  }

  function findContactByEmail(email: string): Contact | null {
    const store = readStore()
    return store.contacts.find(
      c => c.email.toLowerCase() === email.toLowerCase()
    ) ?? null
  }

  function upsertContact(input: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: string; updatedAt?: string }): Contact {
    const store = readStore()
    const now = new Date().toISOString()
    const id = input.id ?? `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const existingIdx = store.contacts.findIndex(c => c.id === id)
    const contact: Contact = {
      ...input,
      id,
      createdAt: existingIdx >= 0 ? store.contacts[existingIdx].createdAt : (input.createdAt ?? now),
      updatedAt: now,
    }

    if (existingIdx >= 0) {
      store.contacts[existingIdx] = contact
    } else {
      store.contacts.push(contact)
    }

    writeStore(store)
    return contact
  }

  function deleteContact(id: string): boolean {
    const store = readStore()
    const idx = store.contacts.findIndex(c => c.id === id)
    if (idx < 0) return false

    store.contacts.splice(idx, 1)
    // Also clean up related outreach and org entries
    store.outreach = store.outreach.filter(o => o.contactId !== id)
    store.orgChart = store.orgChart.filter(o => o.contactId !== id)
    writeStore(store)
    return true
  }

  // ── Outreach History ─────────────────────────────────────────────────────

  function logOutreach(entry: OutreachEntry): void {
    const store = readStore()
    store.outreach.push(entry)
    writeStore(store)
  }

  function getOutreachHistory(contactId: string, opts?: { since?: string }): OutreachEntry[] {
    const store = readStore()
    let entries = store.outreach.filter(o => o.contactId === contactId)

    if (opts?.since) {
      const sinceMs = new Date(opts.since).getTime()
      entries = entries.filter(o => new Date(o.sentAt).getTime() >= sinceMs)
    }

    // Sort newest first
    return entries.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
  }

  function wasTopicPitched(contactId: string, topic: string): boolean {
    const store = readStore()
    return store.outreach.some(
      o => o.contactId === contactId && o.topics.some(t => t.toLowerCase() === topic.toLowerCase())
    )
  }

  // ── Org Chart ────────────────────────────────────────────────────────────

  function getOrgChart(customerName: string): OrgChartEntry[] {
    const store = readStore()
    return store.orgChart.filter(
      e => e.customerName.toLowerCase() === customerName.toLowerCase()
    )
  }

  function upsertOrgEntry(entry: OrgChartEntry): void {
    const store = readStore()
    const idx = store.orgChart.findIndex(
      e => e.contactId === entry.contactId && e.customerName.toLowerCase() === entry.customerName.toLowerCase()
    )

    if (idx >= 0) {
      store.orgChart[idx] = entry
    } else {
      store.orgChart.push(entry)
    }

    writeStore(store)
  }

  // ── Partner Matching ─────────────────────────────────────────────────────

  function matchPartners(productSlugs: string[]): PartnerMatch[] {
    const partners = loadPartners()
    if (partners.length === 0 || productSlugs.length === 0) return []

    // Invert the map: product slug → specialization names
    const productToSpec: Record<string, string[]> = {}
    for (const [spec, slugs] of Object.entries(SPEC_TO_PRODUCT)) {
      for (const slug of slugs) {
        if (!productToSpec[slug]) productToSpec[slug] = []
        productToSpec[slug].push(spec)
      }
    }

    // Find all specializations relevant to the requested product slugs
    const targetSpecs = new Set<string>()
    const specToProduct = new Map<string, string[]>()
    for (const slug of productSlugs) {
      const specs = productToSpec[slug] ?? []
      for (const spec of specs) {
        targetSpecs.add(spec)
        if (!specToProduct.has(spec)) specToProduct.set(spec, [])
        specToProduct.get(spec)!.push(slug)
      }
    }

    if (targetSpecs.size === 0) return []

    const matches: PartnerMatch[] = []
    for (const partner of partners) {
      const matchedSpecs = partner.specializations.filter(s => targetSpecs.has(s))
      if (matchedSpecs.length === 0) continue

      const matchedProducts = new Set<string>()
      for (const spec of matchedSpecs) {
        for (const prod of specToProduct.get(spec) ?? []) {
          matchedProducts.add(prod)
        }
      }

      matches.push({
        partner,
        matchedSpecializations: matchedSpecs,
        matchedProducts: [...matchedProducts],
      })
    }

    return matches
  }

  // ── Attendee Profile (enriched view) ─────────────────────────────────────

  function getAttendeeProfile(email: string): AttendeeProfile | null {
    const contact = findContactByEmail(email)
    if (!contact) return null

    const outreachHistory = getOutreachHistory(contact.id)
    const store = readStore()
    const orgEntry = store.orgChart.find(e => e.contactId === contact.id) ?? null

    return { contact, outreachHistory, orgEntry }
  }

  return {
    listContacts,
    getContact,
    findContactByEmail,
    upsertContact,
    deleteContact,
    logOutreach,
    getOutreachHistory,
    wasTopicPitched,
    getOrgChart,
    upsertOrgEntry,
    matchPartners,
    getAttendeeProfile,
  }
}
