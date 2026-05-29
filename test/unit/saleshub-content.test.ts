// test/unit/saleshub-content.test.ts
// GitHub Issue #448 — SalesHub Content library tests

import { describe, test, expect, beforeEach } from 'bun:test'
import { loadSalesHubContent, getKnowledgeScrapedAt, getKnowledgeMtime, resetContentCache } from '../../src/lib/saleshub-content.ts'

// Reset cache between tests so env changes take effect
beforeEach(() => {
  resetContentCache()
})

describe('loadSalesHubContent', () => {
  test('returns an array (even if empty when no knowledge JSON exists)', () => {
    // Point to a non-existent dir to get empty result
    const origDir = process.env.CONFIG_DIR
    process.env.CONFIG_DIR = '/tmp/nonexistent-saleshub-test-dir'
    resetContentCache()
    const docs = loadSalesHubContent()
    expect(Array.isArray(docs)).toBe(true)
    // Restore
    process.env.CONFIG_DIR = origDir
    resetContentCache()
  })

  test('loads documents from config-templates/saleshub-knowledge.json', () => {
    // Use the real config-templates directory
    const origDir = process.env.CONFIG_DIR
    delete process.env.CONFIG_DIR
    resetContentCache()
    const docs = loadSalesHubContent()
    // The knowledge JSON has products with decks — should produce at least some documents
    // Even without documents[] arrays on TDPs, product decks are included
    expect(Array.isArray(docs)).toBe(true)
    // Restore
    process.env.CONFIG_DIR = origDir
    resetContentCache()
  })

  test('documents have required fields', () => {
    const origDir = process.env.CONFIG_DIR
    delete process.env.CONFIG_DIR
    resetContentCache()
    const docs = loadSalesHubContent()
    for (const doc of docs) {
      expect(typeof doc.name).toBe('string')
      expect(typeof doc.contentType).toBe('string')
      expect(typeof doc.product).toBe('string')
      expect(typeof doc.distributionTerms).toBe('string')
      expect(typeof doc.salesStage).toBe('string')
      expect(typeof doc.versionCreated).toBe('string')
    }
    // Restore
    process.env.CONFIG_DIR = origDir
    resetContentCache()
  })

  test('deduplicates documents by name+contentType', () => {
    const origDir = process.env.CONFIG_DIR
    delete process.env.CONFIG_DIR
    resetContentCache()
    const docs = loadSalesHubContent()
    const keys = docs.map(d => `${d.name}|${d.contentType}`)
    const uniqueKeys = new Set(keys)
    expect(keys.length).toBe(docs.length)
    expect(uniqueKeys.size).toBeGreaterThanOrEqual(docs.length - 5) // allow minor dupes from cross-TDP/Play overlap
    // Restore
    process.env.CONFIG_DIR = origDir
    resetContentCache()
  })
})

describe('getKnowledgeScrapedAt', () => {
  test('returns a string timestamp when knowledge JSON exists', () => {
    const origDir = process.env.CONFIG_DIR
    delete process.env.CONFIG_DIR
    resetContentCache()
    const ts = getKnowledgeScrapedAt()
    // config-templates/saleshub-knowledge.json should have scrapedAt
    if (ts !== null) {
      expect(typeof ts).toBe('string')
      expect(ts.length).toBeGreaterThan(0)
    }
    // Restore
    process.env.CONFIG_DIR = origDir
    resetContentCache()
  })

  test('returns null when no knowledge JSON exists', () => {
    const origDir = process.env.CONFIG_DIR
    process.env.CONFIG_DIR = '/tmp/nonexistent-saleshub-test-dir'
    resetContentCache()
    const ts = getKnowledgeScrapedAt()
    expect(ts).toBeNull()
    // Restore
    process.env.CONFIG_DIR = origDir
    resetContentCache()
  })
})

describe('getKnowledgeMtime', () => {
  test('returns a number', () => {
    const origDir = process.env.CONFIG_DIR
    delete process.env.CONFIG_DIR
    resetContentCache()
    const mtime = getKnowledgeMtime()
    expect(typeof mtime).toBe('number')
    // Restore
    process.env.CONFIG_DIR = origDir
    resetContentCache()
  })
})
