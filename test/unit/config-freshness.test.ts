import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { resolve } from 'path'

// Import the function we're testing
let checkConfigFreshness: () => Promise<Array<{
  file: string
  action: 'promoted' | 'kept-local' | 'seeded' | 'skipped'
  imageTimestamp?: string
  localTimestamp?: string
}>>

beforeAll(async () => {
  const mod = await import('../../src/startup-cascade.ts')
  checkConfigFreshness = mod.checkConfigFreshness
})

// Test directory setup
const TEST_ROOT = resolve('/tmp/config-freshness-test')
const TEST_TEMPLATES = resolve(TEST_ROOT, 'config-templates')
const TEST_CONFIG = resolve(TEST_ROOT, 'config')

function setupTestDirs() {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_TEMPLATES, { recursive: true })
  mkdirSync(TEST_CONFIG, { recursive: true })
}

function writeTestConfig(dir: 'templates' | 'config', file: string, data: any) {
  const path = dir === 'templates' ? TEST_TEMPLATES : TEST_CONFIG
  writeFileSync(resolve(path, file), JSON.stringify(data, null, 2))
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

test('promotes image config when image is newer than local', async () => {
  setupTestDirs()

  const imageData = {
    refreshedAt: '2026-06-08T00:00:00Z',
    products: ['test']
  }

  const localData = {
    refreshedAt: '2026-06-01T00:00:00Z',
    products: ['old']
  }

  writeTestConfig('templates', 'rh-product-catalog.json', imageData)
  writeTestConfig('config', 'rh-product-catalog.json', localData)

  // Set env vars to point to test dirs
  const origTemplates = process.env.CONFIG_TEMPLATES_DIR
  const origConfig = process.env.CONFIG_DIR
  process.env.CONFIG_TEMPLATES_DIR = TEST_TEMPLATES
  process.env.CONFIG_DIR = TEST_CONFIG

  const results = await checkConfigFreshness()

  // Restore env
  process.env.CONFIG_TEMPLATES_DIR = origTemplates
  process.env.CONFIG_DIR = origConfig

  const result = results.find(r => r.file === 'rh-product-catalog.json')
  expect(result).toBeDefined()
  expect(result?.action).toBe('promoted')
  expect(result?.imageTimestamp).toBe('2026-06-08T00:00:00Z')
  expect(result?.localTimestamp).toBe('2026-06-01T00:00:00Z')

  // Verify file was actually copied
  const promoted = JSON.parse(readFileSync(resolve(TEST_CONFIG, 'rh-product-catalog.json'), 'utf-8'))
  expect(promoted.refreshedAt).toBe('2026-06-08T00:00:00Z')
})

test('keeps local config when local is newer than image', async () => {
  setupTestDirs()

  const imageData = {
    refreshedAt: '2026-06-01T00:00:00Z',
    products: ['old']
  }

  const localData = {
    refreshedAt: '2026-06-08T00:00:00Z',
    products: ['fresh']
  }

  writeTestConfig('templates', 'rh-product-catalog.json', imageData)
  writeTestConfig('config', 'rh-product-catalog.json', localData)

  process.env.CONFIG_TEMPLATES_DIR = TEST_TEMPLATES
  process.env.CONFIG_DIR = TEST_CONFIG

  const results = await checkConfigFreshness()

  const result = results.find(r => r.file === 'rh-product-catalog.json')
  expect(result).toBeDefined()
  expect(result?.action).toBe('kept-local')
  expect(result?.imageTimestamp).toBe('2026-06-01T00:00:00Z')
  expect(result?.localTimestamp).toBe('2026-06-08T00:00:00Z')

  // Verify file was NOT overwritten
  const kept = JSON.parse(readFileSync(resolve(TEST_CONFIG, 'rh-product-catalog.json'), 'utf-8'))
  expect(kept.products).toEqual(['fresh'])
})

test('seeds from image when local does not exist', async () => {
  setupTestDirs()

  const imageData = {
    refreshedAt: '2026-06-08T00:00:00Z',
    products: ['initial']
  }

  writeTestConfig('templates', 'solution-plays.json', imageData)
  // Don't write local — simulating fresh install

  process.env.CONFIG_TEMPLATES_DIR = TEST_TEMPLATES
  process.env.CONFIG_DIR = TEST_CONFIG

  const results = await checkConfigFreshness()

  const result = results.find(r => r.file === 'solution-plays.json')
  expect(result).toBeDefined()
  expect(result?.action).toBe('seeded')

  // Verify file was created
  expect(existsSync(resolve(TEST_CONFIG, 'solution-plays.json'))).toBe(true)
  const seeded = JSON.parse(readFileSync(resolve(TEST_CONFIG, 'solution-plays.json'), 'utf-8'))
  expect(seeded.refreshedAt).toBe('2026-06-08T00:00:00Z')
})

test('skips when image does not exist', async () => {
  setupTestDirs()

  // Don't write image template — simulating missing file
  writeTestConfig('config', 'solution-plays.json', { test: true })

  process.env.CONFIG_TEMPLATES_DIR = TEST_TEMPLATES
  process.env.CONFIG_DIR = TEST_CONFIG

  const results = await checkConfigFreshness()

  const result = results.find(r => r.file === 'solution-plays.json')
  expect(result).toBeDefined()
  expect(result?.action).toBe('skipped')
})

test('keeps local when no refreshedAt in either file', async () => {
  setupTestDirs()

  const imageData = { products: ['no-timestamp'] }
  const localData = { products: ['also-no-timestamp'] }

  writeTestConfig('templates', 'rh-product-catalog.json', imageData)
  writeTestConfig('config', 'rh-product-catalog.json', localData)

  process.env.CONFIG_TEMPLATES_DIR = TEST_TEMPLATES
  process.env.CONFIG_DIR = TEST_CONFIG

  const results = await checkConfigFreshness()

  const result = results.find(r => r.file === 'rh-product-catalog.json')
  expect(result).toBeDefined()
  expect(result?.action).toBe('kept-local')

  // Verify local was not overwritten
  const kept = JSON.parse(readFileSync(resolve(TEST_CONFIG, 'rh-product-catalog.json'), 'utf-8'))
  expect(kept.products).toEqual(['also-no-timestamp'])
})

test('uses scrapedAt as fallback when refreshedAt missing', async () => {
  setupTestDirs()

  const imageData = {
    scrapedAt: '2026-06-08T00:00:00Z',
    content: ['newer']
  }

  const localData = {
    scrapedAt: '2026-06-01T00:00:00Z',
    content: ['older']
  }

  writeTestConfig('templates', 'saleshub-knowledge.json', imageData)
  writeTestConfig('config', 'saleshub-knowledge.json', localData)

  process.env.CONFIG_TEMPLATES_DIR = TEST_TEMPLATES
  process.env.CONFIG_DIR = TEST_CONFIG

  const results = await checkConfigFreshness()

  const result = results.find(r => r.file === 'saleshub-knowledge.json')
  expect(result).toBeDefined()
  expect(result?.action).toBe('promoted')
  expect(result?.imageTimestamp).toBe('2026-06-08T00:00:00Z')
})

test('handles malformed JSON gracefully by keeping local', async () => {
  setupTestDirs()

  writeFileSync(resolve(TEST_TEMPLATES, 'rh-product-catalog.json'), 'NOT JSON {{{')
  writeTestConfig('config', 'rh-product-catalog.json', { safe: true })

  process.env.CONFIG_TEMPLATES_DIR = TEST_TEMPLATES
  process.env.CONFIG_DIR = TEST_CONFIG

  const results = await checkConfigFreshness()

  const result = results.find(r => r.file === 'rh-product-catalog.json')
  expect(result).toBeDefined()
  expect(result?.action).toBe('kept-local')

  // Verify local was not corrupted
  const kept = JSON.parse(readFileSync(resolve(TEST_CONFIG, 'rh-product-catalog.json'), 'utf-8'))
  expect(kept.safe).toBe(true)
})
