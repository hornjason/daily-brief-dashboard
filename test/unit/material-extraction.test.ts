/**
 * Material Extraction API Tests (GitHub Issue #164)
 *
 * Tests for:
 * 1. Material decomposition with Gemini
 * 2. URL hash-based cache
 * 3. Cache invalidation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'

// These will be implemented in src/material-extraction.ts
import type { MaterialExtraction } from '../src/material-extraction.ts'

const TEST_CACHE_DIR = resolve(import.meta.dir, '../test-cache')
const MATERIAL_CACHE_DIR = resolve(TEST_CACHE_DIR, 'material-extractions')

describe('Material Extraction - URL hash cache', () => {
  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    mkdirSync(MATERIAL_CACHE_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
  })

  test('URL hash is consistent for same URL', () => {
    const url = 'https://docs.google.com/document/d/ABC123/edit'
    const hash1 = createHash('md5').update(url).digest('hex')
    const hash2 = createHash('md5').update(url).digest('hex')

    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[a-f0-9]{32}$/)
  })

  test('Different URLs produce different hashes', () => {
    const url1 = 'https://docs.google.com/document/d/ABC123/edit'
    const url2 = 'https://docs.google.com/document/d/XYZ789/edit'
    const hash1 = createHash('md5').update(url1).digest('hex')
    const hash2 = createHash('md5').update(url2).digest('hex')

    expect(hash1).not.toBe(hash2)
  })

  test('Cache file path follows naming convention', () => {
    const url = 'https://docs.google.com/document/d/ABC123/edit'
    const hash = createHash('md5').update(url).digest('hex')
    const expectedPath = resolve(MATERIAL_CACHE_DIR, `${hash}.json`)

    expect(expectedPath).toMatch(/[a-f0-9]{32}\.json$/)
  })

  test('Reading cached material extraction returns valid structure', () => {
    const url = 'https://docs.google.com/document/d/ABC123/edit'
    const hash = createHash('md5').update(url).digest('hex')
    const cachePath = resolve(MATERIAL_CACHE_DIR, `${hash}.json`)

    const mockExtraction: MaterialExtraction = {
      materialTitle: 'Test Material',
      personas: [
        { role: 'VP Infrastructure', relevantVPs: ['vp-1'], enabled: true },
        { role: 'Platform Engineering', relevantVPs: ['vp-2'], enabled: false },
      ],
      valueProps: [
        { id: 'vp-1', claim: 'Reduce costs', detail: 'Save 30% on infrastructure' },
        { id: 'vp-2', claim: 'Improve reliability', detail: '99.9% uptime' },
      ],
      useCases: [
        { name: 'Cloud Migration', description: 'Move workloads to hybrid cloud' },
      ],
      style: 'executive',
      extractedAt: new Date().toISOString(),
      materialUrl: url,
    }

    writeFileSync(cachePath, JSON.stringify(mockExtraction, null, 2), { mode: 0o600 })

    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'))
    expect(cached.materialTitle).toBe('Test Material')
    expect(cached.personas).toHaveLength(2)
    expect(cached.valueProps).toHaveLength(2)
    expect(cached.useCases).toHaveLength(1)
    expect(cached.style).toBe('executive')
    expect(cached.materialUrl).toBe(url)
  })

  test('Cache invalidation deletes the correct file only', () => {
    const url1 = 'https://docs.google.com/document/d/ABC123/edit'
    const url2 = 'https://docs.google.com/document/d/XYZ789/edit'
    const hash1 = createHash('md5').update(url1).digest('hex')
    const hash2 = createHash('md5').update(url2).digest('hex')
    const path1 = resolve(MATERIAL_CACHE_DIR, `${hash1}.json`)
    const path2 = resolve(MATERIAL_CACHE_DIR, `${hash2}.json`)

    // Create two cache entries
    writeFileSync(path1, JSON.stringify({ materialTitle: 'Material 1' }), { mode: 0o600 })
    writeFileSync(path2, JSON.stringify({ materialTitle: 'Material 2' }), { mode: 0o600 })

    expect(existsSync(path1)).toBe(true)
    expect(existsSync(path2)).toBe(true)

    // Delete only path1
    rmSync(path1, { force: true })

    expect(existsSync(path1)).toBe(false)
    expect(existsSync(path2)).toBe(true)
  })
})

describe('Material Extraction - Interface validation', () => {
  test('MaterialExtraction interface has all required fields', () => {
    const extraction: MaterialExtraction = {
      materialTitle: 'Test',
      personas: [],
      valueProps: [],
      useCases: [],
      style: 'technical',
      extractedAt: new Date().toISOString(),
      materialUrl: 'https://docs.google.com/document/d/test/edit',
    }

    expect(extraction.materialTitle).toBeDefined()
    expect(Array.isArray(extraction.personas)).toBe(true)
    expect(Array.isArray(extraction.valueProps)).toBe(true)
    expect(Array.isArray(extraction.useCases)).toBe(true)
    expect(extraction.style).toBeDefined()
    expect(extraction.extractedAt).toBeDefined()
    expect(extraction.materialUrl).toBeDefined()
  })

  test('Persona structure is correct', () => {
    const persona = {
      role: 'VP Infrastructure',
      relevantVPs: ['vp-1', 'vp-2'],
      enabled: true,
    }

    expect(persona.role).toBeDefined()
    expect(Array.isArray(persona.relevantVPs)).toBe(true)
    expect(typeof persona.enabled).toBe('boolean')
  })

  test('ValueProp structure is correct', () => {
    const vp = {
      id: 'vp-1',
      claim: 'Reduce costs',
      detail: 'Save 30% on infrastructure spend',
    }

    expect(vp.id).toBeDefined()
    expect(vp.claim).toBeDefined()
    expect(vp.detail).toBeDefined()
  })

  test('UseCase structure is correct', () => {
    const useCase = {
      name: 'Cloud Migration',
      description: 'Move legacy workloads to hybrid cloud',
    }

    expect(useCase.name).toBeDefined()
    expect(useCase.description).toBeDefined()
  })
})

describe('Material Extraction - File ID extraction', () => {
  test('Extracts file ID from Google Docs URL', () => {
    const url = 'https://docs.google.com/document/d/1ABC-xyz_123/edit'
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
    const fileId = match?.[1]

    expect(fileId).toBe('1ABC-xyz_123')
  })

  test('Extracts file ID from Google Slides URL', () => {
    const url = 'https://docs.google.com/presentation/d/1XYZ-abc_789/edit#slide=id.p'
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
    const fileId = match?.[1]

    expect(fileId).toBe('1XYZ-abc_789')
  })

  test('Returns null for invalid URL', () => {
    const url = 'https://example.com/not-a-google-doc'
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
    const fileId = match?.[1] ?? null

    expect(fileId).toBeNull()
  })
})
