/**
 * BKL-DRIVE-SCAFFOLD-CACHE-01: Drive scaffold ID cache
 *
 * Verifies that readScaffoldCache/writeScaffoldCache persist scaffold
 * results to data-sources.json so ensureConfigAndProductsScaffold can
 * short-circuit on subsequent calls without making Drive API calls.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

const TMP = `/tmp/scaffold-cache-test-${Date.now()}`

// Override CONFIG_DIR before importing bootstrap-orchestrator so DATA_SOURCES_PATH
// points to our temp directory — not the live config.
process.env.CONFIG_DIR = TMP

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
    const parentId = '1TESTPARENT'
    const entry = { configFolderId: '1CONFIG', productsFolderId: '1PRODUCTS' }

    writeScaffoldCache(parentId, entry)
    const cache = readScaffoldCache()

    expect(cache[parentId]).toEqual(entry)
  })

  test('writeScaffoldCache preserves existing data-sources.json fields', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    writeScaffoldCache('1PARENT', { configFolderId: '1C', productsFolderId: '1P' })

    const raw = JSON.parse(require('fs').readFileSync(resolve(TMP, 'data-sources.json'), 'utf-8'))
    // podConfig written by beforeEach must survive the scaffold write
    expect(raw.podConfig).toBeDefined()
    expect(raw.scaffoldCache['1PARENT']).toEqual({ configFolderId: '1C', productsFolderId: '1P' })
  })

  test('writeScaffoldCache accumulates multiple parentFolderIds', async () => {
    const { readScaffoldCache, writeScaffoldCache } = await import('../../src/bootstrap-orchestrator.ts')
    writeScaffoldCache('1A', { configFolderId: '1AC', productsFolderId: '1AP' })
    writeScaffoldCache('1B', { configFolderId: '1BC', productsFolderId: '1BP' })

    const cache = readScaffoldCache()
    expect(Object.keys(cache)).toHaveLength(2)
    expect(cache['1A'].configFolderId).toBe('1AC')
    expect(cache['1B'].configFolderId).toBe('1BC')
  })
})
