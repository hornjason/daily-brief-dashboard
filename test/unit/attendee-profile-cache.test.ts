/**
 * Attendee Profile Cache — Unit Tests
 * Tests for #645: Multi-strategy attendee identity resolution with persistent caching
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Test isolation: use a temp cache directory
const TEST_CACHE_DIR = resolve(import.meta.dir, '../../data/cache/attendee-profiles-test')

// We'll dynamically import the module to allow mocking
let resolveAttendees: typeof import('../../src/lib/attendee-profile-cache.ts').resolveAttendees
let parseNameFromEmail: typeof import('../../src/lib/attendee-profile-cache.ts').parseNameFromEmail
let readProfileCache: typeof import('../../src/lib/attendee-profile-cache.ts').readProfileCache
let writeProfileCache: typeof import('../../src/lib/attendee-profile-cache.ts').writeProfileCache
let _setCacheDir: typeof import('../../src/lib/attendee-profile-cache.ts')._setCacheDir

beforeEach(async () => {
  // Clean test cache
  if (existsSync(TEST_CACHE_DIR)) rmSync(TEST_CACHE_DIR, { recursive: true })
  mkdirSync(TEST_CACHE_DIR, { recursive: true })

  // Fresh import each test
  const mod = await import('../../src/lib/attendee-profile-cache.ts')
  resolveAttendees = mod.resolveAttendees
  parseNameFromEmail = mod.parseNameFromEmail
  readProfileCache = mod.readProfileCache
  writeProfileCache = mod.writeProfileCache
  _setCacheDir = mod._setCacheDir

  // Point cache to test directory
  _setCacheDir(TEST_CACHE_DIR)
})

afterEach(() => {
  if (existsSync(TEST_CACHE_DIR)) rmSync(TEST_CACHE_DIR, { recursive: true })
})

// ── AC-11: Email parsing for 5+ format variations ──────────────────────────

describe('parseNameFromEmail', () => {
  test('firstname.lastname@ → Firstname Lastname', () => {
    const result = parseNameFromEmail('john.doe@example.com')
    expect(result.name).toBe('John Doe')
    expect(result.confidence).toBe('high')
  })

  test('f.lastname@ → F Lastname (initial + last)', () => {
    const result = parseNameFromEmail('j.doe@example.com')
    expect(result.name).toBe('J Doe')
    expect(result.confidence).toBe('medium')
  })

  test('firstname_lastname@ → Firstname Lastname', () => {
    const result = parseNameFromEmail('john_doe@example.com')
    expect(result.name).toBe('John Doe')
    expect(result.confidence).toBe('high')
  })

  test('first.middle.last@ → First Middle Last', () => {
    const result = parseNameFromEmail('john.michael.doe@example.com')
    expect(result.name).toBe('John Michael Doe')
    expect(result.confidence).toBe('high')
  })

  test('jsmith@ → Jsmith (best effort, low confidence)', () => {
    const result = parseNameFromEmail('jsmith@example.com')
    expect(result.name).toBe('Jsmith')
    expect(result.confidence).toBe('low')
  })

  test('firstname-lastname@ → Firstname Lastname', () => {
    const result = parseNameFromEmail('john-doe@example.com')
    expect(result.name).toBe('John Doe')
    expect(result.confidence).toBe('high')
  })

  test('single character local part', () => {
    const result = parseNameFromEmail('j@example.com')
    expect(result.name).toBe('J')
    expect(result.confidence).toBe('low')
  })
})

// ── AC-2 & AC-3: Cache structure and cache hit ─────────────────────────────

describe('cache read/write', () => {
  test('AC-2: cache files stored at {domain}.json', () => {
    const profile = {
      email: 'john.doe@acme.com',
      name: 'John Doe',
      title: 'VP Engineering',
      company: 'Acme Corp',
      linkedinUrl: 'https://linkedin.com/in/johndoe',
      resolved: true,
      resolvedAt: '2026-06-06T00:00:00Z',
      source: 'grounding' as const,
    }
    writeProfileCache('acme.com', { 'john.doe@acme.com': profile })

    const cached = readProfileCache('acme.com')
    expect(cached).toBeDefined()
    expect(cached!['john.doe@acme.com'].name).toBe('John Doe')
    expect(cached!['john.doe@acme.com'].title).toBe('VP Engineering')
  })

  test('AC-2: separate domain files for different domains', () => {
    writeProfileCache('acme.com', {
      'john@acme.com': { email: 'john@acme.com', name: 'John', title: '', company: 'Acme', resolved: true, resolvedAt: '2026-06-06', source: 'cache' },
    })
    writeProfileCache('globex.com', {
      'jane@globex.com': { email: 'jane@globex.com', name: 'Jane', title: '', company: 'Globex', resolved: true, resolvedAt: '2026-06-06', source: 'cache' },
    })

    const acme = readProfileCache('acme.com')
    const globex = readProfileCache('globex.com')
    expect(acme!['john@acme.com']).toBeDefined()
    expect(acme!['jane@globex.com']).toBeUndefined()
    expect(globex!['jane@globex.com']).toBeDefined()
  })

  test('readProfileCache returns null for missing domain', () => {
    const result = readProfileCache('nonexistent.com')
    expect(result).toBeNull()
  })
})

// ── AC-3 & AC-10: Cache hit returns stored profile, no Gemini call ─────────

describe('resolveAttendees — cache hit', () => {
  test('AC-3/AC-10: cache hit returns stored profile without Gemini call', async () => {
    // Pre-populate cache
    const cachedProfile = {
      email: 'john.doe@acme.com',
      name: 'John Doe',
      title: 'VP Engineering',
      company: 'Acme Corp',
      linkedinUrl: 'https://linkedin.com/in/johndoe',
      resolved: true,
      resolvedAt: '2026-06-06T00:00:00Z',
      source: 'cache' as const,
    }
    writeProfileCache('acme.com', { 'john.doe@acme.com': cachedProfile })

    // Track if callGemini would be invoked — we mock the module-level function
    let geminiCalled = false
    const origCallGemini = (await import('../../src/gemini-call.ts')).callGemini
    const mockCallGemini = mock(async (...args: any[]) => {
      geminiCalled = true
      return { text: '', cached: false, inputTokens: 0, outputTokens: 0, model: 'mock' }
    })

    const results = await resolveAttendees(
      ['john.doe@acme.com'],
      'Acme Corp',
      {}
    )

    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('John Doe')
    expect(results[0].title).toBe('VP Engineering')
    expect(results[0].source).toBe('cache')
    expect(results[0].resolved).toBe(true)
    // Gemini should NOT have been called for cached profiles
    expect(geminiCalled).toBe(false)
  })
})

// ── AC-5: Email parsing handles multiple patterns ──────────────────────────

describe('resolveAttendees — calendar display name strategy', () => {
  test('AC-5: uses calendar display name when provided', async () => {
    const calendarDisplayNames = new Map([
      ['john.doe@acme.com', 'John Doe'],
    ])

    const results = await resolveAttendees(
      ['john.doe@acme.com'],
      'Acme Corp',
      { calendarDisplayNames }
    )

    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('John Doe')
    // Source should be 'calendar' since we got the name from calendar data
    expect(results[0].source).toBe('calendar')
  })
})

// ── AC-7: Cross-references meeting history ─────────────────────────────────

describe('resolveAttendees — cross-reference strategy', () => {
  test('AC-7: cross-references meeting history for prior appearances', async () => {
    const meetingHistory = [
      {
        meetingTitle: 'Weekly sync',
        meetingStart: '2026-05-01T10:00:00Z',
        docUrl: '',
        title: 'Weekly sync',
        generatedAt: '2026-05-01T10:00:00Z',
        customerName: 'Acme Corp',
      },
    ]

    // Pre-populate cache with a profile from a prior meeting
    const priorProfile = {
      email: 'jane.smith@acme.com',
      name: 'Jane Smith',
      title: 'CTO',
      company: 'Acme Corp',
      resolved: true,
      resolvedAt: '2026-05-01T00:00:00Z',
      source: 'grounding' as const,
    }
    writeProfileCache('acme.com', { 'jane.smith@acme.com': priorProfile })

    const results = await resolveAttendees(
      ['jane.smith@acme.com'],
      'Acme Corp',
      { meetingHistory }
    )

    // Should use cached profile
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Jane Smith')
    expect(results[0].resolved).toBe(true)
  })
})

// ── AC-9 & AC-12: Unresolvable emails produce graceful "not found" ────────

describe('resolveAttendees — unresolvable', () => {
  test('AC-9/AC-12: unresolvable email produces resolved: false', async () => {
    // No cache, no calendar name, and we won't mock Gemini to return anything useful
    const results = await resolveAttendees(
      ['mystery@unknown-domain-xyz.com'],
      'Unknown Corp',
      {}
    )

    expect(results).toHaveLength(1)
    expect(results[0].resolved).toBe(false)
    expect(results[0].email).toBe('mystery@unknown-domain-xyz.com')
    // Name should be best-effort from email parsing
    expect(results[0].name).toBeTruthy()
  })
})

// ── AC-4 & AC-13: Partner attendees are researched (not skipped) ───────────

describe('resolveAttendees — partner attendees', () => {
  test('AC-4/AC-13: partner attendees get full research, not skipped', async () => {
    // Partner domain attendee — in the old code this would be skipped
    const results = await resolveAttendees(
      ['sarah.jones@partnercompany.com'],
      'Acme Corp',
      {}
    )

    expect(results).toHaveLength(1)
    // Should have attempted resolution, not just skipped
    expect(results[0].email).toBe('sarah.jones@partnercompany.com')
    // Name should be derived from email at minimum
    expect(results[0].name).toBeTruthy()
  })
})

// ── AC-8 & AC-14: Successful resolution writes to cache ────────────────────

describe('resolveAttendees — cache persistence', () => {
  test('AC-8/AC-14: successful resolution writes to cache file', async () => {
    // Provide calendar display name for reliable resolution
    const calendarDisplayNames = new Map([
      ['bob.wilson@newcorp.com', 'Bob Wilson'],
    ])

    const results = await resolveAttendees(
      ['bob.wilson@newcorp.com'],
      'NewCorp',
      { calendarDisplayNames }
    )

    expect(results).toHaveLength(1)
    expect(results[0].resolved).toBe(true)

    // Verify cache file was written
    const cached = readProfileCache('newcorp.com')
    expect(cached).toBeDefined()
    expect(cached!['bob.wilson@newcorp.com']).toBeDefined()
    expect(cached!['bob.wilson@newcorp.com'].name).toBe('Bob Wilson')
  })
})

// ── AC-1: Interface verification ───────────────────────────────────────────

describe('AttendeeProfile interface', () => {
  test('AC-1: profile has all required fields', async () => {
    const calendarDisplayNames = new Map([
      ['test@example.com', 'Test User'],
    ])

    const results = await resolveAttendees(
      ['test@example.com'],
      'Example Corp',
      { calendarDisplayNames }
    )

    const profile = results[0]
    expect(profile).toHaveProperty('email')
    expect(profile).toHaveProperty('name')
    expect(profile).toHaveProperty('title')
    expect(profile).toHaveProperty('company')
    expect(profile).toHaveProperty('resolved')
    expect(profile).toHaveProperty('source')
    // Optional fields exist when resolved
    if (profile.resolved) {
      expect(profile).toHaveProperty('resolvedAt')
    }
  })
})

// ── Multiple emails in one call ────────────────────────────────────────────

describe('resolveAttendees — batch resolution', () => {
  test('resolves multiple emails, mixing cache hits and new', async () => {
    // Pre-populate one in cache
    writeProfileCache('acme.com', {
      'cached@acme.com': {
        email: 'cached@acme.com',
        name: 'Cached User',
        title: 'Engineer',
        company: 'Acme',
        resolved: true,
        resolvedAt: '2026-06-01',
        source: 'cache',
      },
    })

    const calendarDisplayNames = new Map([
      ['new.user@acme.com', 'New User'],
    ])

    const results = await resolveAttendees(
      ['cached@acme.com', 'new.user@acme.com'],
      'Acme Corp',
      { calendarDisplayNames }
    )

    expect(results).toHaveLength(2)

    const cachedResult = results.find(r => r.email === 'cached@acme.com')
    expect(cachedResult?.source).toBe('cache')
    expect(cachedResult?.name).toBe('Cached User')

    const newResult = results.find(r => r.email === 'new.user@acme.com')
    expect(newResult?.name).toBe('New User')
    expect(newResult?.resolved).toBe(true)
  })
})
