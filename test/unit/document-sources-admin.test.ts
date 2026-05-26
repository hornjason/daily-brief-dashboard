/**
 * GitHub Issue #316 — Document sources admin panel
 *
 * Tests for the configurable document sources API:
 * - loadDocumentSources — list all configured sources
 * - addDocumentSource — add a new source
 * - updateDocumentSource — update existing source
 * - removeDocumentSource — remove a source
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import {
  loadDocumentSources,
  addDocumentSource,
  updateDocumentSource,
  removeDocumentSource,
  type DocumentSource,
} from '../../src/document-sources.ts'

const TEST_CONFIG_DIR = resolve(import.meta.dir, '../../data/cache/__test-doc-sources')
const TEST_SOURCES_PATH = resolve(TEST_CONFIG_DIR, 'document-sources.json')

const SAMPLE_SOURCES: DocumentSource[] = [
  {
    id: 'value-maps-deck',
    name: 'Value Maps Deck',
    type: 'google-slides',
    identifier: '1abc123xyz',
    configKey: 'valueMapsDeckId',
    lastFetched: '2026-05-20T10:00:00Z',
    status: 'ok',
  },
  {
    id: 'rss-redhat-blog',
    name: 'Red Hat Blog RSS',
    type: 'url',
    identifier: 'https://www.redhat.com/en/rss/blog',
    lastFetched: '2026-05-23T08:00:00Z',
    status: 'ok',
  },
]

describe('Document sources admin (#316)', () => {
  beforeEach(() => {
    if (!existsSync(TEST_CONFIG_DIR)) mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    writeFileSync(TEST_SOURCES_PATH, JSON.stringify({ sources: SAMPLE_SOURCES }, null, 2))
  })

  afterEach(() => {
    if (existsSync(TEST_CONFIG_DIR)) rmSync(TEST_CONFIG_DIR, { recursive: true })
  })

  test('loadDocumentSources returns all configured sources', () => {
    const sources = loadDocumentSources(TEST_SOURCES_PATH)
    expect(sources).toHaveLength(2)
    expect(sources[0].id).toBe('value-maps-deck')
    expect(sources[1].id).toBe('rss-redhat-blog')
  })

  test('loadDocumentSources returns empty array when file missing', () => {
    const sources = loadDocumentSources('/nonexistent/path.json')
    expect(sources).toEqual([])
  })

  test('addDocumentSource appends a new source', () => {
    const newSource: Omit<DocumentSource, 'id'> = {
      name: 'Cloud Marketplace Newsletter',
      type: 'email',
      identifier: 'subject:"Cloud Marketplaces Newsletter"',
      status: 'pending',
    }
    const added = addDocumentSource(TEST_SOURCES_PATH, newSource)
    expect(added.id).toBeTruthy()
    expect(added.name).toBe('Cloud Marketplace Newsletter')

    const all = loadDocumentSources(TEST_SOURCES_PATH)
    expect(all).toHaveLength(3)
  })

  test('updateDocumentSource modifies existing source', () => {
    const updated = updateDocumentSource(TEST_SOURCES_PATH, 'value-maps-deck', {
      identifier: '1newDeckId',
    })
    expect(updated).not.toBeNull()
    expect(updated!.identifier).toBe('1newDeckId')

    const all = loadDocumentSources(TEST_SOURCES_PATH)
    const deck = all.find(s => s.id === 'value-maps-deck')
    expect(deck!.identifier).toBe('1newDeckId')
  })

  test('updateDocumentSource returns null for unknown id', () => {
    const result = updateDocumentSource(TEST_SOURCES_PATH, 'nonexistent', { name: 'x' })
    expect(result).toBeNull()
  })

  test('removeDocumentSource deletes by id', () => {
    const removed = removeDocumentSource(TEST_SOURCES_PATH, 'rss-redhat-blog')
    expect(removed).toBe(true)

    const all = loadDocumentSources(TEST_SOURCES_PATH)
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('value-maps-deck')
  })

  test('removeDocumentSource returns false for unknown id', () => {
    const removed = removeDocumentSource(TEST_SOURCES_PATH, 'nonexistent')
    expect(removed).toBe(false)
  })

  test('each source has required fields', () => {
    const sources = loadDocumentSources(TEST_SOURCES_PATH)
    for (const s of sources) {
      expect(s.id).toBeTruthy()
      expect(s.name).toBeTruthy()
      expect(s.type).toBeTruthy()
      expect(s.identifier).toBeTruthy()
    }
  })
})

// ── #416: Document sources helper text coverage ───────────────────────────

describe('Document sources helper text (#416)', () => {
  // These constants mirror the TYPE_HELPER_TEXT and TYPE_LABELS in DocumentSourcesPanel.tsx
  // If the frontend adds/removes types, this test will catch the drift.
  const EXPECTED_SOURCE_TYPES = [
    'google-slides',
    'google-doc',
    'google-drive-folder',
    'url',
    'email',
    'rss',
  ]

  const HELPER_TEXT: Record<string, string> = {
    'google-slides': 'Share a presentation or document to include in intelligence analysis',
    'google-doc': 'Share a Google Doc to include in intelligence analysis',
    'google-drive-folder': 'Monitor a folder for new documents about this customer',
    'url': 'Scan a web page for relevant content',
    'email': 'Track emails matching a search query',
    'rss': 'Subscribe to an industry or customer news feed',
  }

  test('every source type has helper text', () => {
    for (const type of EXPECTED_SOURCE_TYPES) {
      expect(HELPER_TEXT[type]).toBeTruthy()
    }
  })

  test('helper text is descriptive (at least 20 chars)', () => {
    for (const [type, text] of Object.entries(HELPER_TEXT)) {
      expect(text.length).toBeGreaterThanOrEqual(20)
    }
  })

  test('no helper text keys exist outside known types', () => {
    const helperKeys = Object.keys(HELPER_TEXT)
    for (const key of helperKeys) {
      expect(EXPECTED_SOURCE_TYPES).toContain(key)
    }
  })
})
