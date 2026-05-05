/**
 * BKL-DRIVE-SCAFFOLD-CACHE-01: Drive scaffold ID cache
 *
 * Verifies that readScaffoldCache/writeScaffoldCache persist scaffold
 * results to data-sources.json so ensureConfigAndProductsScaffold can
 * short-circuit on subsequent calls without making Drive API calls.
 *
 * BKL-SEC-19: also verifies that invalid Drive folder IDs are rejected
 * before being used as JSON keys or written to disk.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const TMP = `/tmp/scaffold-cache-test-${Date.now()}`

// Override CONFIG_DIR before importing bootstrap-orchestrator so DATA_SOURCES_PATH
// points to our temp directory — not the live config.
process.env.CONFIG_DIR = TMP

// Valid Google Drive IDs are 25-33 alphanumeric chars; use realistic-length stubs.
const PARENT_ID   = '1TestParentFolderIdAAAAAAA'
const CONFIG_ID   = '1TestConfigFolderIdAAAAAAA'
const PRODUCTS_ID = '1TestProductsFolderIdAAAAA'
const PARENT_ID_B = '1TestParentFolderIdBBBBBBB'
const CONFIG_ID_B = '1TestConfigFolderIdBBBBBBB'
const PROD_ID_B   = '1TestProductsFolderIdBBBBB'

describe('BKL-DRIVE-SCAFFOLD-CACHE-01: scaffold cache persistence', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    // Start each test with a clean data-sources.json
    writeFileSync(resolve(TMP, 'data-sources.json'), JSON.stringify({ podConfig: { sfReportId: 'r' } }))
  })

  test('readScaffoldCache returns {} when no scaffoldCache key present', async () => {
    const { readScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    const result = readScaffoldCache()
    expect(result).toEqual({})
  })

  test('writeScaffoldCache persists entry and readScaffoldCache retrieves it', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    const entry = { configFolderId: CONFIG_ID, productsFolderId: PRODUCTS_ID }

    writeScaffoldCache(PARENT_ID, entry)
    const cache = readScaffoldCache()

    expect(cache[PARENT_ID]).toEqual({ ...entry, productSubfolders: {} })
  })

  test('writeScaffoldCache preserves existing data-sources.json fields', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    writeScaffoldCache(PARENT_ID, { configFolderId: CONFIG_ID, productsFolderId: PRODUCTS_ID })

    const raw = JSON.parse(readFileSync(resolve(TMP, 'data-sources.json'), 'utf-8'))
    // podConfig written by beforeEach must survive the scaffold write
    expect(raw.podConfig).toBeDefined()
    expect(raw.scaffoldCache[PARENT_ID]).toEqual({ configFolderId: CONFIG_ID, productsFolderId: PRODUCTS_ID, productSubfolders: {} })
  })

  test('writeScaffoldCache accumulates multiple parentFolderIds', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    writeScaffoldCache(PARENT_ID,   { configFolderId: CONFIG_ID,   productsFolderId: PRODUCTS_ID })
    writeScaffoldCache(PARENT_ID_B, { configFolderId: CONFIG_ID_B, productsFolderId: PROD_ID_B })

    const cache = readScaffoldCache()
    expect(Object.keys(cache)).toHaveLength(2)
    expect(cache[PARENT_ID].configFolderId).toBe(CONFIG_ID)
    expect(cache[PARENT_ID_B].configFolderId).toBe(CONFIG_ID_B)
  })

  // BKL-SEC-19: validation guard tests
  test('writeScaffoldCache silently skips invalid parentFolderId', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    writeScaffoldCache('short', { configFolderId: CONFIG_ID, productsFolderId: PRODUCTS_ID })
    expect(readScaffoldCache()).toEqual({})
  })

  test('writeScaffoldCache silently skips invalid configFolderId', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    writeScaffoldCache(PARENT_ID, { configFolderId: 'bad', productsFolderId: PRODUCTS_ID })
    expect(readScaffoldCache()).toEqual({})
  })

  test('writeScaffoldCache silently skips invalid productsFolderId', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    writeScaffoldCache(PARENT_ID, { configFolderId: CONFIG_ID, productsFolderId: 'bad' })
    expect(readScaffoldCache()).toEqual({})
  })
})
