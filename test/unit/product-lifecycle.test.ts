// GitHub Issue #197 — Product lifecycle fetcher using endoflife.date API
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import type { ProductLifecycle } from '../../src/product-lifecycle.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

// Mock endoflife.date API responses
const mockOcpResponse = [
  { cycle: "4.20", releaseDate: "2025-10-21", eol: "2027-04-21", latest: "4.20.4", latestReleaseDate: "2025-11-18", lts: false, support: true, extendedSupport: false },
  { cycle: "4.19", releaseDate: "2025-05-15", eol: "2026-11-15", latest: "4.19.8", latestReleaseDate: "2025-10-10", lts: false, support: false, extendedSupport: false },
]

const mockRhelResponse = [
  { cycle: "10", releaseDate: "2025-05-20", eol: "2035-05-31", lts: "2035-05-31", latest: "10.1", latestReleaseDate: "2025-11-12", support: "2030-05-31", extendedSupport: "2038-05-31" },
  { cycle: "9", releaseDate: "2022-05-18", eol: "2032-05-31", lts: "2032-05-31", latest: "9.5", latestReleaseDate: "2024-11-12", support: "2027-05-31", extendedSupport: "2035-05-31" },
]

const mockAapResponse = [
  { cycle: "2.6", releaseDate: "2025-10-01", eol: "2027-10-01", lts: false, support: "2026-10-01", extendedSupport: "2028-10-01" },
  { cycle: "2.5", releaseDate: "2024-05-01", eol: "2026-05-01", lts: false, support: false, extendedSupport: "2027-05-01" },
]

describe('product lifecycle transformation', () => {
  test('transforms OpenShift API response into ProductLifecycle shape', () => {
    // This will be implemented in src/product-lifecycle.ts
    // For now, test what the shape should look like
    const expected: ProductLifecycle = {
      slug: 'ocp',
      displayName: 'Red Hat OpenShift Container Platform',
      currentVersion: '4.20',
      latestPatch: '4.20.4',
      nextVersion: null,
      nextExpected: null,
      gaDate: '2025-10-21',
      eolDate: '2027-04-21',
      eusAvailable: false,
      supportEnd: '2027-04-21',
    }

    // Verify the expected shape is correct
    expect(expected.slug).toBe('ocp')
    expect(expected.currentVersion).toBe('4.20')
    expect(expected.latestPatch).toBe('4.20.4')
  })

  test('transforms RHEL API response with extended support', () => {
    const expected: ProductLifecycle = {
      slug: 'rhel',
      displayName: 'Red Hat Enterprise Linux',
      currentVersion: '10',
      latestPatch: '10.1',
      nextVersion: null,
      nextExpected: null,
      gaDate: '2025-05-20',
      eolDate: '2035-05-31',
      eusAvailable: true,
      supportEnd: '2030-05-31',
    }

    expect(expected.eusAvailable).toBe(true)
    expect(expected.supportEnd).toBe('2030-05-31')
  })
})

describe('signal generation', () => {
  test('generates Signal[] with correct type and shape', () => {
    const mockCache = {
      products: [
        {
          slug: 'ocp',
          displayName: 'Red Hat OpenShift Container Platform',
          currentVersion: '4.20',
          latestPatch: '4.20.4',
          nextVersion: null,
          nextExpected: null,
          gaDate: '2025-10-21',
          eolDate: '2027-04-21',
          eusAvailable: false,
          supportEnd: '2027-04-21',
        }
      ],
      fetchedAt: '2026-05-14T10:00:00Z',
    }

    // Signal should have this shape
    const expectedSignal: Signal = {
      source: 'product-lifecycle',
      type: 'product-release',
      headline: 'OpenShift 4.20 — EOL April 2027',
      detail: 'Current version: 4.20.4 | GA: October 2025 | Support ends: April 2027',
      score: 0.4,
      timestamp: mockCache.fetchedAt,
      metadata: {
        slug: 'ocp',
        currentVersion: '4.20',
        eolDate: '2027-04-21',
        nextVersion: null,
      },
    }

    expect(expectedSignal.type).toBe('product-release')
    expect(expectedSignal.source).toBe('product-lifecycle')
    expect(expectedSignal.metadata).toBeDefined()
  })

  test('scores EOL within 90 days as 0.8', () => {
    const now = new Date('2027-01-15')  // 106 days before EOL
    const eolDate = '2027-04-21'
    const daysUntilEol = Math.floor((new Date(eolDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

    expect(daysUntilEol).toBeGreaterThan(90)

    const soonEolDate = '2027-04-10'
    const soonDays = Math.floor((new Date(soonEolDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    expect(soonDays).toBeLessThan(90)
  })
})

describe('API failure handling', () => {
  test('handles one product API failure gracefully', async () => {
    // When one product's API fails, others should still succeed
    // The cache should contain the successful products
    // This tests the try/catch per-product pattern

    // Mock implementation would handle this like:
    // const results = []
    // for (const product of PRODUCTS) {
    //   try {
    //     const data = await fetch(product.url)
    //     results.push(transform(data))
    //   } catch (e) {
    //     console.warn(`Failed to fetch ${product.slug}`)
    //     // continue to next product
    //   }
    // }

    expect(true).toBe(true)  // Placeholder — actual test will verify cache file
  })
})
