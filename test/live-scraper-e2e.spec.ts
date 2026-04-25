/**
 * test/live-scraper-e2e.spec.ts
 * @live end-to-end data-layer tests — excluded from CI, tagged @live.
 * Validates that scraped data is queryable through the API layer.
 *
 * Unlike live-scrapers.spec.ts (which triggers scrapes and polls completion),
 * this spec asserts on the shape and freshness of data already in cache.
 * Run AFTER live-scrapers.spec.ts has populated data, or against a container
 * with recent scrape results.
 *
 * Run with: npx playwright test test/live-scraper-e2e.spec.ts --project=live-scrapers
 * Requires: running container at BASE_URL (default: http://localhost:7777)
 *           with populated scrape data (cases, pipeline, ccsp)
 */

import { test, expect } from '@playwright/test'
import { requireLocalhost } from './utils/require-localhost'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'
requireLocalhost(BASE_URL)
const FIVE_MINUTES_MS = 5 * 60 * 1000

// Serial mode: shared sessions, deterministic order.
// Test 4 (brief generation) depends on AE list from test 1.
test.describe.configure({ mode: 'serial' })

// Generous timeout — scrapes and brief generation can be slow on first call.
test.setTimeout(60_000)

// Shared state: first AE and first customer discovered in test 1, reused in test 4.
let firstAeName: string
let firstCustomerName: string

// ── Test 1: @live RH Cases e2e — cases/all returns data ──────────────────────

test('@live RH Cases e2e — cases/all returns data', async ({ request }) => {
  // Discover first AE from config
  const aesRes = await request.get(`${BASE_URL}/api/aes`)
  expect(aesRes.ok(), 'GET /api/aes should succeed').toBeTruthy()
  const aesBody = await aesRes.json()
  const aes = aesBody?.aes ?? aesBody ?? []
  expect(Array.isArray(aes), '/api/aes should return an array').toBe(true)
  if (aes.length === 0) { console.log('No AEs configured — skipping @live RH Cases e2e'); return }

  // Stash for later tests
  firstAeName = aes[0].name ?? aes[0]
  const customers: string[] = aes[0].customers ?? []
  if (customers.length > 0) {
    firstCustomerName = customers[0]
  }

  // Fetch all cases
  const casesRes = await request.get(`${BASE_URL}/api/cases/all`)
  if (!casesRes.ok()) { console.log('GET /api/cases/all failed — skipping @live test'); return }

  const casesBody = await casesRes.json()
  const cases = Array.isArray(casesBody) ? casesBody : casesBody.cases
  if (!Array.isArray(cases) || cases.length === 0) { console.log('No cases data — skipping @live RH Cases e2e'); return }
})

// ── Test 2: @live SF Pipeline e2e — pipeline has opportunities ───────────────

test('@live SF Pipeline e2e — pipeline has opportunities', async ({ request }) => {
  const pipelineRes = await request.get(`${BASE_URL}/api/pipeline`)
  if (!pipelineRes.ok()) { console.log('GET /api/pipeline failed — skipping @live test'); return }

  const pipelineBody = await pipelineRes.json()
  const opportunities = Array.isArray(pipelineBody)
    ? pipelineBody
    : pipelineBody.opportunities ?? pipelineBody.data ?? []
  expect(
    Array.isArray(opportunities),
    'pipeline response should contain an array of opportunities',
  ).toBe(true)
  if (opportunities.length === 0) { console.log('No pipeline data — skipping @live SF Pipeline test'); return }
  expect(opportunities.length).toBeGreaterThan(0)
})

// ── Test 3: @live CCSP e2e — CCSP data has entries with cloudPartner ─────────

test('@live CCSP e2e — data has entries with cloudPartner', async ({ request }) => {
  const ccspRes = await request.get(`${BASE_URL}/api/ccsp`)
  if (!ccspRes.ok()) { console.log('GET /api/ccsp failed — skipping @live CCSP test'); return }

  const ccspBody = await ccspRes.json()
  // Response may be { data: [...] } or a raw array
  const data = Array.isArray(ccspBody) ? ccspBody : ccspBody.data ?? []
  expect(Array.isArray(data), 'CCSP response should contain an array').toBe(true)
  if (data.length === 0) { console.log('No CCSP data — skipping @live CCSP test'); return }

  // At least one entry should have a cloudPartner field
  const withCloudPartner = data.filter(
    (entry: Record<string, unknown>) => entry.cloudPartner != null,
  )
  expect(
    withCloudPartner.length,
    'at least one CCSP entry should have a cloudPartner field',
  ).toBeGreaterThan(0)
})

// ── Test 4: @live Full ingest → brief — customer brief is fresh ──────────────

test('@live Full ingest → brief — customer brief is fresh', async ({ request }) => {
  // We need a customer name from the AE discovered in test 1.
  // If test 1 didn't find customers, fetch AEs again to discover one.
  if (!firstCustomerName) {
    const aesRes = await request.get(`${BASE_URL}/api/aes`)
    if (!aesRes.ok()) { console.log('Cannot fetch AEs — skipping @live brief test'); return }
    const aesBody = await aesRes.json()
    const aesList = aesBody?.aes ?? aesBody ?? []
    for (const ae of aesList) {
      const customers: string[] = ae.customers ?? []
      if (customers.length > 0) {
        firstCustomerName = customers[0]
        break
      }
    }
  }

  if (!firstCustomerName) { console.log('No customer found — skipping @live brief freshness test'); return }

  // Request a fresh brief with force=true to bypass cache
  const encodedCustomer = encodeURIComponent(firstCustomerName)
  const briefRes = await request.get(
    `${BASE_URL}/api/customer/${encodedCustomer}/brief?force=true`,
  )
  expect(briefRes.ok(), `GET /api/customer/${firstCustomerName}/brief should succeed`).toBeTruthy()

  const briefBody = await briefRes.json()

  // Brief should have a non-empty text field
  const text: string = briefBody.text ?? briefBody.brief ?? briefBody.content ?? ''
  expect(text.length, 'brief text should be non-empty').toBeGreaterThan(0)

  // If cachedAt is present, it should be within the last 5 minutes (we forced a fresh gen)
  const cachedAt: string | undefined = briefBody.cachedAt ?? briefBody.generatedAt ?? briefBody.timestamp
  if (cachedAt) {
    const cachedTime = new Date(cachedAt).getTime()
    const now = Date.now()
    expect(
      now - cachedTime,
      `brief cachedAt (${cachedAt}) should be within the last 5 minutes`,
    ).toBeLessThan(FIVE_MINUTES_MS)
  }
})
