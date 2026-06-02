/**
 * test/unit/persona-enrichment.test.ts
 * TDD tests for persona enrichment + contact registry (#519)
 *
 * Tests the deterministic matching layers (existing contacts, meeting attendees).
 * Gemini grounding is mocked — core value is in the matching logic.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

// We'll dynamically import the module to allow mocking
let enrichPersonas: typeof import('../../src/lib/persona-enrichment.ts').enrichPersonas
let matchesPersona: typeof import('../../src/lib/persona-enrichment.ts').matchesPersona

const TEST_DIR = resolve(import.meta.dir, '../../data/cache/__test-persona-enrichment')
const CONFIG_DIR = resolve(import.meta.dir, '../../data/config/__test-persona-enrichment')

beforeEach(async () => {
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(CONFIG_DIR, { recursive: true })
  // Fresh import each test
  const mod = await import('../../src/lib/persona-enrichment.ts')
  enrichPersonas = mod.enrichPersonas
  matchesPersona = mod.matchesPersona
})

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  if (existsSync(CONFIG_DIR)) rmSync(CONFIG_DIR, { recursive: true, force: true })
})

// ── matchesPersona ──────────────────────────────────────────────────────────

describe('matchesPersona', () => {
  it('exact match returns true', () => {
    expect(matchesPersona('VP Infrastructure', 'VP Infrastructure')).toBe(true)
  })

  it('handles title abbreviations — VP = Vice President', () => {
    expect(matchesPersona('Vice President, Infrastructure', 'VP Infrastructure')).toBe(true)
    expect(matchesPersona('VP Infrastructure', 'Vice President Infrastructure')).toBe(true)
  })

  it('handles CTO = Chief Technology Officer', () => {
    expect(matchesPersona('Chief Technology Officer', 'CTO')).toBe(true)
    expect(matchesPersona('CTO', 'Chief Technology Officer')).toBe(true)
  })

  it('handles CIO = Chief Information Officer', () => {
    expect(matchesPersona('Chief Information Officer', 'CIO')).toBe(true)
    expect(matchesPersona('SVP & CIO', 'CIO')).toBe(true)
  })

  it('handles Dir = Director', () => {
    expect(matchesPersona('Director of Engineering', 'Dir Engineering')).toBe(true)
    expect(matchesPersona('Dir Engineering', 'Director Engineering')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesPersona('vp infrastructure', 'VP Infrastructure')).toBe(true)
    expect(matchesPersona('VP INFRASTRUCTURE', 'vp infrastructure')).toBe(true)
  })

  it('matches VP of Infrastructure Engineering to VP Infrastructure', () => {
    expect(matchesPersona('VP of Infrastructure Engineering', 'VP Infrastructure')).toBe(true)
  })

  it('matches Vice President Infrastructure and Operations to VP Infrastructure', () => {
    expect(matchesPersona('Vice President Infrastructure and Operations', 'VP Infrastructure')).toBe(true)
  })

  it('does not match unrelated titles', () => {
    expect(matchesPersona('VP Marketing', 'VP Infrastructure')).toBe(false)
    expect(matchesPersona('Software Engineer', 'CTO')).toBe(false)
  })

  it('handles CISO = Chief Information Security Officer', () => {
    expect(matchesPersona('Chief Information Security Officer', 'CISO')).toBe(true)
  })

  it('handles SVP = Senior Vice President', () => {
    expect(matchesPersona('Senior Vice President Engineering', 'SVP Engineering')).toBe(true)
  })
})

// ── enrichPersonas ──────────────────────────────────────────────────────────

describe('enrichPersonas', () => {
  it('returns found for existing contact matching persona', () => {
    const contacts = [
      makeContact({ name: 'Alice Smith', title: 'VP Infrastructure', email: 'alice@acme.com' }),
    ]

    const results = enrichPersonas({
      customerSlug: 'acme',
      customerName: 'Acme Corp',
      targetPersonas: ['VP Infrastructure'],
      existingContacts: contacts,
      cacheDir: TEST_DIR,
    })

    expect(results).toHaveLength(1)
    expect(results[0].personaRole).toBe('VP Infrastructure')
    expect(results[0].status).toBe('found')
    expect(results[0].contact?.name).toBe('Alice Smith')
    expect(results[0].contact?.source).toBe('meeting')
  })

  it('finds contact from meeting attendees', () => {
    // Write a mock meetings file
    const meetingsData = {
      data: [
        {
          attendeeDetails: [
            {
              displayName: 'Bob Johnson',
              email: 'bob@acme.com',
              title: 'Chief Technology Officer',
              linkedinUrl: 'https://linkedin.com/in/bobjohnson',
            },
          ],
        },
      ],
      cachedAt: new Date().toISOString(),
      ttlMs: 7200000,
    }
    writeFileSync(resolve(TEST_DIR, 'acme-meetings.json'), JSON.stringify(meetingsData))

    const results = enrichPersonas({
      customerSlug: 'acme',
      customerName: 'Acme Corp',
      targetPersonas: ['CTO'],
      existingContacts: [],
      cacheDir: TEST_DIR,
    })

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('found')
    expect(results[0].contact?.name).toBe('Bob Johnson')
    expect(results[0].contact?.email).toBe('bob@acme.com')
    expect(results[0].contact?.linkedinUrl).toBe('https://linkedin.com/in/bobjohnson')
    expect(results[0].contact?.source).toBe('meeting')
  })

  it('returns not_found when no match exists', () => {
    const results = enrichPersonas({
      customerSlug: 'acme',
      customerName: 'Acme Corp',
      targetPersonas: ['VP Infrastructure'],
      existingContacts: [],
      cacheDir: TEST_DIR,
    })

    expect(results).toHaveLength(1)
    expect(results[0].personaRole).toBe('VP Infrastructure')
    expect(results[0].status).toBe('not_found')
    expect(results[0].contact).toBeUndefined()
  })

  it('does not re-search for already found personas', () => {
    const contacts = [
      makeContact({ name: 'Alice Smith', title: 'VP Infrastructure', email: 'alice@acme.com' }),
    ]

    // Write meetings with another VP Infrastructure
    const meetingsData = {
      data: [
        {
          attendeeDetails: [
            {
              displayName: 'Charlie Brown',
              email: 'charlie@acme.com',
              title: 'VP Infrastructure',
            },
          ],
        },
      ],
      cachedAt: new Date().toISOString(),
      ttlMs: 7200000,
    }
    writeFileSync(resolve(TEST_DIR, 'acme-meetings.json'), JSON.stringify(meetingsData))

    const results = enrichPersonas({
      customerSlug: 'acme',
      customerName: 'Acme Corp',
      targetPersonas: ['VP Infrastructure'],
      existingContacts: contacts,
      cacheDir: TEST_DIR,
    })

    // Should find Alice from existing contacts, not Charlie from meetings
    expect(results).toHaveLength(1)
    expect(results[0].contact?.name).toBe('Alice Smith')
  })

  it('finds contacts from case submitters', () => {
    // Write mock cases file
    const casesData = {
      scrapedAt: new Date().toISOString(),
      accounts: ['123456'],
      cases: [
        {
          caseNumber: '12345',
          summary: 'Test case',
          status: 'Open',
          severity: '2',
          accountNumber: '123456',
          accountName: 'Acme Corp',
          contactName: 'Diana Prince',
          contactTitle: 'Director of Engineering',
          contactEmail: 'diana@acme.com',
        },
      ],
    }
    writeFileSync(resolve(TEST_DIR, 'cases.json'), JSON.stringify(casesData))

    const results = enrichPersonas({
      customerSlug: 'acme',
      customerName: 'Acme Corp',
      targetPersonas: ['Dir Engineering'],
      existingContacts: [],
      cacheDir: TEST_DIR,
    })

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('found')
    expect(results[0].contact?.name).toBe('Diana Prince')
    expect(results[0].contact?.source).toBe('case')
  })

  it('handles multiple target personas', () => {
    const contacts = [
      makeContact({ name: 'Alice Smith', title: 'VP Infrastructure', email: 'alice@acme.com' }),
    ]

    const results = enrichPersonas({
      customerSlug: 'acme',
      customerName: 'Acme Corp',
      targetPersonas: ['VP Infrastructure', 'CTO', 'Dir Engineering'],
      existingContacts: contacts,
      cacheDir: TEST_DIR,
    })

    expect(results).toHaveLength(3)
    expect(results[0].status).toBe('found') // VP Infrastructure matched from contacts
    expect(results[1].status).toBe('not_found') // CTO not found
    expect(results[2].status).toBe('not_found') // Dir Engineering not found
  })

  it('handles missing meetings file gracefully', () => {
    const results = enrichPersonas({
      customerSlug: 'nonexistent',
      customerName: 'Nonexistent Corp',
      targetPersonas: ['CTO'],
      existingContacts: [],
      cacheDir: TEST_DIR,
    })

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('not_found')
  })
})

// ── Helper ──────────────────────────────────────────────────────────────────

function makeContact(overrides: {
  name: string
  title: string
  email: string
  linkedinUrl?: string
}): import('../../src/people-service.ts').Contact {
  return {
    id: `c-test-${Date.now()}`,
    customerName: 'Acme Corp',
    name: overrides.name,
    email: overrides.email,
    title: overrides.title,
    linkedinUrl: overrides.linkedinUrl,
    role: 'unknown',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
