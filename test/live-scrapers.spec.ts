/**
 * test/live-scrapers.spec.ts
 * @live scraper pipeline tests — excluded from CI, tagged @live.
 * Run against a live container with an active authenticated session.
 *
 * Run with: npx playwright test test/live-scrapers.spec.ts --project=live-scrapers
 * Requires: running container at BASE_URL (default: http://localhost:7777)
 *           with an active RH Portal session (logged in via VNC)
 *
 * Tests run SERIALLY (mode: 'serial') — each waits for the previous to finish.
 * This prevents scraper queue races and ensures "full pipeline" runs after all
 * individual scrapers have completed.
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

// Serial mode: run tests in order, one at a time.
// Prevents parallel scraper triggers from racing each other in the queue.
test.describe.configure({ mode: 'serial' })

// ── Poll helper ───────────────────────────────────────────────────────────────

interface PollOptions {
  intervalMs?: number
  timeoutMs: number
  label?: string
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  options: PollOptions,
): Promise<T> {
  const { intervalMs = 3_000, timeoutMs, label = 'condition' } = options
  const deadline = Date.now() + timeoutMs
  let lastResult: T | undefined
  // Always wait one interval before first check — lets markRunning() fire
  await new Promise(r => setTimeout(r, intervalMs))
  while (Date.now() < deadline) {
    try {
      lastResult = await fn()
      if (predicate(lastResult)) return lastResult
    } catch {
      // transient fetch error — retry
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(
    `[pollUntil] timeout waiting for ${label} after ${timeoutMs / 1000}s. Last value: ${JSON.stringify(lastResult)}`,
  )
}

// ── Test 1: @live RH Cases — scrape returns data ──────────────────────────────

test('@live RH Cases — scrape returns data', async ({ request }) => {
  const trigger = await request.post(`${BASE_URL}/api/scrape/rh`)
  expect([200, 409]).toContain(trigger.status())

  const status = await pollUntil(
    async () => {
      const res = await request.get(`${BASE_URL}/api/scrape/rh/status`)
      expect(res.ok()).toBeTruthy()
      return res.json()
    },
    // Poll on store state — only resolves when recordOutcome() fires (task done)
    // isRunning can be false while task is still just pending in the queue
    (s: any) => s.state === 'fresh' || s.state === 'failed',
    { timeoutMs: 300_000, label: 'RH Cases scrape completion' },
  )

  expect(status.lastError).toBeNull()
  expect(status.recordCount).toBeGreaterThan(0)
})

// ── Test 2: @live SF Pipeline — scrape writes to sheet ───────────────────────

test('@live SF Pipeline — scrape writes to sheet', async ({ request }) => {
  const trigger = await request.post(`${BASE_URL}/api/scrape/salesforce`)
  expect([200, 409]).toContain(trigger.status())

  const status = await pollUntil(
    async () => {
      const res = await request.get(`${BASE_URL}/api/scrape/salesforce/status`)
      expect(res.ok()).toBeTruthy()
      return res.json()
    },
    (s: any) => s.state === 'fresh' || s.state === 'failed',
    { timeoutMs: 300_000, label: 'SF Pipeline scrape completion' },
  )

  expect(status.lastError).toBeNull()
  expect(status.recordCount).toBeGreaterThan(0)
})

// ── Test 3: @live CCSP — scrape returns records ───────────────────────────────
// NOTE: CCSP status uses { running: boolean } not { isRunning: boolean }.
// Poll on `s.running === false` AND a completed state (lastScrape set or error).

test('@live CCSP — scrape returns records', async ({ request }) => {
  const trigger = await request.post(`${BASE_URL}/api/scrape/ccsp`)
  expect([200, 409]).toContain(trigger.status())

  const status = await pollUntil(
    async () => {
      const res = await request.get(`${BASE_URL}/api/scrape/ccsp/status`)
      expect(res.ok()).toBeTruthy()
      return res.json()
    },
    (s: any) => s.state === 'fresh' || s.state === 'failed',
    { timeoutMs: 180_000, label: 'CCSP scrape completion' },
  )

  expect(status.lastError).toBeNull()
  expect(status.recordCount).toBeGreaterThan(0)
})

// ── Test 4: @live Supportable — customers have accountNumbers ────────────────
// Supportable requires an AE name — fetch AE list first, use first entry.
// NOTE: Requires RH Cases to have run first (uses RH account numbers).

test('@live Supportable — customers have accountNumbers', async ({ request }) => {
  // Verify at least one AE is configured
  const aesRes = await request.get(`${BASE_URL}/api/aes`)
  expect(aesRes.ok()).toBeTruthy()
  const aesBody = await aesRes.json()
  const aes: any[] = aesBody.aes ?? aesBody
  expect(aes.length, 'No AEs configured — cannot trigger Supportable').toBeGreaterThan(0)

  // Use discover endpoint — runs for all AEs, handles both cached and uncached account numbers
  const trigger = await request.post(`${BASE_URL}/api/scrape/supportable/discover`, {
    data: {},
    headers: { 'Content-Type': 'application/json' },
  })
  expect([200, 409]).toContain(trigger.status())

  // Supportable is slow — allow up to 300s
  const status = await pollUntil(
    async () => {
      const res = await request.get(`${BASE_URL}/api/scrape/supportable/status`)
      expect(res.ok()).toBeTruthy()
      return res.json()
    },
    (s: any) => s.state === 'fresh' || s.state === 'failed',
    { timeoutMs: 300_000, label: 'Supportable scrape completion' },
  )

  expect(status.lastError).toBeNull()
  // recordCount > 0 means Supportable found account numbers and scraped subscription data
  expect(status.recordCount, 'Supportable returned 0 subscription rows — account numbers may be missing').toBeGreaterThan(0)
})

// ── Test 5: @live Full pipeline — all scrapers fresh ─────────────────────────
// Runs AFTER individual scraper tests have completed (serial mode).

test('@live Full pipeline — all scrapers fresh', async ({ request }) => {
  const scrapeStatusRes = await request.get(`${BASE_URL}/api/status/scrapes`)
  expect(scrapeStatusRes.ok()).toBeTruthy()
  const scrapeStatus = await scrapeStatusRes.json()

  for (const scraperKey of ['rh', 'salesforce', 'ccsp', 'supportable']) {
    const s = scrapeStatus[scraperKey]
    expect(s, `${scraperKey} status missing`).toBeDefined()
    expect(s.isStale, `${scraperKey} should not be stale`).toBe(false)
    expect(s.lastError, `${scraperKey} should have no lastError`).toBeNull()
  }

  const storeRes = await request.get(`${BASE_URL}/api/scraper-status`)
  expect(storeRes.ok()).toBeTruthy()
  const storeBody = await storeRes.json()
  const storeStatus = storeBody.scrapers ?? storeBody

  for (const scraperKey of ['rh-cases', 'sf-pipeline', 'ccsp', 'supportable']) {
    const entry = storeStatus[scraperKey]
    expect(entry, `store entry for ${scraperKey} missing`).toBeDefined()
    expect(entry.lastError, `${scraperKey} store should have no lastError`).toBeNull()
  }
})

// ── Test 6: @live Source-to-cache — data freshness ───────────────────────────

test('@live Source-to-cache — data freshness', async ({ request }) => {
  const cutoff = new Date(Date.now() - TWO_HOURS_MS)

  for (const [name, endpoint] of [
    ['RH Cases', `${BASE_URL}/api/scrape/rh/status`],
    ['Salesforce', `${BASE_URL}/api/scrape/salesforce/status`],
    ['CCSP', `${BASE_URL}/api/scrape/ccsp/status`],
  ] as [string, string][]) {
    const res = await request.get(endpoint)
    expect(res.ok(), `${name} status endpoint failed`).toBeTruthy()
    const s = await res.json()

    const lastSuccess: string | null = s.lastSuccess ?? s.lastSync ?? null
    expect(lastSuccess, `${name} has no lastSuccess timestamp`).not.toBeNull()

    const lastSuccessDate = new Date(lastSuccess!)
    expect(
      lastSuccessDate.getTime(),
      `${name} lastSuccess (${lastSuccess}) is older than 2 hours`,
    ).toBeGreaterThan(cutoff.getTime())
  }
})
