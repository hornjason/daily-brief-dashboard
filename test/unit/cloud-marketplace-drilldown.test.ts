/**
 * GitHub Issue #352 — Cloud marketplace drill-down: details, SPIFFs
 *
 * Tests that:
 * 1. The cloud-marketplace module exports data with all detail fields
 * 2. The frontend component exists for expandable cloud program details
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

describe('Cloud marketplace drill-down (#352)', () => {
  test('cloud-marketplace module signals use summary offeringType with structured metadata', () => {
    const modulePath = resolve(import.meta.dir, '../../src/modules/cloud-marketplace-module.ts')
    const content = readFileSync(modulePath, 'utf-8')
    expect(content).toContain("offeringType: 'summary'")
    expect(content).toContain('offerings: cloud.offerings.map')
    expect(content).toContain('programs: cloud.programs.map')
    expect(content).toContain('incentives: cloud.incentives.map')
  })

  test('cloud marketplace API route exists for raw detail data', () => {
    const routePath = resolve(import.meta.dir, '../../src/cloud-marketplace-routes.ts')
    expect(existsSync(routePath)).toBe(true)
    const content = readFileSync(routePath, 'utf-8')
    expect(content).toContain('/api/cloud-marketplace/details')
  })

  test('CloudMarketplaceDetail component exists with expandable sections', () => {
    const componentPath = resolve(import.meta.dir, '../../dashboard/src/components/CloudMarketplaceDetail.tsx')
    expect(existsSync(componentPath)).toBe(true)
    const content = readFileSync(componentPath, 'utf-8')
    expect(content).toContain('offerings')
    expect(content).toContain('programs')
    expect(content).toContain('incentives')
  })
})
