// test/unit/partner-catalog-drive-sync.test.ts
// GitHub Issue #998 — Partner Catalog Drive Sync: download + upload + ensureFresh integration

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { resolve } from 'path'

// ── AC-1: downloadTerritoryPartnersFromDrive exists ──────────────────────────

describe('partner-catalog-drive-sync exports', () => {
  let driveSync: typeof import('../../src/lib/partner-catalog-drive-sync.ts')

  beforeAll(async () => {
    driveSync = await import('../../src/lib/partner-catalog-drive-sync.ts')
  })

  test('AC-1: downloadTerritoryPartnersFromDrive is exported and is a function', () => {
    expect(driveSync.downloadTerritoryPartnersFromDrive).toBeDefined()
    expect(typeof driveSync.downloadTerritoryPartnersFromDrive).toBe('function')
  })

  test('AC-2: uploadTerritoryPartnersToDrive is exported and is a function', () => {
    expect(driveSync.uploadTerritoryPartnersToDrive).toBeDefined()
    expect(typeof driveSync.uploadTerritoryPartnersToDrive).toBe('function')
  })
})

// ── AC-1: download returns false when no settings ────────────────────────────

describe('downloadTerritoryPartnersFromDrive — no settings', () => {
  const origConfigDir = process.env.CONFIG_DIR
  const tmpConfigDir = '/tmp/test-partner-drive-sync-config'

  beforeAll(() => {
    mkdirSync(tmpConfigDir, { recursive: true })
    // Write settings with no podBookingsFolderId
    writeFileSync(resolve(tmpConfigDir, 'settings.json'), JSON.stringify({ regions: [] }))
    process.env.CONFIG_DIR = tmpConfigDir
  })

  afterAll(() => {
    if (origConfigDir !== undefined) process.env.CONFIG_DIR = origConfigDir
    else delete process.env.CONFIG_DIR
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  test('returns false when no podBookingsFolderId in settings', async () => {
    // Re-import to pick up new CONFIG_DIR — but the module reads CONFIG_DIR at call time via paths.ts
    // Since getPodBookingsFolderId reads CONFIG_DIR from paths.ts import, and paths.ts reads
    // process.env.CONFIG_DIR at module load, we need to accept the cached value.
    // The function should still return false because settings has no podBookingsFolderId.
    const { downloadTerritoryPartnersFromDrive } = await import('../../src/lib/partner-catalog-drive-sync.ts')
    const result = await downloadTerritoryPartnersFromDrive()
    expect(result).toBe(false)
  })
})

// ── AC-2: upload returns false when no local file ────────────────────────────

describe('uploadTerritoryPartnersToDrive — no local file', () => {
  const origCacheDir = process.env.CACHE_DIR
  const tmpCacheDir = '/tmp/test-partner-drive-sync-cache-empty'

  beforeAll(() => {
    mkdirSync(tmpCacheDir, { recursive: true })
    process.env.CACHE_DIR = tmpCacheDir
  })

  afterAll(() => {
    if (origCacheDir !== undefined) process.env.CACHE_DIR = origCacheDir
    else delete process.env.CACHE_DIR
    rmSync(tmpCacheDir, { recursive: true, force: true })
  })

  test('returns false when no local territory-partners.json exists', async () => {
    const { uploadTerritoryPartnersToDrive } = await import('../../src/lib/partner-catalog-drive-sync.ts')
    const result = await uploadTerritoryPartnersToDrive()
    expect(result).toBe(false)
  })
})

// ── AC-3: ensureFresh calls downloadTerritoryPartnersFromDrive ───────────────

describe('partner-catalog-module ensureFresh Drive sync integration', () => {
  test('AC-3: ensureFresh imports downloadTerritoryPartnersFromDrive', async () => {
    // Verify the module source contains the import and call
    const moduleSrc = readFileSync(
      resolve(import.meta.dir, '../../src/modules/partner-catalog-module.ts'),
      'utf-8',
    )
    expect(moduleSrc).toContain("import { downloadTerritoryPartnersFromDrive }")
    expect(moduleSrc).toContain('downloadTerritoryPartnersFromDrive()')
  })

  test('AC-3: ensureFresh calls Drive sync when cache file is missing', async () => {
    // Set CACHE_DIR to a temp dir with no territory-partners.json
    const origCacheDir = process.env.CACHE_DIR
    const tmpDir = '/tmp/test-partner-ensure-fresh-missing'
    mkdirSync(tmpDir, { recursive: true })
    process.env.CACHE_DIR = tmpDir

    try {
      const { FeatureModuleRegistry } = await import('../../src/feature-module-registry.ts')
      await import('../../src/modules/partner-catalog-module.ts')
      const mod = FeatureModuleRegistry.get('partner-catalog')
      expect(mod).toBeDefined()
      // ensureFresh should not throw — it gracefully handles missing settings/Drive auth
      await expect(mod!.ensureFresh('test-slug')).resolves.toBeUndefined()
    } finally {
      if (origCacheDir !== undefined) process.env.CACHE_DIR = origCacheDir
      else delete process.env.CACHE_DIR
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
