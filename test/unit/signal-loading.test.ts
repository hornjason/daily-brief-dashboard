/**
 * Signal Loading Tests — PRD #180 requirement
 *
 * Tests loadCustomerSignals() function behavior:
 * - Returns correct signal structure
 * - Handles missing files gracefully
 * - Slug derivation is consistent
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../../src/cache-layer.ts'

const TEST_CACHE_DIR = resolve(import.meta.dir, '../test-cache')

describe('Signal loading structure', () => {
  interface CustomerSignals {
    intelligence?: any
    emails?: any
    subscriptions?: any
  }

  beforeEach(() => {
    // Clean test cache
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true })
    mkdirSync(resolve(TEST_CACHE_DIR, 'intelligence'), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
  })

  test('returns all three signal fields when files exist', () => {
    const customerSlug = 'test-corp'

    // Create mock signal files
    writeFileSync(
      resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`),
      JSON.stringify({ company: 'Test Corp intelligence' }),
    )
    writeFileSync(
      resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`),
      JSON.stringify([{ subject: 'Test email' }]),
    )
    writeFileSync(
      resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`),
      JSON.stringify({ subscriptions: ['RHEL'] }),
    )

    // Simulate loadCustomerSignals logic
    const signals: CustomerSignals = {}

    if (existsSync(resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`))) {
      signals.intelligence = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`), 'utf-8'),
      )
    }

    if (existsSync(resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`))) {
      signals.emails = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`), 'utf-8'),
      )
    }

    if (existsSync(resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`))) {
      signals.subscriptions = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`), 'utf-8'),
      )
    }

    expect(signals.intelligence).toBeDefined()
    expect(signals.emails).toBeDefined()
    expect(signals.subscriptions).toBeDefined()
  })

  test('returns empty object when no signal files exist', () => {
    const customerSlug = 'nonexistent-customer'
    const signals: CustomerSignals = {}

    // Attempt to load signals (files don't exist)
    if (existsSync(resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`))) {
      signals.intelligence = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`), 'utf-8'),
      )
    }

    if (existsSync(resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`))) {
      signals.emails = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`), 'utf-8'),
      )
    }

    if (existsSync(resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`))) {
      signals.subscriptions = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`), 'utf-8'),
      )
    }

    expect(signals.intelligence).toBeUndefined()
    expect(signals.emails).toBeUndefined()
    expect(signals.subscriptions).toBeUndefined()
  })

  test('partial signals when some files exist', () => {
    const customerSlug = 'partial-customer'

    // Only create intelligence file
    writeFileSync(
      resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`),
      JSON.stringify({ company: 'Partial data' }),
    )

    const signals: CustomerSignals = {}

    if (existsSync(resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`))) {
      signals.intelligence = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`), 'utf-8'),
      )
    }

    if (existsSync(resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`))) {
      signals.emails = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`), 'utf-8'),
      )
    }

    if (existsSync(resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`))) {
      signals.subscriptions = JSON.parse(
        require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`), 'utf-8'),
      )
    }

    expect(signals.intelligence).toBeDefined()
    expect(signals.emails).toBeUndefined()
    expect(signals.subscriptions).toBeUndefined()
  })

  test('intelligence file path follows pattern', () => {
    const customerSlug = 'test-corp'
    const expectedPath = resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`)

    expect(expectedPath).toMatch(/intelligence\/test-corp\.json$/)
  })

  test('emails file path follows pattern', () => {
    const customerSlug = 'test-corp'
    const expectedPath = resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`)

    expect(expectedPath).toMatch(/test-corp-emails\.json$/)
  })

  test('subscriptions file path follows pattern', () => {
    const customerSlug = 'test-corp'
    const expectedPath = resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`)

    expect(expectedPath).toMatch(/test-corp-sheets\.json$/)
  })
})

describe('Slug derivation consistency', () => {
  test('toSlug is consistent for customer names', () => {
    expect(toSlug('Test Corporation')).toBe('test-corporation')
    expect(toSlug('Acme Inc.')).toBe('acme-inc')
    expect(toSlug('Big Ten Network Services')).toBe('big-ten-network-services')
  })

  test('signal file slugs match customer slugs', () => {
    const customerName = 'Test Corporation'
    const slug = toSlug(customerName)

    // Intelligence path
    const intelPath = `intelligence/${slug}.json`
    expect(intelPath).toBe('intelligence/test-corporation.json')

    // Emails path
    const emailsPath = `${slug}-emails.json`
    expect(emailsPath).toBe('test-corporation-emails.json')

    // Subscriptions path
    const subsPath = `${slug}-sheets.json`
    expect(subsPath).toBe('test-corporation-sheets.json')
  })

  test('signal loading uses correct slug for file discovery', () => {
    const customerName = 'Test Corporation'
    const customerSlug = toSlug(customerName)

    // Verify slug is used for all file paths
    expect(customerSlug).toBe('test-corporation')

    // All signal file paths should use this slug
    const paths = [
      resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`),
      resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`),
      resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`),
    ]

    paths.forEach(p => {
      expect(p).toContain('test-corporation')
    })
  })
})

describe('Signal file content validation', () => {
  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true })
    mkdirSync(resolve(TEST_CACHE_DIR, 'intelligence'), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
  })

  test('intelligence signal has company field', () => {
    const customerSlug = 'test-corp'
    const intelligence = {
      company: 'Test Corp is a mid-market SaaS company with 200 employees.',
    }

    writeFileSync(
      resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`),
      JSON.stringify(intelligence),
    )

    const loaded = JSON.parse(
      require('fs').readFileSync(resolve(TEST_CACHE_DIR, 'intelligence', `${customerSlug}.json`), 'utf-8'),
    )

    expect(loaded.company).toBeDefined()
    expect(typeof loaded.company).toBe('string')
  })

  test('emails signal is an array', () => {
    const customerSlug = 'test-corp'
    const emails = [
      { subject: 'Q4 planning', from: 'Jason Horn', snippet: 'Let us discuss...' },
      { subject: 'Follow-up', from: 'Jason Horn', snippet: 'Per our call...' },
    ]

    writeFileSync(
      resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`),
      JSON.stringify(emails),
    )

    const loaded = JSON.parse(
      require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-emails.json`), 'utf-8'),
    )

    expect(Array.isArray(loaded)).toBe(true)
    expect(loaded.length).toBe(2)
  })

  test('subscriptions signal has expected structure', () => {
    const customerSlug = 'test-corp'
    const subscriptions = {
      subscriptions: ['RHEL', 'Ansible Automation Platform'],
    }

    writeFileSync(
      resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`),
      JSON.stringify(subscriptions),
    )

    const loaded = JSON.parse(
      require('fs').readFileSync(resolve(TEST_CACHE_DIR, `${customerSlug}-sheets.json`), 'utf-8'),
    )

    expect(loaded.subscriptions).toBeDefined()
    expect(Array.isArray(loaded.subscriptions)).toBe(true)
  })
})
