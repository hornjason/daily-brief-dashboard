/**
 * BKL-TEST-PRODUCTS-HUB-01 — Product Hub regression tests.
 *
 * Mocks every endpoint the /dashboard/products route fetches and verifies the
 * page renders product cards correctly with empty + populated feature states.
 * No data mutations — all routes intercepted via page.route().
 */
import { test, expect } from '../fixtures'
import type { Page } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

const PRODUCTS = [
  { slug: 'rhel', displayName: 'Red Hat Enterprise Linux', currentVersion: '10' },
  { slug: 'ocp',  displayName: 'OpenShift',                currentVersion: '4.21' },
]

function emptyTerritorySummary(slug: string) {
  return {
    slug,
    coverageCount: 0,
    totalCustomers: 0,
    coverageBreakdown: { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 },
    topPriorityActions: [],
    lastUpdated: null,
    slidesStatus: { filesIngested: 0, lastRefreshed: null },
    featureStatus: null,
  }
}

async function mockProductHubAPIs(page: Page, opts: { features?: unknown[] } = {}) {
  const features = opts.features ?? []

  await page.route('**/api/config', r => {
    if (r.request().url().includes('/api/config/')) return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ briefConfigured: true, briefProvider: 'pai', pods: [], territories: {} }),
    })
  })

  await page.route('**/api/accounts', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ customers: [] }) }),
  )

  // Territory summaries — match per-slug routes BEFORE the bare /api/products route
  await page.route('**/api/products/*/territory-summary', r => {
    const url = r.request().url()
    const m = url.match(/\/api\/products\/([^/]+)\/territory-summary/)
    const slug = m?.[1] ?? 'unknown'
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyTerritorySummary(slug)),
    })
  })

  await page.route('**/api/products/alerts', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )

  await page.route('**/api/products/features', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(features) }),
  )

  // Bare /api/products — must come AFTER more specific /api/products/* routes above
  // (Playwright handlers run in registration order; first match wins, so register
  // most-specific patterns first. Done above.)
  await page.route('**/api/products', r => {
    if (r.request().url().match(/\/api\/products\//)) return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PRODUCTS),
    })
  })
}

test.describe('Product Hub — BKL-TEST-PRODUCTS-HUB-01', () => {
  test('renders product cards with empty features', async ({ page }) => {
    await mockProductHubAPIs(page)
    await page.goto(`${BASE_URL}/dashboard/products`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: 'Product Intelligence', level: 1 })).toBeVisible()
    await expect(page.getByText('Red Hat Enterprise Linux').first()).toBeVisible()
    await expect(page.getByText('OpenShift').first()).toBeVisible()

    // No error banner — the ProductsPage error state has a "Retry" button.
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  })

  test('settles past loading skeleton and renders both product cards', async ({ page }) => {
    await mockProductHubAPIs(page)
    await page.goto(`${BASE_URL}/dashboard/products`, { waitUntil: 'domcontentloaded' })

    // Wait for both product display names to be visible — guarantees we're past loading.
    await expect(page.getByText('Red Hat Enterprise Linux').first()).toBeVisible()
    await expect(page.getByText('OpenShift').first()).toBeVisible()
  })

  test('renders with populated features', async ({ page }) => {
    const features = [
      {
        slug: 'rhel',
        displayName: 'Red Hat Enterprise Linux',
        features: [
          {
            id: 'f1',
            featureSlug: 'rhel',
            name: 'Image Builder',
            status: 'GA',
            versionIntroduced: '10',
            versionCurrent: '10',
            description: 'Build custom RHEL images',
            enrichedDescription: null,
            sourceUrls: [],
            enrichmentUrls: [],
            tags: [],
            confidence: 'HIGH',
            slideSource: 'release-notes',
          },
        ],
        corpusHash: 'abc123',
        summaryHash: 'def456',
        extractedAt: '2026-04-26T00:00:00Z',
        enrichedAt: null,
      },
    ]
    await mockProductHubAPIs(page, { features })
    await page.goto(`${BASE_URL}/dashboard/products`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByText('Image Builder').first()).toBeVisible()
  })
})
