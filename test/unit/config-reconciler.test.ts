import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { reconcileConfig, getAuthConfigPath, getPodConfigPath, getUserSettingsPath } from '../../src/config-reconciler.ts'

const TEST_CONFIG_DIR = resolve(import.meta.dir, '../tmp-config-reconciler-test')

// Override CONFIG_DIR for test isolation BEFORE importing the module
process.env.CONFIG_DIR = TEST_CONFIG_DIR

const AUTH_CONFIG_PATH = getAuthConfigPath()
const POD_CONFIG_PATH = getPodConfigPath()
const USER_SETTINGS_PATH = getUserSettingsPath()
const LEGACY_PATH = resolve(TEST_CONFIG_DIR, 'data-sources.json')

function cleanupTestFiles(): void {
  const files = [AUTH_CONFIG_PATH, POD_CONFIG_PATH, USER_SETTINGS_PATH, LEGACY_PATH]
  for (const f of files) {
    try {
      if (existsSync(f)) unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
  // Also clean up archived files
  try {
    const entries = require('fs').readdirSync(TEST_CONFIG_DIR)
    for (const entry of entries) {
      if (entry.startsWith('data-sources.json.migrated-')) {
        unlinkSync(resolve(TEST_CONFIG_DIR, entry))
      }
    }
  } catch {
    /* ignore */
  }
}

beforeEach(() => {
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  cleanupTestFiles()
})

afterEach(() => {
  cleanupTestFiles()
})

describe('config-reconciler', () => {
  test('empty config dir creates 3 empty files', () => {
    reconcileConfig()

    expect(existsSync(AUTH_CONFIG_PATH)).toBe(true)
    expect(existsSync(POD_CONFIG_PATH)).toBe(true)
    expect(existsSync(USER_SETTINGS_PATH)).toBe(true)

    const auth = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8'))
    const pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8'))
    const settings = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'))

    expect(Object.keys(auth).length).toBe(0)
    expect(Object.keys(pod).length).toBe(0)
    expect(Object.keys(settings).length).toBe(0)
  })

  test('legacy data-sources.json with all 7 fields migrates to 3 files correctly', () => {
    const legacy = {
      redhatOfflineToken: 'test-token-123',
      scaffoldCache: { folder1: { configFolderId: 'cfg1', productsFolderId: 'prod1' } },
      podConfig: { territorySheetId: 'sheet1', sfReportId: 'report1', parentFolderId: 'parent1' },
      schedulerConfig: { morningTime: '08:00', refreshIntervalMinutes: 60 },
      weather: { enabled: true, zipCode: '12345' },
      aiConfig: { enabled: true, provider: 'gemini' },
      automationConfig: { briefHistoryDays: 7 },
    }
    writeFileSync(LEGACY_PATH, JSON.stringify(legacy, null, 2))

    reconcileConfig()

    const auth = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8'))
    const pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8'))
    const settings = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'))

    expect(auth.redhatOfflineToken).toBe('test-token-123')
    expect(pod.scaffoldCache).toEqual({ folder1: { configFolderId: 'cfg1', productsFolderId: 'prod1' } })
    expect(pod.podConfig).toEqual({ territorySheetId: 'sheet1', sfReportId: 'report1', parentFolderId: 'parent1' })
    expect(settings.schedulerConfig).toEqual({ morningTime: '08:00', refreshIntervalMinutes: 60 })
    expect(settings.weather).toEqual({ enabled: true, zipCode: '12345' })
    expect(settings.aiConfig).toEqual({ enabled: true, provider: 'gemini' })
    expect(settings.automationConfig).toEqual({ briefHistoryDays: 7 })

    // Legacy should be archived
    const archived = require('fs')
      .readdirSync(TEST_CONFIG_DIR)
      .filter((f: string) => f.startsWith('data-sources.json.migrated-'))
    expect(archived.length).toBe(1)
  })

  test('legacy + existing auth.json: auth.json wins (not overwritten)', () => {
    const legacy = { redhatOfflineToken: 'legacy-token' }
    const existing = { redhatOfflineToken: 'existing-token' }
    writeFileSync(LEGACY_PATH, JSON.stringify(legacy, null, 2))
    writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(existing, null, 2))

    reconcileConfig()

    const auth = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8'))
    expect(auth.redhatOfflineToken).toBe('existing-token')
  })

  test('save token + reconciler runs again: token preserved', () => {
    // First run: migrate from legacy
    const legacy = { redhatOfflineToken: 'initial-token' }
    writeFileSync(LEGACY_PATH, JSON.stringify(legacy, null, 2))
    reconcileConfig()

    // Simulate token save
    const auth = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8'))
    auth.redhatOfflineToken = 'updated-token'
    writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(auth, null, 2))

    // Second reconciler run (e.g., after container restart)
    reconcileConfig()

    const authAfter = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8'))
    expect(authAfter.redhatOfflineToken).toBe('updated-token')
  })

  test('multiple reconciler runs are idempotent (no data loss)', () => {
    const legacy = {
      redhatOfflineToken: 'token',
      scaffoldCache: { f1: { configFolderId: 'c1', productsFolderId: 'p1' } },
      podConfig: { territorySheetId: 's1', sfReportId: 'r1', parentFolderId: 'pf1' },
      schedulerConfig: { morningTime: '09:00' },
      weather: { enabled: false },
      aiConfig: { provider: 'openai' },
      automationConfig: { briefHistoryDays: 14 },
    }
    writeFileSync(LEGACY_PATH, JSON.stringify(legacy, null, 2))

    // Run 3 times
    reconcileConfig()
    reconcileConfig()
    reconcileConfig()

    const auth = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8'))
    const pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8'))
    const settings = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'))

    expect(auth.redhatOfflineToken).toBe('token')
    expect(pod.scaffoldCache).toEqual({ f1: { configFolderId: 'c1', productsFolderId: 'p1' } })
    expect(pod.podConfig).toEqual({ territorySheetId: 's1', sfReportId: 'r1', parentFolderId: 'pf1' })
    expect(settings.schedulerConfig).toEqual({ morningTime: '09:00' })
    expect(settings.weather).toEqual({ enabled: false })
    expect(settings.aiConfig).toEqual({ provider: 'openai' })
    expect(settings.automationConfig).toEqual({ briefHistoryDays: 14 })
  })

  test('missing legacy file does not error, creates empty files', () => {
    // No legacy file exists
    expect(existsSync(LEGACY_PATH)).toBe(false)

    // Should not throw
    expect(() => reconcileConfig()).not.toThrow()

    // Should create 3 empty files
    expect(existsSync(AUTH_CONFIG_PATH)).toBe(true)
    expect(existsSync(POD_CONFIG_PATH)).toBe(true)
    expect(existsSync(USER_SETTINGS_PATH)).toBe(true)

    const auth = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8'))
    const pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8'))
    const settings = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'))

    expect(Object.keys(auth).length).toBe(0)
    expect(Object.keys(pod).length).toBe(0)
    expect(Object.keys(settings).length).toBe(0)
  })
})
