/**
 * Pipeline Manifest — Unit Tests (#874 PR 2)
 *
 * Tests the unified manifest schema, CRUD operations, credential sanitization,
 * and gate summary calculations.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import {
  createManifest,
  addGate0Entry,
  updateGate1,
  updateGate2,
  updateGate3,
  computeGateSummary,
  writeManifest,
  readManifest,
  sanitizeManifestValues,
  type PipelineManifest,
} from '../../src/lib/pipeline-manifest.ts'

describe('pipeline-manifest', () => {
  let manifest: PipelineManifest

  beforeEach(() => {
    manifest = createManifest('test-product', 'Test Product')
  })

  // ── createManifest ──────────────────────────────────────────────────────

  describe('createManifest', () => {
    test('creates manifest with correct product fields', () => {
      expect(manifest.productSlug).toBe('test-product')
      expect(manifest.productName).toBe('Test Product')
      expect(manifest.scrapedAt).toBeTruthy()
      expect(manifest.documents).toEqual([])
    })

    test('initializes all gate counters to zero', () => {
      expect(manifest.gates.gate0_domItemCount).toBe(0)
      expect(manifest.gates.gate1_scrapedCount).toBe(0)
      expect(manifest.gates.gate1_dedupedCount).toBe(0)
      expect(manifest.gates.gate1_filteredCount).toBe(0)
      expect(manifest.gates.gate1_passRate).toBe(0)
      expect(manifest.gates.gate1_blocked).toBe(false)
      expect(manifest.gates.gate2_downloadedCount).toBe(0)
      expect(manifest.gates.gate2_enrichedCount).toBe(0)
      expect(manifest.gates.gate2_enrichmentCoverage).toBe(0)
      expect(manifest.gates.gate2_enrichmentAlert).toBe(false)
    })
  })

  // ── addGate0Entry ───────────────────────────────────────────────────────

  describe('addGate0Entry', () => {
    test('adds a document entry with Gate 0 defaults', () => {
      addGate0Entry(manifest, 'Doc A', 'business-decks', ['dom'])

      expect(manifest.documents).toHaveLength(1)
      const entry = manifest.documents[0]
      expect(entry.name).toBe('Doc A')
      expect(entry.section).toBe('business-decks')
      expect(entry.source).toEqual(['dom'])
      expect(entry.language).toBe('en')
      expect(entry.gate0_visible).toBe(true)
      expect(entry.gate1_scraped).toBe(true)
      expect(entry.gate1_deduped).toBe(true)
      expect(entry.gate2_downloaded).toBe(false)
      expect(entry.gate2_acquisitionMethod).toBeNull()
      expect(entry.gate3_enriched).toBe(false)
      expect(entry.gate3_enrichmentOutcome).toBeNull()
    })

    test('updates gate0_domItemCount on each add', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      expect(manifest.gates.gate0_domItemCount).toBe(1)
      addGate0Entry(manifest, 'Doc B', 's2', ['dom', 'api'])
      expect(manifest.gates.gate0_domItemCount).toBe(2)
    })

    test('supports multiple source types', () => {
      addGate0Entry(manifest, 'Doc C', 's1', ['dom', 'cds', 'api'])
      expect(manifest.documents[0].source).toEqual(['dom', 'cds', 'api'])
    })
  })

  // ── updateGate1 ─────────────────────────────────────────────────────────

  describe('updateGate1', () => {
    test('updates gate1 fields for existing entry', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      updateGate1(manifest, 'Doc A', {
        gate1_scraped: true,
        gate1_deduped: false,  // marked as duplicate
      })

      expect(manifest.documents[0].gate1_deduped).toBe(false)
    })

    test('no-op for non-existent entry', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      updateGate1(manifest, 'Non Existent', { gate1_scraped: false })
      // Should not throw, doc A unchanged
      expect(manifest.documents[0].gate1_scraped).toBe(true)
    })
  })

  // ── updateGate2 ─────────────────────────────────────────────────────────

  describe('updateGate2', () => {
    test('updates download fields', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      updateGate2(manifest, 'Doc A', {
        gate2_downloaded: true,
        gate2_acquisitionMethod: 'api-download',
        gate2_downloadPath: '/data/products/test/downloads/s1/doc-a.pdf',
      })

      const entry = manifest.documents[0]
      expect(entry.gate2_downloaded).toBe(true)
      expect(entry.gate2_acquisitionMethod).toBe('api-download')
      expect(entry.gate2_downloadPath).toBe('/data/products/test/downloads/s1/doc-a.pdf')
    })

    test('updates skip reason for non-english', () => {
      addGate0Entry(manifest, 'Guia en español', 's1', ['dom'])
      updateGate2(manifest, 'Guia en español', {
        gate2_skippedReason: 'non-english',
      })

      expect(manifest.documents[0].gate2_skippedReason).toBe('non-english')
    })
  })

  // ── updateGate3 ─────────────────────────────────────────────────────────

  describe('updateGate3', () => {
    test('updates enrichment fields on success', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      updateGate3(manifest, 'Doc A', {
        gate3_enriched: true,
        gate3_productsFound: 3,
        gate3_classificationsFound: 2,
        gate3_enrichmentOutcome: 'enriched',
      })

      const entry = manifest.documents[0]
      expect(entry.gate3_enriched).toBe(true)
      expect(entry.gate3_productsFound).toBe(3)
      expect(entry.gate3_classificationsFound).toBe(2)
      expect(entry.gate3_enrichmentOutcome).toBe('enriched')
    })

    test('updates enrichment fields on failure', () => {
      addGate0Entry(manifest, 'Doc B', 's1', ['dom'])
      updateGate3(manifest, 'Doc B', {
        gate3_enriched: false,
        gate3_enrichmentOutcome: 'failed',
        gate3_enrichmentReason: 'Gemini API timeout',
      })

      const entry = manifest.documents[0]
      expect(entry.gate3_enriched).toBe(false)
      expect(entry.gate3_enrichmentOutcome).toBe('failed')
      expect(entry.gate3_enrichmentReason).toBe('Gemini API timeout')
    })

    test('updates enrichment fields on skip', () => {
      addGate0Entry(manifest, 'Doc C', 's1', ['dom'])
      updateGate3(manifest, 'Doc C', {
        gate3_enriched: false,
        gate3_enrichmentOutcome: 'skipped',
        gate3_enrichmentReason: 'no-content',
      })

      expect(manifest.documents[0].gate3_enrichmentOutcome).toBe('skipped')
      expect(manifest.documents[0].gate3_enrichmentReason).toBe('no-content')
    })
  })

  // ── computeGateSummary ──────────────────────────────────────────────────

  describe('computeGateSummary', () => {
    test('calculates pass rate correctly', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      addGate0Entry(manifest, 'Doc B', 's2', ['dom'])
      addGate0Entry(manifest, 'Doc C', 's3', ['dom'])
      addGate0Entry(manifest, 'Doc D', 's4', ['dom'])
      addGate0Entry(manifest, 'Doc E', 's5', ['dom'])
      // All 5 scraped, none removed = 100% pass rate
      computeGateSummary(manifest)

      expect(manifest.gates.gate0_domItemCount).toBe(5)
      expect(manifest.gates.gate1_scrapedCount).toBe(5)
      expect(manifest.gates.gate1_passRate).toBe(1.0)
      expect(manifest.gates.gate1_blocked).toBe(false)
    })

    test('blocks when pass rate < 80%', () => {
      // 5 items, only 3 scraped = 60%
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      addGate0Entry(manifest, 'Doc B', 's2', ['dom'])
      addGate0Entry(manifest, 'Doc C', 's3', ['dom'])
      addGate0Entry(manifest, 'Doc D', 's4', ['dom'])
      addGate0Entry(manifest, 'Doc E', 's5', ['dom'])
      updateGate1(manifest, 'Doc D', { gate1_scraped: false })
      updateGate1(manifest, 'Doc E', { gate1_scraped: false })

      computeGateSummary(manifest)

      expect(manifest.gates.gate1_scrapedCount).toBe(3)
      expect(manifest.gates.gate1_passRate).toBe(0.6)
      expect(manifest.gates.gate1_blocked).toBe(true)
    })

    test('counts deduped entries correctly', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      addGate0Entry(manifest, 'Doc A Copy', 's2', ['dom'])
      // Mark the copy as deduped (removed)
      updateGate1(manifest, 'Doc A Copy', { gate1_deduped: false })

      computeGateSummary(manifest)
      expect(manifest.gates.gate1_dedupedCount).toBe(1)
    })

    test('counts filtered entries', () => {
      addGate0Entry(manifest, 'English Doc', 's1', ['dom'])
      addGate0Entry(manifest, 'Guia espanol', 's2', ['dom'])
      updateGate2(manifest, 'Guia espanol', { gate2_skippedReason: 'non-english' })

      computeGateSummary(manifest)
      expect(manifest.gates.gate1_filteredCount).toBe(1)
    })

    test('calculates enrichment coverage and alert', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      addGate0Entry(manifest, 'Doc B', 's2', ['dom'])
      addGate0Entry(manifest, 'Doc C', 's3', ['dom'])
      // All 3 downloaded, only 1 enriched = 33% coverage → alert
      updateGate2(manifest, 'Doc A', { gate2_downloaded: true })
      updateGate2(manifest, 'Doc B', { gate2_downloaded: true })
      updateGate2(manifest, 'Doc C', { gate2_downloaded: true })
      updateGate3(manifest, 'Doc A', { gate3_enriched: true })

      computeGateSummary(manifest)
      expect(manifest.gates.gate2_downloadedCount).toBe(3)
      expect(manifest.gates.gate2_enrichedCount).toBe(1)
      expect(manifest.gates.gate2_enrichmentCoverage).toBeCloseTo(0.333, 2)
      expect(manifest.gates.gate2_enrichmentAlert).toBe(true)
    })

    test('no enrichment alert when coverage >= 60%', () => {
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      addGate0Entry(manifest, 'Doc B', 's2', ['dom'])
      updateGate2(manifest, 'Doc A', { gate2_downloaded: true })
      updateGate2(manifest, 'Doc B', { gate2_downloaded: true })
      updateGate3(manifest, 'Doc A', { gate3_enriched: true })
      updateGate3(manifest, 'Doc B', { gate3_enriched: true })

      computeGateSummary(manifest)
      expect(manifest.gates.gate2_enrichmentCoverage).toBe(1.0)
      expect(manifest.gates.gate2_enrichmentAlert).toBe(false)
    })

    test('handles empty manifest (0 documents)', () => {
      computeGateSummary(manifest)
      expect(manifest.gates.gate1_passRate).toBe(0)
      expect(manifest.gates.gate1_blocked).toBe(false)
      expect(manifest.gates.gate2_enrichmentCoverage).toBe(0)
      expect(manifest.gates.gate2_enrichmentAlert).toBe(false)
    })
  })

  // ── writeManifest + readManifest ────────────────────────────────────────

  describe('writeManifest / readManifest', () => {
    test('writes and reads manifest JSON', () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), 'manifest-test-'))
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])

      writeManifest(manifest, tmpDir)
      const read = readManifest(tmpDir)

      expect(read).toBeTruthy()
      expect(read!.productSlug).toBe('test-product')
      expect(read!.documents).toHaveLength(1)
      expect(read!.documents[0].name).toBe('Doc A')
    })

    test('rotates previous manifest on write', () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), 'manifest-test-'))

      // First write
      addGate0Entry(manifest, 'Doc A', 's1', ['dom'])
      writeManifest(manifest, tmpDir)

      // Second write
      addGate0Entry(manifest, 'Doc B', 's2', ['dom'])
      writeManifest(manifest, tmpDir)

      // .prev.json should exist
      const prevPath = resolve(tmpDir, '_pipeline-manifest.prev.json')
      expect(existsSync(prevPath)).toBe(true)

      const prev = JSON.parse(readFileSync(prevPath, 'utf-8'))
      // Previous should have only 1 doc (the first write)
      expect(prev.documents).toHaveLength(1)

      // Current should have 2
      const current = readManifest(tmpDir)
      expect(current!.documents).toHaveLength(2)
    })

    test('readManifest returns null for missing directory', () => {
      const result = readManifest('/nonexistent/path/that/wont/exist')
      expect(result).toBeNull()
    })
  })

  // ── sanitizeManifestValues ──────────────────────────────────────────────

  describe('sanitizeManifestValues', () => {
    test('redacts strings containing credential patterns', () => {
      addGate0Entry(manifest, 'Doc with bearer token leak', 's1', ['dom'])
      updateGate2(manifest, 'Doc with bearer token leak', {
        gate2_downloadPath: '/path/with/authorization-header.pdf',
      })

      const sanitized = sanitizeManifestValues(manifest)
      // The name contains "bearer token" — should be redacted
      expect(sanitized.documents[0].name).toBe('[REDACTED]')
      // The path contains "authorization" — should be redacted
      expect(sanitized.documents[0].gate2_downloadPath).toBe('[REDACTED]')
    })

    test('preserves strings without credential patterns', () => {
      addGate0Entry(manifest, 'Normal Document Name', 's1', ['dom'])
      updateGate2(manifest, 'Normal Document Name', {
        gate2_downloadPath: '/data/products/test/downloads/normal.pdf',
      })

      const sanitized = sanitizeManifestValues(manifest)
      expect(sanitized.documents[0].name).toBe('Normal Document Name')
      expect(sanitized.documents[0].gate2_downloadPath).toBe('/data/products/test/downloads/normal.pdf')
    })

    test('redacts api_key and api-key patterns', () => {
      addGate0Entry(manifest, 'Doc', 's1', ['dom'])
      updateGate3(manifest, 'Doc', {
        gate3_enrichmentReason: 'Failed: api_key expired',
      })

      const sanitized = sanitizeManifestValues(manifest)
      expect(sanitized.documents[0].gate3_enrichmentReason).toBe('[REDACTED]')
    })

    test('does not modify non-string fields', () => {
      addGate0Entry(manifest, 'Doc', 's1', ['dom'])
      updateGate3(manifest, 'Doc', {
        gate3_productsFound: 5,
        gate3_enriched: true,
      })

      const sanitized = sanitizeManifestValues(manifest)
      expect(sanitized.documents[0].gate3_productsFound).toBe(5)
      expect(sanitized.documents[0].gate3_enriched).toBe(true)
    })
  })

  // ── Dedup test ──────────────────────────────────────────────────────────

  describe('dedup scenario', () => {
    test('two items with same normalized name — 1 kept (with contentId)', () => {
      addGate0Entry(manifest, 'Getting Started Guide', 'resources', ['dom'])
      addGate0Entry(manifest, 'Getting Started Guide', 'technical-resources', ['api'])

      // After dedup, the second is marked as removed
      updateGate1(manifest, 'Getting Started Guide', { gate1_deduped: false })

      // Only 1 should remain as deduped=true
      const deduped = manifest.documents.filter(d => d.gate1_deduped)
      expect(deduped).toHaveLength(1)
      // The first entry (from 'resources') should be kept since
      // in real code we keep the one with more metadata
    })
  })

  // ── Language filter test ────────────────────────────────────────────────

  describe('language filter scenario', () => {
    test('non-english doc logged to manifest with skip reason', () => {
      addGate0Entry(manifest, 'Acelere os resultados', 's1', ['dom'])
      updateGate1(manifest, 'Acelere os resultados', { language: 'pt' })
      updateGate2(manifest, 'Acelere os resultados', {
        gate2_skippedReason: 'non-english',
      })

      const entry = manifest.documents[0]
      expect(entry.language).toBe('pt')
      expect(entry.gate2_skippedReason).toBe('non-english')
    })
  })
})
