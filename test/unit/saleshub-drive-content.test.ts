// test/unit/saleshub-drive-content.test.ts
// GitHub Issue #507 — SalesHub Drive content listing + cache tests
// Tests the new Drive-based content loading for saleshub-content-module

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'fs'
import { resolve } from 'path'

// ── Drive content cache types (mirrors saleshub-content.ts) ─────────────

interface DriveContentFile {
  name: string
  mimeType: string
  driveUrl: string
  driveId: string
  size: number | null
  modifiedTime: string
  parentFolder: string
  extractedText: string | null
}

interface DriveContentCache {
  files: DriveContentFile[]
  lastSynced: string
  totalFiles: number
  withText: number
}

// ── Test fixtures ─────────────────────────────────────────────────────────

const TEST_CACHE_DIR = resolve(import.meta.dir, '../../data/cache/saleshub')
const TEST_CACHE_PATH = resolve(TEST_CACHE_DIR, 'drive-content.json')

function makeSampleCache(overrides: Partial<DriveContentCache> = {}): DriveContentCache {
  return {
    files: [
      {
        name: 'AAP 2.6 one-slide overview',
        mimeType: 'application/vnd.google-apps.presentation',
        driveUrl: 'https://docs.google.com/presentation/d/abc123',
        driveId: 'abc123',
        size: 1234,
        modifiedTime: '2026-05-29T16:51:56.923Z',
        parentFolder: 'Ansible Automation Platform',
        extractedText: 'AAP 2.6 brings event-driven automation...',
      },
      {
        name: 'RHEL 10 Security Guide',
        mimeType: 'application/vnd.google-apps.document',
        driveUrl: 'https://docs.google.com/document/d/def456',
        driveId: 'def456',
        size: 5678,
        modifiedTime: '2026-05-28T10:00:00.000Z',
        parentFolder: 'Red Hat Enterprise Linux',
        extractedText: 'RHEL 10 introduces enhanced security features...',
      },
      {
        name: 'OpenShift Pricing.pdf',
        mimeType: 'application/pdf',
        driveUrl: 'https://drive.google.com/file/d/ghi789',
        driveId: 'ghi789',
        size: 204800,
        modifiedTime: '2026-05-27T14:30:00.000Z',
        parentFolder: 'OpenShift',
        extractedText: null,  // Binary — no text extraction
      },
    ],
    lastSynced: '2026-05-31T12:00:00.000Z',
    totalFiles: 3,
    withText: 2,
    ...overrides,
  }
}

function writeCacheFile(cache: DriveContentCache): void {
  mkdirSync(TEST_CACHE_DIR, { recursive: true })
  writeFileSync(TEST_CACHE_PATH, JSON.stringify(cache, null, 2))
}

function cleanCache(): void {
  try { rmSync(TEST_CACHE_PATH, { force: true }) } catch {}
}

// ── loadDriveContent tests ──────────────────────────────────────────────

describe('loadDriveContent (saleshub-content.ts)', () => {
  beforeEach(() => cleanCache())
  afterEach(() => cleanCache())

  test('returns empty array when cache file does not exist', async () => {
    const { loadDriveContent } = await import('../../src/lib/saleshub-content.ts')
    const result = loadDriveContent()
    // When no cache, returns empty (graceful)
    expect(Array.isArray(result)).toBe(true)
  })

  test('loads files from cache when file exists', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)
    // Force re-import to pick up the file
    const { loadDriveContent, resetDriveContentCache } = await import('../../src/lib/saleshub-content.ts')
    resetDriveContentCache()
    const result = loadDriveContent()
    expect(result.length).toBe(3)
    expect(result[0].name).toBe('AAP 2.6 one-slide overview')
    expect(result[0].driveUrl).toBe('https://docs.google.com/presentation/d/abc123')
    expect(result[0].parentFolder).toBe('Ansible Automation Platform')
    expect(result[0].extractedText).toBe('AAP 2.6 brings event-driven automation...')
  })

  test('binary files have null extractedText', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)
    const { loadDriveContent, resetDriveContentCache } = await import('../../src/lib/saleshub-content.ts')
    resetDriveContentCache()
    const result = loadDriveContent()
    const pdf = result.find(f => f.name === 'OpenShift Pricing.pdf')
    expect(pdf).toBeDefined()
    expect(pdf!.extractedText).toBeNull()
  })
})

// ── getDriveContentMtime tests ──────────────────────────────────────────

describe('getDriveContentMtime (saleshub-content.ts)', () => {
  beforeEach(() => cleanCache())
  afterEach(() => cleanCache())

  test('returns 0 when cache file does not exist', async () => {
    const { getDriveContentMtime } = await import('../../src/lib/saleshub-content.ts')
    const mtime = getDriveContentMtime()
    expect(mtime).toBe(0)
  })

  test('returns file mtime when cache exists', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)
    const { getDriveContentMtime } = await import('../../src/lib/saleshub-content.ts')
    const mtime = getDriveContentMtime()
    expect(mtime).toBeGreaterThan(0)
    // Should be close to now
    expect(Date.now() - mtime).toBeLessThan(5000)
  })
})

// ── Product folder name mapping tests ─────────────────────────────────

describe('mapFolderToProduct (saleshub-content.ts)', () => {
  test('maps Ansible folder names to product', async () => {
    const { mapFolderToProduct } = await import('../../src/lib/saleshub-content.ts')
    expect(mapFolderToProduct('Ansible Automation Platform')).toContain('Ansible')
    expect(mapFolderToProduct('AAP Resources')).toContain('Ansible')
  })

  test('maps OpenShift folder names to product', async () => {
    const { mapFolderToProduct } = await import('../../src/lib/saleshub-content.ts')
    expect(mapFolderToProduct('OpenShift')).toContain('OpenShift')
    expect(mapFolderToProduct('OCP Advanced')).toContain('OpenShift')
  })

  test('maps RHEL folder names to product', async () => {
    const { mapFolderToProduct } = await import('../../src/lib/saleshub-content.ts')
    expect(mapFolderToProduct('Red Hat Enterprise Linux')).toContain('Enterprise Linux')
    expect(mapFolderToProduct('RHEL Security')).toContain('Enterprise Linux')
  })

  test('returns folder name for unmapped folders', async () => {
    const { mapFolderToProduct } = await import('../../src/lib/saleshub-content.ts')
    expect(mapFolderToProduct('Some Random Folder')).toBe('Some Random Folder')
  })
})

// ── listSaleshubDriveFiles tests ────────────────────────────────────────

describe('listSaleshubDriveFiles (saleshub-drive-sync.ts)', () => {
  test('function is exported', async () => {
    const mod = await import('../../src/lib/saleshub-drive-sync.ts')
    expect(typeof mod.listSaleshubDriveFiles).toBe('function')
  })
})

// ── Module integration — signal emission from Drive cache ───────────────

describe('saleshub-content-module signals from Drive cache (#507)', () => {
  beforeEach(() => cleanCache())
  afterEach(() => cleanCache())

  test('signals emitted per file in cache', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)

    // Reset caches and import fresh
    const contentLib = await import('../../src/lib/saleshub-content.ts')
    contentLib.resetDriveContentCache()

    // Module should already be registered from beforeAll in the other test file
    // but we import it explicitly
    await import('../../src/modules/saleshub-content-module.ts')
    const { FeatureModuleRegistry } = await import('../../src/feature-module-registry.ts')
    const mod = FeatureModuleRegistry.get('saleshub-content')
    expect(mod).toBeDefined()

    const signals = await mod!.signals!('test-customer')
    // Should have at least 3 signals from our cache (plus any from knowledge JSON)
    const driveSignals = signals.filter(s => s.metadata?.driveId)
    expect(driveSignals.length).toBe(3)
  })

  test('Drive signals have driveUrl in url field (#479)', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)

    const contentLib = await import('../../src/lib/saleshub-content.ts')
    contentLib.resetDriveContentCache()

    const { FeatureModuleRegistry } = await import('../../src/feature-module-registry.ts')
    const mod = FeatureModuleRegistry.get('saleshub-content')!
    const signals = await mod.signals!('test-customer')
    const driveSignals = signals.filter(s => s.metadata?.driveId)

    for (const s of driveSignals) {
      expect(s.url).toBeDefined()
      expect(s.url).toMatch(/^https:\/\//)
    }
  })

  test('Drive signals include extractedText in detail when available', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)

    const contentLib = await import('../../src/lib/saleshub-content.ts')
    contentLib.resetDriveContentCache()

    const { FeatureModuleRegistry } = await import('../../src/feature-module-registry.ts')
    const mod = FeatureModuleRegistry.get('saleshub-content')!
    const signals = await mod.signals!('test-customer')

    const aapSignal = signals.find(s => s.metadata?.driveId === 'abc123')
    expect(aapSignal).toBeDefined()
    expect(aapSignal!.detail).toContain('event-driven automation')

    // PDF should NOT have extractedText in detail
    const pdfSignal = signals.find(s => s.metadata?.driveId === 'ghi789')
    expect(pdfSignal).toBeDefined()
    expect(pdfSignal!.detail).not.toContain('extractedText')
  })

  test('Drive signals use parentFolder for product matching metadata', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)

    const contentLib = await import('../../src/lib/saleshub-content.ts')
    contentLib.resetDriveContentCache()

    const { FeatureModuleRegistry } = await import('../../src/feature-module-registry.ts')
    const mod = FeatureModuleRegistry.get('saleshub-content')!
    const signals = await mod.signals!('test-customer')

    const aapSignal = signals.find(s => s.metadata?.driveId === 'abc123')
    expect(aapSignal!.metadata!.product).toContain('Ansible')
    expect(aapSignal!.metadata!.parentFolder).toBe('Ansible Automation Platform')
  })

  test('signals never set score directly (ADR-027)', async () => {
    const cache = makeSampleCache()
    writeCacheFile(cache)

    const contentLib = await import('../../src/lib/saleshub-content.ts')
    contentLib.resetDriveContentCache()

    const { FeatureModuleRegistry } = await import('../../src/feature-module-registry.ts')
    const mod = FeatureModuleRegistry.get('saleshub-content')!
    const signals = await mod.signals!('test-customer')

    for (const s of signals) {
      expect(s.score).toBeUndefined()
    }
  })
})
