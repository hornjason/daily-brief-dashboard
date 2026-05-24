/**
 * GitHub Issue #179 — News Radar settings UI
 *
 * Tests:
 * 1. NewsRadarSettings component exists with expected configuration panels
 * 2. Backend news config API supports all required fields
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

describe('News Radar settings UI (#179)', () => {
  test('NewsRadarSettings component exists', () => {
    const path = resolve(import.meta.dir, '../../dashboard/src/components/NewsRadarSettings.tsx')
    expect(existsSync(path)).toBe(true)
  })

  test('NewsRadarSettings component has keyword management UI', () => {
    const path = resolve(import.meta.dir, '../../dashboard/src/components/NewsRadarSettings.tsx')
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('signalTypes')
    expect(content).toContain('criticalKeywords')
    expect(content).toContain('excludeKeywords')
  })

  test('NewsRadarSettings component has threshold control', () => {
    const path = resolve(import.meta.dir, '../../dashboard/src/components/NewsRadarSettings.tsx')
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('defaultThreshold')
  })

  test('news-config.ts supports all config fields', () => {
    const path = resolve(import.meta.dir, '../../src/news-config.ts')
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('signalTypes')
    expect(content).toContain('criticalKeywords')
    expect(content).toContain('excludeKeywords')
    expect(content).toContain('defaultThreshold')
    expect(content).toContain('searchDepthDays')
  })

  test('news admin API endpoints exist', () => {
    const path = resolve(import.meta.dir, '../../src/news-routes.ts')
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('/api/admin/news-config')
  })
})
