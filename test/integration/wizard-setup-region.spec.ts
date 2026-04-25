/**
 * Integration tests for the wizard setup-region API — BKL-ONBOARD-10.
 *
 * Covers:
 *   - POST /api/wizard/setup-region with valid body → 200, region persisted
 *   - POST /api/wizard/setup-region with invalid sheetUrl → 400
 *   - Idempotency: two POSTs with same sheetUrl → regions[] has length 1
 *
 * Uses the `request` fixture only — no browser needed.
 * Targets the test container (7776) via TEST_URL env var.
 */
import { test, expect } from '@playwright/test'

test.use({ baseURL: process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776' })

const VALID_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1wizard_test_sheet_onboard10/edit?gid=0#gid=0'

test.describe('POST /api/wizard/setup-region', () => {
  test('valid body returns 200 with regionId and persists region', async ({ request }) => {
    const res = await request.post('/api/wizard/setup-region', {
      data: {
        sheetUrl: VALID_SHEET_URL,
        label: 'Test Region BKL-ONBOARD-10',
        sfReportId: '00OPeTest0000onboard10',
      },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('success', true)
    expect(body).toHaveProperty('regionId')
    expect(typeof body.regionId).toBe('string')
    expect(body.regionId.length).toBeGreaterThan(0)

    // Verify the region was persisted: GET /api/settings/regions should include it
    const regionsRes = await request.get('/api/settings/regions')
    expect(regionsRes.status()).toBe(200)
    const regionsBody = await regionsRes.json()
    expect(Array.isArray(regionsBody.regions)).toBe(true)
    const found = regionsBody.regions.find(
      (r: { id: string; label: string; type: string }) => r.id === body.regionId
    )
    expect(found).toBeDefined()
    expect(found.label).toBe('Test Region BKL-ONBOARD-10')
  })

  test('invalid sheetUrl returns 400 with error message', async ({ request }) => {
    const res = await request.post('/api/wizard/setup-region', {
      data: {
        sheetUrl: 'https://not-a-google-sheet.example.com/foo',
        label: 'Bad Sheet',
        sfReportId: '00OPeAny',
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  test('missing label returns 400 with error message', async ({ request }) => {
    const res = await request.post('/api/wizard/setup-region', {
      data: {
        sheetUrl: VALID_SHEET_URL,
        label: '',
        sfReportId: '00OPeAny',
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  test('missing sfReportId returns 400 with error message', async ({ request }) => {
    const res = await request.post('/api/wizard/setup-region', {
      data: {
        sheetUrl: VALID_SHEET_URL,
        label: 'Some Label',
        sfReportId: '',
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  test('idempotency: two POSTs with same sheetUrl result in exactly one region entry', async ({ request }) => {
    // First POST
    const res1 = await request.post('/api/wizard/setup-region', {
      data: {
        sheetUrl: VALID_SHEET_URL,
        label: 'Idempotent Region',
        sfReportId: '00OPeIdempotent01',
      },
    })
    expect(res1.status()).toBe(200)
    const body1 = await res1.json()
    const regionId = body1.regionId

    // Second POST with same sheetUrl but different label
    const res2 = await request.post('/api/wizard/setup-region', {
      data: {
        sheetUrl: VALID_SHEET_URL,
        label: 'Idempotent Region Updated',
        sfReportId: '00OPeIdempotent02',
      },
    })
    expect(res2.status()).toBe(200)
    const body2 = await res2.json()
    // Should return the same regionId (not a new one)
    expect(body2.regionId).toBe(regionId)

    // GET regions — should have exactly one entry for this sheetUrl
    const regionsRes = await request.get('/api/settings/regions')
    const regionsBody = await regionsRes.json()
    const matching = regionsBody.regions.filter(
      (r: { id: string }) => r.id === regionId
    )
    expect(matching).toHaveLength(1)
  })
})

test.describe('GET /api/wizard/seed-sheets', () => {
  test('returns sheets array with at least the built-in entries', async ({ request }) => {
    const res = await request.get('/api/wizard/seed-sheets')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.sheets)).toBe(true)
    expect(body.sheets.length).toBeGreaterThanOrEqual(2)
    // Both built-in seed sheets should be present
    expect(body.sheets).toContain(
      'https://docs.google.com/spreadsheets/d/1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8/edit?gid=294606982#gid=294606982'
    )
    expect(body.sheets).toContain(
      'https://docs.google.com/spreadsheets/d/1p5nM6NNB-vCnaoKxyThnR1zuj_e_80WqzmWh-RsODlQ/edit?gid=409386986#gid=409386986'
    )
  })
})
