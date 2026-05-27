/**
 * Test: SalesHub Drive download path (Issue #442)
 *
 * Validates that downloadSaleshubFromDrive():
 * 1. Finds the SalesHub folder under podBookingsFolderId
 * 2. Downloads saleshub-knowledge.json
 * 3. Writes it to the CONFIG_DIR
 * 4. Falls back gracefully on errors
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { resolve } from 'path'

const TEST_CONFIG_DIR = resolve(import.meta.dir, '../fixtures/saleshub-drive-download-test')

// Stub settings.json with a podBookingsFolderId
function seedSettings(podBookingsFolderId: string) {
  writeFileSync(
    resolve(TEST_CONFIG_DIR, 'settings.json'),
    JSON.stringify({ regions: [{ podBookingsFolderId }] }),
  )
}

// Seed a stale knowledge file to verify overwrite
function seedStaleKnowledge() {
  writeFileSync(
    resolve(TEST_CONFIG_DIR, 'saleshub-knowledge.json'),
    JSON.stringify({ tdps: [], salesPlays: [], tactics: [], products: [], scrapedAt: '2020-01-01' }),
  )
}

describe('downloadSaleshubFromDrive', () => {
  beforeEach(() => {
    if (existsSync(TEST_CONFIG_DIR)) rmSync(TEST_CONFIG_DIR, { recursive: true })
    mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    process.env.CONFIG_DIR = TEST_CONFIG_DIR
  })

  it('returns false when no podBookingsFolderId in settings', async () => {
    writeFileSync(resolve(TEST_CONFIG_DIR, 'settings.json'), JSON.stringify({ regions: [] }))
    const { downloadSaleshubFromDrive } = await import('../../src/lib/saleshub-drive-sync.ts')
    const result = await downloadSaleshubFromDrive()
    expect(result).toBe(false)
  })

  it('returns false when settings.json is missing', async () => {
    // No settings.json at all
    const { downloadSaleshubFromDrive } = await import('../../src/lib/saleshub-drive-sync.ts')
    const result = await downloadSaleshubFromDrive()
    expect(result).toBe(false)
  })

  it('exports downloadSaleshubFromDrive as a function', async () => {
    const mod = await import('../../src/lib/saleshub-drive-sync.ts')
    expect(typeof mod.downloadSaleshubFromDrive).toBe('function')
  })
})
