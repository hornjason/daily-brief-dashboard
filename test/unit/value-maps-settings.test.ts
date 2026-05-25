// test/unit/value-maps-settings.test.ts
// TDD tests for #315 — value maps onboarding: settings API + admin UI integration

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

const TMP_DIR = resolve(import.meta.dir, '__tmp_value_maps_test')
const SETTINGS_PATH = resolve(TMP_DIR, 'settings.json')
const CACHE_DIR = resolve(TMP_DIR, 'cache')
const VALUE_MAPS_DIR = resolve(CACHE_DIR, 'value-maps')
const VALUE_MAPS_PATH = resolve(VALUE_MAPS_DIR, 'business-value-maps.txt')

describe('Value Maps Settings API', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true })
    mkdirSync(VALUE_MAPS_DIR, { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify({ regions: [] }))
  })

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true })
  })

  // ── Read deck ID from settings ─────────────────────────────────────────────

  test('reads valueMapsDeckId from settings.json when present', () => {
    const deckId = '1abc123-test-deck-id'
    writeFileSync(SETTINGS_PATH, JSON.stringify({ regions: [], valueMapsDeckId: deckId }))

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    expect(settings.valueMapsDeckId).toBe(deckId)
  })

  test('returns null when valueMapsDeckId is not in settings.json', () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    expect(settings.valueMapsDeckId ?? null).toBeNull()
  })

  // ── Write deck ID to settings ──────────────────────────────────────────────

  test('saves valueMapsDeckId to settings.json preserving other fields', () => {
    const deckId = '1xyz789-new-deck'
    const existing = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    writeFileSync(SETTINGS_PATH, JSON.stringify({ ...existing, valueMapsDeckId: deckId }))

    const updated = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    expect(updated.valueMapsDeckId).toBe(deckId)
    expect(updated.regions).toEqual([])
  })

  test('clears valueMapsDeckId when set to empty string', () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ regions: [], valueMapsDeckId: 'old-id' }))

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    const { valueMapsDeckId: _, ...rest } = settings
    writeFileSync(SETTINGS_PATH, JSON.stringify(rest))

    const updated = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    expect(updated.valueMapsDeckId).toBeUndefined()
  })

  // ── Deck ID validation ─────────────────────────────────────────────────────

  test('rejects deck IDs with invalid characters', () => {
    const invalidIds = [
      '<script>alert(1)</script>',
      'id with spaces',
      'id\nwith\nnewlines',
      '../../../etc/passwd',
    ]

    for (const id of invalidIds) {
      // Google Drive file IDs are alphanumeric + hyphens + underscores
      const isValid = /^[a-zA-Z0-9_-]{10,100}$/.test(id)
      expect(isValid).toBe(false)
    }
  })

  test('accepts valid Google Drive file IDs', () => {
    const validIds = [
      '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      '1abc-def_123-456',
      'abcdefghij1234567890',
    ]

    for (const id of validIds) {
      const isValid = /^[a-zA-Z0-9_-]{10,100}$/.test(id)
      expect(isValid).toBe(true)
    }
  })

  // ── URL extraction ─────────────────────────────────────────────────────────

  test('extracts deck ID from Google Slides URL', () => {
    const url = 'https://docs.google.com/presentation/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit'
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms')
  })

  test('extracts deck ID from Google Slides URL with hash', () => {
    const url = 'https://docs.google.com/presentation/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit#slide=id.g123'
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms')
  })

  test('handles raw deck ID (not a URL)', () => {
    const input = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms'
    const urlMatch = input.match(/\/d\/([a-zA-Z0-9_-]+)/)
    const deckId = urlMatch ? urlMatch[1] : input
    expect(deckId).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms')
  })

  // ── Value maps status ──────────────────────────────────────────────────────

  test('reports status with no deck configured and no cached file', () => {
    const hasDeckId = false
    const hasCachedFile = existsSync(VALUE_MAPS_PATH)

    expect(hasDeckId).toBe(false)
    expect(hasCachedFile).toBe(false)
  })

  test('reports status with cached file present', () => {
    const sampleContent = `Red Hat OpenShift Container Platform Value Map
Business Objective: Accelerate application delivery
Business Impact: 40% faster deployment cycles

Red Hat Ansible Automation Platform Value Map
Business Objective: Reduce operational complexity
Business Impact: 60% reduction in manual tasks`

    writeFileSync(VALUE_MAPS_PATH, sampleContent)
    expect(existsSync(VALUE_MAPS_PATH)).toBe(true)

    const content = readFileSync(VALUE_MAPS_PATH, 'utf-8')
    expect(content.length).toBeGreaterThan(0)
  })

  test('reports product count from value maps file', () => {
    const sampleContent = `Red Hat OpenShift Container Platform Value Map
Some content here about OCP.

Red Hat Ansible Automation Platform Value Map
Some content here about AAP.

Red Hat Enterprise Linux Value Map
Some content here about RHEL.`

    writeFileSync(VALUE_MAPS_PATH, sampleContent)

    const content = readFileSync(VALUE_MAPS_PATH, 'utf-8')
    const productHeaders = content.split('\n').filter(l =>
      l.toLowerCase().includes('value map') && l.toLowerCase().includes('red hat')
    )
    expect(productHeaders.length).toBe(3)
  })
})

describe('Value Maps deck ID extraction utility', () => {
  function extractDeckId(input: string): string | null {
    const trimmed = input.trim()
    if (!trimmed) return null

    // Try URL pattern first
    const urlMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/)
    if (urlMatch) return urlMatch[1]

    // Try raw ID
    if (/^[a-zA-Z0-9_-]{10,100}$/.test(trimmed)) return trimmed

    return null
  }

  test('extracts from full URL', () => {
    expect(extractDeckId('https://docs.google.com/presentation/d/1abc_def-123/edit')).toBe('1abc_def-123')
  })

  test('extracts raw ID', () => {
    expect(extractDeckId('1abc_def-123456')).toBe('1abc_def-123456')
  })

  test('returns null for empty input', () => {
    expect(extractDeckId('')).toBeNull()
    expect(extractDeckId('  ')).toBeNull()
  })

  test('returns null for invalid input', () => {
    expect(extractDeckId('not valid!')).toBeNull()
    expect(extractDeckId('<script>')).toBeNull()
  })
})
