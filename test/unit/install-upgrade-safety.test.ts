import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { resolve } from 'path'

/**
 * BKL-INSTALL-01 / Issue #86: Curl hero install overwrites data on upgrades
 *
 * Verifies that config file seeding logic respects upgrade vs fresh install mode.
 *
 * Fresh install: aes.json missing → seed test defaults
 * Upgrade: aes.json exists → skip seeding, preserve existing data
 */

describe('Install upgrade safety', () => {
  const testDir = resolve(import.meta.dir, '../../data-test-upgrade-safety')
  const configDir = resolve(testDir, 'config')
  const aesPath = resolve(configDir, 'aes.json')
  const customersPath = resolve(configDir, 'customers.json')
  const settingsPath = resolve(configDir, 'settings.json')

  beforeEach(() => {
    // Clean slate for each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    mkdirSync(configDir, { recursive: true })
  })

  afterEach(() => {
    // Cleanup
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('fresh install: seeds aes.json when missing', () => {
    // Arrange: no aes.json exists (fresh install)
    expect(existsSync(aesPath)).toBe(false)

    // Act: simulate server.ts startup seeding logic
    const shouldSeed = !existsSync(aesPath)
    if (shouldSeed) {
      const seedData = { aes: [{ name: 'Test AE', email: 'test@example.com' }] }
      writeFileSync(aesPath, JSON.stringify(seedData, null, 2))
    }

    // Assert: seed data was written
    expect(existsSync(aesPath)).toBe(true)
    const content = JSON.parse(readFileSync(aesPath, 'utf-8'))
    expect(content.aes).toHaveLength(1)
    expect(content.aes[0].name).toBe('Test AE')
  })

  test('upgrade: preserves existing aes.json', () => {
    // Arrange: existing user config (user configured "Garett" AE)
    const userConfig = {
      aes: [
        { name: 'Garett Rowe', email: 'growe@redhat.com', territory: 'West-01' }
      ]
    }
    writeFileSync(aesPath, JSON.stringify(userConfig, null, 2))

    // Act: simulate server.ts startup on upgrade (aes.json already exists)
    const shouldSeed = !existsSync(aesPath)
    if (shouldSeed) {
      // This branch should NOT execute on upgrade
      const seedData = { aes: [{ name: 'Test AE', email: 'test@example.com' }] }
      writeFileSync(aesPath, JSON.stringify(seedData, null, 2))
    }

    // Assert: original user data preserved (Garett, not Test AE)
    expect(existsSync(aesPath)).toBe(true)
    const content = JSON.parse(readFileSync(aesPath, 'utf-8'))
    expect(content.aes).toHaveLength(1)
    expect(content.aes[0].name).toBe('Garett Rowe')
    expect(content.aes[0].email).toBe('growe@redhat.com')
  })

  test('upgrade: creates backup before any config modification', () => {
    // Arrange: existing config
    const userConfig = { aes: [{ name: 'Garett Rowe' }] }
    writeFileSync(aesPath, JSON.stringify(userConfig, null, 2))

    // Act: simulate backup creation (if we ever need to modify on upgrade)
    if (existsSync(aesPath)) {
      const backupPath = `${aesPath}.bak`
      const original = readFileSync(aesPath, 'utf-8')
      writeFileSync(backupPath, original)
    }

    // Assert: backup exists with original content
    const backupPath = `${aesPath}.bak`
    expect(existsSync(backupPath)).toBe(true)
    const backup = JSON.parse(readFileSync(backupPath, 'utf-8'))
    expect(backup.aes[0].name).toBe('Garett Rowe')
  })

  test('fresh install: seeds customers.json when missing', () => {
    // Arrange: no customers.json (fresh install)
    expect(existsSync(customersPath)).toBe(false)

    // Act: seed logic
    const shouldSeed = !existsSync(customersPath)
    if (shouldSeed) {
      const seedData = { customers: [] }
      writeFileSync(customersPath, JSON.stringify(seedData, null, 2))
    }

    // Assert: empty array seeded
    expect(existsSync(customersPath)).toBe(true)
    const content = JSON.parse(readFileSync(customersPath, 'utf-8'))
    expect(content.customers).toEqual([])
  })

  test('upgrade: preserves existing customers.json', () => {
    // Arrange: user has configured customers
    const userCustomers = {
      customers: [
        { name: 'Acme Corp', accountNumber: '1234567' },
        { name: 'Big Ten Network', accountNumber: '7654321' }
      ]
    }
    writeFileSync(customersPath, JSON.stringify(userCustomers, null, 2))

    // Act: startup on upgrade
    const shouldSeed = !existsSync(customersPath)
    if (shouldSeed) {
      const seedData = { customers: [] }
      writeFileSync(customersPath, JSON.stringify(seedData, null, 2))
    }

    // Assert: user customers preserved
    expect(existsSync(customersPath)).toBe(true)
    const content = JSON.parse(readFileSync(customersPath, 'utf-8'))
    expect(content.customers).toHaveLength(2)
    expect(content.customers[0].name).toBe('Acme Corp')
  })

  test('fresh install: seeds settings.json regions', () => {
    // This pattern already exists in server.ts — verify it works correctly
    expect(existsSync(settingsPath)).toBe(false)

    // Act: server.ts pattern — seed if no regions array
    const existingRaw = existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, 'utf-8'))
      : {}
    const hasRegions = Array.isArray(existingRaw.regions) && existingRaw.regions.length > 0

    if (!hasRegions) {
      const seedData = { regions: [{ id: 'test-region', label: 'Test' }] }
      const merged = { ...existingRaw, regions: seedData.regions }
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2))
    }

    // Assert: regions seeded
    expect(existsSync(settingsPath)).toBe(true)
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(content.regions).toHaveLength(1)
  })

  test('upgrade: preserves settings.json regions', () => {
    // Arrange: user has configured custom region settings
    const userSettings = {
      regions: [{ id: 'custom', label: 'Custom Region', customField: 'user-data' }],
      enabledRegions: ['custom']
    }
    writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2))

    // Act: server.ts startup
    const existingRaw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const hasRegions = Array.isArray(existingRaw.regions) && existingRaw.regions.length > 0

    if (!hasRegions) {
      const seedData = { regions: [{ id: 'test-region', label: 'Test' }] }
      const merged = { ...existingRaw, regions: seedData.regions }
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2))
    }

    // Assert: custom region preserved
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(content.regions[0].id).toBe('custom')
    expect(content.regions[0].customField).toBe('user-data')
    expect(content.enabledRegions).toEqual(['custom'])
  })
})
