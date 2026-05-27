// test/unit/ecosystem-catalog.test.ts
// GitHub Issue #438 — Ecosystem Catalog library tests
// TDD: Tests for cache loading and fail-open behavior

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'
import {
  loadEcosystemPartner,
  loadAllEcosystemPartners,
  getEcosystemCacheDir,
  type EcosystemPartnerCache,
  type EcosystemSolution,
} from '../../src/lib/ecosystem-catalog.ts'

// ── Test Data ─────────────────────────────────────────────────────────────────

const VALID_SOLUTION: EcosystemSolution = {
  name: 'Test Solution',
  partnerName: 'TestPartner',
  partnerSlug: 'testpartner',
  description: 'A test joint solution',
  platform: 'Ansible Automation Platform',
  categories: ['Automation', 'Networking'],
  geoRegion: 'Global',
  url: 'https://catalog.redhat.com/en/solutions/detail/test-uuid',
  coSell: true,
  resources: [
    { title: 'Test Lab', url: 'https://example.com/lab', type: 'lab' },
    { title: 'Test Brief', url: 'https://example.com/brief', type: 'solution-brief' },
  ],
  collections: [
    { name: 'testpartner.network', namespace: 'testpartner', category: 'Networking' },
  ],
  publishedAt: '2026-01-01T00:00:00.000Z',
}

const VALID_CACHE: EcosystemPartnerCache = {
  partnerName: 'TestPartner',
  partnerSlug: 'testpartner',
  solutions: [VALID_SOLUTION],
  scrapedAt: '2026-05-15T00:00:00.000Z',
  solutionCount: 1,
}

const TEST_DIR = '/tmp/ecosystem-catalog-test-' + Date.now()

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

// ── loadEcosystemPartner ──────────────────────────────────────────────────────

describe('loadEcosystemPartner', () => {
  test('loads valid JSON and returns typed data', () => {
    const filePath = resolve(TEST_DIR, 'testpartner.json')
    writeFileSync(filePath, JSON.stringify(VALID_CACHE))

    const result = loadEcosystemPartner(filePath)
    expect(result).not.toBeNull()
    expect(result!.partnerName).toBe('TestPartner')
    expect(result!.partnerSlug).toBe('testpartner')
    expect(result!.solutions).toHaveLength(1)
    expect(result!.solutions[0].name).toBe('Test Solution')
    expect(result!.solutions[0].coSell).toBe(true)
    expect(result!.solutions[0].resources).toHaveLength(2)
    expect(result!.solutions[0].collections).toHaveLength(1)
    expect(result!.solutions[0].collections[0].name).toBe('testpartner.network')
  })

  test('returns null for missing file', () => {
    const result = loadEcosystemPartner('/nonexistent/path/partner.json')
    expect(result).toBeNull()
  })

  test('returns null for invalid JSON', () => {
    const filePath = resolve(TEST_DIR, 'bad.json')
    writeFileSync(filePath, 'this is not valid json {{{')

    const result = loadEcosystemPartner(filePath)
    expect(result).toBeNull()
  })

  test('returns null for JSON missing required fields', () => {
    const filePath = resolve(TEST_DIR, 'incomplete.json')
    writeFileSync(filePath, JSON.stringify({ someField: 'value' }))

    const result = loadEcosystemPartner(filePath)
    expect(result).toBeNull()
  })

  test('returns data with all EcosystemSolution fields', () => {
    const filePath = resolve(TEST_DIR, 'full.json')
    writeFileSync(filePath, JSON.stringify(VALID_CACHE))

    const result = loadEcosystemPartner(filePath)
    const solution = result!.solutions[0]

    // Verify all required fields are present
    expect(solution.name).toBeDefined()
    expect(solution.partnerName).toBeDefined()
    expect(solution.partnerSlug).toBeDefined()
    expect(solution.description).toBeDefined()
    expect(solution.platform).toBeDefined()
    expect(Array.isArray(solution.categories)).toBe(true)
    expect(solution.geoRegion).toBeDefined()
    expect(solution.url).toBeDefined()
    expect(Array.isArray(solution.resources)).toBe(true)
    expect(Array.isArray(solution.collections)).toBe(true)

    // Verify resource structure
    expect(solution.resources[0].title).toBeDefined()
    expect(solution.resources[0].url).toBeDefined()
    expect(solution.resources[0].type).toBe('lab')

    // Verify collection structure
    expect(solution.collections[0].name).toBeDefined()
    expect(solution.collections[0].namespace).toBeDefined()
  })
})

// ── loadAllEcosystemPartners ──────────────────────────────────────────────────

describe('loadAllEcosystemPartners', () => {
  test('returns array of partners from populated directory', () => {
    // Set CACHE_DIR to point to our test directory's parent
    const origCacheDir = process.env.CACHE_DIR
    process.env.CACHE_DIR = TEST_DIR

    // Create the ecosystem-catalog subdirectory
    const ecosystemDir = resolve(TEST_DIR, 'ecosystem-catalog')
    mkdirSync(ecosystemDir, { recursive: true })

    // Write two partner files
    const cisco = { ...VALID_CACHE, partnerName: 'Cisco', partnerSlug: 'cisco' }
    const vmware = { ...VALID_CACHE, partnerName: 'VMware', partnerSlug: 'vmware' }
    writeFileSync(resolve(ecosystemDir, 'cisco.json'), JSON.stringify(cisco))
    writeFileSync(resolve(ecosystemDir, 'vmware.json'), JSON.stringify(vmware))

    const result = loadAllEcosystemPartners()
    expect(result).toHaveLength(2)

    const names = result.map(p => p.partnerName).sort()
    expect(names).toEqual(['Cisco', 'VMware'])

    // Restore
    if (origCacheDir !== undefined) {
      process.env.CACHE_DIR = origCacheDir
    } else {
      delete process.env.CACHE_DIR
    }
  })

  test('returns empty array when directory does not exist', () => {
    const origCacheDir = process.env.CACHE_DIR
    process.env.CACHE_DIR = '/nonexistent/cache/dir'

    const result = loadAllEcosystemPartners()
    expect(result).toEqual([])

    if (origCacheDir !== undefined) {
      process.env.CACHE_DIR = origCacheDir
    } else {
      delete process.env.CACHE_DIR
    }
  })

  test('skips invalid files silently', () => {
    const origCacheDir = process.env.CACHE_DIR
    process.env.CACHE_DIR = TEST_DIR

    const ecosystemDir = resolve(TEST_DIR, 'ecosystem-catalog')
    mkdirSync(ecosystemDir, { recursive: true })

    // One valid, one invalid
    writeFileSync(resolve(ecosystemDir, 'good.json'), JSON.stringify(VALID_CACHE))
    writeFileSync(resolve(ecosystemDir, 'bad.json'), 'not json')

    const result = loadAllEcosystemPartners()
    expect(result).toHaveLength(1)
    expect(result[0].partnerName).toBe('TestPartner')

    if (origCacheDir !== undefined) {
      process.env.CACHE_DIR = origCacheDir
    } else {
      delete process.env.CACHE_DIR
    }
  })
})

// ── getEcosystemCacheDir ──────────────────────────────────────────────────────

describe('getEcosystemCacheDir', () => {
  test('returns path ending in ecosystem-catalog', () => {
    const dir = getEcosystemCacheDir()
    expect(dir.endsWith('ecosystem-catalog')).toBe(true)
  })
})
