/**
 * SalesHub Product Drive Sync — Unit Tests (GitHub Issue #819)
 *
 * Tests the Drive sync library for product page data.
 * Mocks Google Drive API to avoid real API calls.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

// Set up temp dirs before importing
const TEST_CONFIG_DIR = resolve(import.meta.dir, '../fixtures/product-drive-sync-config')
const TEST_CACHE_DIR = resolve(import.meta.dir, '../fixtures/product-drive-sync-cache')
const TEST_TEMPLATES_DIR = resolve(import.meta.dir, '../fixtures/product-drive-sync-templates')

const originalConfigDir = process.env.CONFIG_DIR
const originalCacheDir = process.env.CACHE_DIR

beforeEach(() => {
  process.env.CONFIG_DIR = TEST_CONFIG_DIR
  process.env.CACHE_DIR = TEST_CACHE_DIR
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  mkdirSync(TEST_CACHE_DIR, { recursive: true })
  mkdirSync(TEST_TEMPLATES_DIR, { recursive: true })
})

afterEach(() => {
  process.env.CONFIG_DIR = originalConfigDir ?? undefined
  process.env.CACHE_DIR = originalCacheDir ?? undefined
  for (const dir of [TEST_CONFIG_DIR, TEST_CACHE_DIR, TEST_TEMPLATES_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true })
  }
})

describe('saleshub-product-drive-sync', () => {
  describe('downloadProductsFromDrive', () => {
    test('returns { downloaded: 0 } when settings.json does not exist', async () => {
      // No settings.json written — should handle gracefully
      const { downloadProductsFromDrive } = await import('../../src/lib/saleshub-product-drive-sync.ts')

      const result = await downloadProductsFromDrive()
      expect(result.downloaded).toBe(0)
      expect(result.products).toEqual([])
    })

    test('returns { downloaded: 0 } when podBookingsFolderId is missing from settings', async () => {
      writeFileSync(
        resolve(TEST_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ regions: [{ name: 'Test Region' }] }),
      )

      const { downloadProductsFromDrive } = await import('../../src/lib/saleshub-product-drive-sync.ts')

      const result = await downloadProductsFromDrive()
      expect(result.downloaded).toBe(0)
      expect(result.products).toEqual([])
    })

    test('returns { downloaded: 0 } when settings has empty regions array', async () => {
      writeFileSync(
        resolve(TEST_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ regions: [] }),
      )

      const { downloadProductsFromDrive } = await import('../../src/lib/saleshub-product-drive-sync.ts')

      const result = await downloadProductsFromDrive()
      expect(result.downloaded).toBe(0)
      expect(result.products).toEqual([])
    })
  })

  describe('uploadProductToDrive', () => {
    test('returns null when podBookingsFolderId is missing', async () => {
      writeFileSync(
        resolve(TEST_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ regions: [] }),
      )

      const { uploadProductToDrive } = await import('../../src/lib/saleshub-product-drive-sync.ts')

      const result = await uploadProductToDrive('test-product', { name: 'Test' })
      expect(result).toBeNull()
    })
  })

  describe('createProductSectionFolders', () => {
    test('returns empty map when podBookingsFolderId is missing', async () => {
      writeFileSync(
        resolve(TEST_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ regions: [] }),
      )

      const { createProductSectionFolders } = await import('../../src/lib/saleshub-product-drive-sync.ts')

      const result = await createProductSectionFolders('test-product', ['Section A', 'Section B'])
      expect(result).toEqual({})
    })
  })
})
