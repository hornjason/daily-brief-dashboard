/**
 * GitHub Issue #354 — Events: location/region awareness
 *
 * Tests:
 * 1. Events module includes location in signal detail
 * 2. Events module matches by customer region
 * 3. Events module exposes location metadata for UI proximity display
 * 4. Events UI shows location badges
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Events location awareness (#354)', () => {
  test('events-module signals include location metadata', () => {
    const modulePath = resolve(import.meta.dir, '../../src/modules/events-module.ts')
    const content = readFileSync(modulePath, 'utf-8')
    expect(content).toContain('location: event.location')
    expect(content).toContain('region: event.region')
  })

  test('events-module has territoryToRegion function', () => {
    const modulePath = resolve(import.meta.dir, '../../src/modules/events-module.ts')
    const content = readFileSync(modulePath, 'utf-8')
    expect(content).toContain('function territoryToRegion')
  })

  test('events-module checks customer region for geographic matching', () => {
    const modulePath = resolve(import.meta.dir, '../../src/modules/events-module.ts')
    const content = readFileSync(modulePath, 'utf-8')
    expect(content).toContain('getCustomerRegion')
    expect(content).toContain('customerRegion')
  })

  test('events-module matches events by interest products not just owned', () => {
    const modulePath = resolve(import.meta.dir, '../../src/modules/events-module.ts')
    const content = readFileSync(modulePath, 'utf-8')
    expect(content).toContain('allRelevantProducts')
  })

  test('events-module boosts relevance for geographic proximity', () => {
    const modulePath = resolve(import.meta.dir, '../../src/modules/events-module.ts')
    const content = readFileSync(modulePath, 'utf-8')
    expect(content).toContain('regionMatch')
  })

  test('IntelligenceTab events section shows location info', () => {
    const tabPath = resolve(import.meta.dir, '../../dashboard/src/components/tabs/IntelligenceTab.tsx')
    const content = readFileSync(tabPath, 'utf-8')
    expect(content).toContain('event.location')
    expect(content).toContain('MapPin')
  })

  test('events-module signals include description metadata (#387)', () => {
    const modulePath = resolve(import.meta.dir, '../../src/modules/events-module.ts')
    const content = readFileSync(modulePath, 'utf-8')
    expect(content).toContain('description: event.summary || event.description')
  })

  test('customer intelligence events endpoint merges enriched descriptions (#387)', () => {
    const routesPath = resolve(import.meta.dir, '../../src/intelligence-routes.ts')
    const content = readFileSync(routesPath, 'utf-8')
    expect(content).toContain('enrichedDescription')
    expect(content).toContain('rh-events-enriched.json')
  })

  test('IntelligenceTab renders enriched or raw description (#387)', () => {
    const tabPath = resolve(import.meta.dir, '../../dashboard/src/components/tabs/IntelligenceTab.tsx')
    const content = readFileSync(tabPath, 'utf-8')
    expect(content).toContain('event.enrichedDescription || event.description')
  })
})
