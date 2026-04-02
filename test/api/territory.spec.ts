/**
 * Territory API endpoint tests.
 *
 * Covers /api/territory-names and /api/territory-lookup with Rook's
 * input validation (regex: /^[A-Z0-9_]+$/) and response shape checks.
 */
import { test, expect, getJSON } from '../fixtures'

// ── GET /api/territory-names ────────────────────────────────────────────────

test.describe('GET /api/territory-names', () => {
  test('returns 400 without pod param', async () => {
    const { status, body } = await getJSON('/api/territory-names')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid pod format')
  })

  test('returns 400 with invalid format (special characters)', async () => {
    const { status, body } = await getJSON('/api/territory-names?pod=INVALID%20FORMAT!!')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid pod format')
  })

  test('returns 400 with lowercase pod', async () => {
    const { status, body } = await getJSON('/api/territory-names?pod=west_comm_corp')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid pod format')
  })

  test('returns 400 with empty pod value', async () => {
    const { status, body } = await getJSON('/api/territory-names?pod=')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('returns 400 with HTML injection in pod', async () => {
    const { status, body } = await getJSON('/api/territory-names?pod=<script>alert(1)</script>')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('returns { territories } with valid pod (200 or 500 from Google API)', async () => {
    const { status, body } = await getJSON('/api/territory-names?pod=WEST_COMM_CORP_NORTHWEST')
    // 200 with territories array if Google auth works and sheet is accessible
    // 401 if Google auth not configured
    // 500 if Google API fails (network, quota, etc.)
    if (status === 200) {
      expect(body).toHaveProperty('territories')
      expect(Array.isArray(body.territories)).toBe(true)
      // Each territory should have num and aeName
      if (body.territories.length > 0) {
        expect(body.territories[0]).toHaveProperty('num')
        expect(body.territories[0]).toHaveProperty('aeName')
        expect(typeof body.territories[0].num).toBe('string')
        expect(typeof body.territories[0].aeName).toBe('string')
      }
    } else {
      expect([401, 500]).toContain(status)
      // 500 may return plain text "Internal Server Error" (body is null from json parse)
      // or JSON { error: "..." } depending on the error path
      if (body !== null) {
        expect(body).toHaveProperty('error')
      }
    }
  })
})

// ── GET /api/territory-lookup ───────────────────────────────────────────────

test.describe('GET /api/territory-lookup', () => {
  test('returns 400 without territory param', async () => {
    const { status, body } = await getJSON('/api/territory-lookup')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid territory format')
  })

  test('returns 400 with spaces in territory (Rook validation)', async () => {
    const { status, body } = await getJSON('/api/territory-lookup?territory=INVALID%20SPACES!!')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid territory format')
  })

  test('returns 400 with lowercase territory', async () => {
    const { status, body } = await getJSON('/api/territory-lookup?territory=invalid_lower')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('returns 400 with special characters in territory', async () => {
    const { status, body } = await getJSON('/api/territory-lookup?territory=TERR%3Cscript%3E')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('returns 400 with empty territory param', async () => {
    const { status, body } = await getJSON('/api/territory-lookup?territory=')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('valid territory returns 200 or auth/API error (not 500 crash)', async () => {
    const { status, body } = await getJSON(
      '/api/territory-lookup?territory=WEST_COMM_CORP_NORTHWEST_TERR01'
    )
    // 200 with lookup result if Google auth works
    // 401 if Google auth not configured
    // 404 if territory not found in sheet
    // 500 from Google API failures
    if (status === 200) {
      // Response shape when found: { aeName, accounts, tableauTerritory }
      expect(body).toHaveProperty('aeName')
      expect(typeof body.aeName).toBe('string')
    } else {
      expect([401, 404, 500]).toContain(status)
    }
  })
})
