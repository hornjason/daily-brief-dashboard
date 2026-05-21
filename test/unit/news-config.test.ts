/**
 * Unit tests for news configuration
 *
 * Tests:
 * - Config file reading with fallback to defaults
 * - Config validation on write
 * - Config merge and update logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { loadNewsConfig, updateNewsConfig, getDefaultConfig, resetConfigCache } from '../../src/news-config.ts'

const TEST_CONFIG_DIR = resolve('config')
const TEST_CONFIG_PATH = resolve(TEST_CONFIG_DIR, 'news-config.json')
const TEST_CONFIG_BACKUP = resolve(TEST_CONFIG_DIR, 'news-config.json.backup')

describe('News Configuration', () => {
  beforeEach(() => {
    // Backup existing config if it exists
    if (existsSync(TEST_CONFIG_PATH)) {
      writeFileSync(TEST_CONFIG_BACKUP, readFileSync(TEST_CONFIG_PATH))
    }

    // Clear cache
    resetConfigCache()
  })

  afterEach(() => {
    // Restore backup if it exists
    if (existsSync(TEST_CONFIG_BACKUP)) {
      writeFileSync(TEST_CONFIG_PATH, readFileSync(TEST_CONFIG_BACKUP))
      unlinkSync(TEST_CONFIG_BACKUP)
    }

    // Clear cache
    resetConfigCache()
  })

  it('should return default config when file does not exist', () => {
    // Remove config file if exists
    if (existsSync(TEST_CONFIG_PATH)) {
      unlinkSync(TEST_CONFIG_PATH)
    }

    resetConfigCache()

    const config = loadNewsConfig()
    const defaults = getDefaultConfig()

    expect(config.signalTypes).toEqual(defaults.signalTypes)
    expect(config.criticalKeywords).toEqual(defaults.criticalKeywords)
    expect(config.excludeKeywords).toEqual(defaults.excludeKeywords)
    expect(config.defaultThreshold).toBe(defaults.defaultThreshold)
    expect(config.searchDepthDays).toBe(defaults.searchDepthDays)
  })

  it('should read config from file when it exists', () => {
    const testConfig = {
      signalTypes: ['test-signal'],
      criticalKeywords: ['test-critical'],
      excludeKeywords: ['test-exclude'],
      defaultThreshold: 7,
      searchDepthDays: 5,
      significanceGuidelines: {
        '9-10': 'Test critical',
        '7-8': 'Test important',
        '4-6': 'Test notable',
        '1-3': 'Test low',
      },
    }

    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(testConfig, null, 2))
    resetConfigCache()

    const config = loadNewsConfig()

    expect(config.signalTypes).toEqual(['test-signal'])
    expect(config.criticalKeywords).toEqual(['test-critical'])
    expect(config.excludeKeywords).toEqual(['test-exclude'])
    expect(config.defaultThreshold).toBe(7)
    expect(config.searchDepthDays).toBe(5)
  })

  it('should reject config with invalid signalTypes', () => {
    const invalidConfig = {
      signalTypes: [], // Empty array is invalid
    }

    const result = updateNewsConfig(invalidConfig)

    expect(result.success).toBe(false)
    expect(result.error).toContain('signalTypes')
  })

  it('should reject config with invalid threshold values', () => {
    const invalidConfig = {
      defaultThreshold: 15, // Out of range
    }

    const result = updateNewsConfig(invalidConfig)

    expect(result.success).toBe(false)
    expect(result.error).toContain('defaultThreshold')
  })

  it('should reject config with invalid searchDepthDays values', () => {
    const invalidConfig = {
      searchDepthDays: 0, // Must be at least 1
    }

    const result = updateNewsConfig(invalidConfig)

    expect(result.success).toBe(false)
    expect(result.error).toContain('searchDepthDays')
  })

  it('should write valid config to file', () => {
    const newConfig = {
      signalTypes: ['updated-signal'],
      defaultThreshold: 8,
    }

    const result = updateNewsConfig(newConfig)

    expect(result.success).toBe(true)

    // Verify file was written
    resetConfigCache()
    const config = loadNewsConfig()

    expect(config.signalTypes).toEqual(['updated-signal'])
    expect(config.defaultThreshold).toBe(8)
  })

  it('should merge partial updates with existing config', () => {
    // Set initial config
    const initialConfig = {
      signalTypes: ['initial-signal'],
      criticalKeywords: ['initial-critical'],
      excludeKeywords: ['initial-exclude'],
      defaultThreshold: 5,
      searchDepthDays: 2,
      significanceGuidelines: {
        '9-10': 'Initial critical',
      },
    }

    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(initialConfig, null, 2))
    resetConfigCache()

    // Update only threshold
    const partialUpdate = {
      defaultThreshold: 7,
    }

    const result = updateNewsConfig(partialUpdate)

    expect(result.success).toBe(true)

    // Verify merge preserved other fields
    resetConfigCache()
    const config = loadNewsConfig()

    expect(config.signalTypes).toEqual(['initial-signal'])
    expect(config.criticalKeywords).toEqual(['initial-critical'])
    expect(config.defaultThreshold).toBe(7) // Updated
    expect(config.searchDepthDays).toBe(2) // Preserved
  })
})
