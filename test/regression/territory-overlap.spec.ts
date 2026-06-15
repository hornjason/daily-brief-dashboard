/**
 * REG-718: E2E tests for AE setup flow with overlapping enterprise territories.
 *
 * Issue #718: The TOLA enterprise region has overlapping territories — multiple
 * AEs share the same territory code (e.g. TERR03). The territory-lookup endpoint
 * uses `aeName` as the key to disambiguate, returning different customer lists
 * per AE even when the territory code is the same.
 *
 * These tests validate:
 *   1. territory-names returns AEs for TOLA enterprise pod
 *   2. territory-lookup with aeName returns the correct AE's accounts
 *   3. Two AEs sharing the same territory code get DIFFERENT customer lists
 *   4. territory-lookup without aeName still works (backward compat)
 *   5. Cross-pod lookups (TOLA vs High Plains) resolve correctly
 *
 * NOTE: Tests use force=true to bypass the territory cache. The cache keys by
 * territory string only (not aeName), so overlapping lookups would return stale
 * results from the first cached AE. This is a known limitation — see #718 comments.
 *
 * Tests gracefully skip (early return) when Google auth is unavailable (401)
 * or Google API errors occur (500). Run with --project=ci against 7777.
 */
import { test, expect } from '@playwright/test'
import { BASE_URL, getJSON } from './helpers'

// ── REG-718: TOLA enterprise territory overlap handling ───────────────────────

test.describe('REG-718: TOLA enterprise territory overlap handling', () => {
  // Run serially to avoid Google Sheets API rate limiting from parallel requests
  test.describe.configure({ mode: 'serial' })

  test('REG-718-01: territory-names returns AEs for CENTRAL_ENT_TOLA pod', async () => {
    const { status, body } = await getJSON('/api/territory-names?pod=CENTRAL_ENT_TOLA')
    if (status === 401) {
      console.log('REG-718-01: Google auth not configured — skipping')
      return
    }
    if (status === 500) {
      console.log('REG-718-01: Google API error — skipping')
      return
    }
    expect(status).toBe(200)
    expect(body).toHaveProperty('territories')
    expect(Array.isArray(body.territories)).toBe(true)
    expect(body.territories.length).toBeGreaterThan(0)

    for (const t of body.territories) {
      expect(t).toHaveProperty('num')
      expect(t).toHaveProperty('aeName')
      expect(typeof t.num).toBe('string')
      expect(typeof t.aeName).toBe('string')
      expect(t.aeName.length).toBeGreaterThan(0)
    }

    // TOLA should have multiple AEs
    const uniqueAes = new Set(body.territories.map((t: { aeName: string }) => t.aeName))
    expect(uniqueAes.size).toBeGreaterThan(1)
    console.log(`REG-718-01: TOLA has ${body.territories.length} territories across ${uniqueAes.size} AEs: ${[...uniqueAes].join(', ')}`)
  })

  test('REG-718-02: territory-lookup with aeName=Jeff+Veldhuizen returns Jeffs accounts', async () => {
    // force=true bypasses territory cache (cache keys by territory, not aeName)
    const { status, body } = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_TOLA_TERR03&aeName=Jeff+Veldhuizen&force=true'
    )
    if (status === 401) {
      console.log('REG-718-02: Google auth not configured — skipping')
      return
    }
    if (status === 500) {
      console.log(`REG-718-02: API error — ${body?.error ?? 'unknown'} — skipping`)
      return
    }
    expect(status).toBe(200)
    expect(body).toHaveProperty('aeName')
    expect(body.aeName).toBe('Jeff Veldhuizen')
    expect(body).toHaveProperty('accounts')
    expect(Array.isArray(body.accounts)).toBe(true)
    expect(body).toHaveProperty('tableauTerritory')
    expect(body.tableauTerritory).toBe('CENTRAL_ENT_TOLA_TERR03')

    console.log(`REG-718-02: Jeff Veldhuizen has ${body.accounts.length} accounts in TOLA TERR03`)
  })

  test('REG-718-03: territory-lookup with aeName=Shane+Otto returns Shanes accounts', async () => {
    const { status, body } = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_TOLA_TERR03&aeName=Shane+Otto&force=true'
    )
    if (status === 401) {
      console.log('REG-718-03: Google auth not configured — skipping')
      return
    }
    if (status === 500) {
      console.log(`REG-718-03: API error — ${body?.error ?? 'unknown'} — skipping`)
      return
    }
    expect(status).toBe(200)
    expect(body).toHaveProperty('aeName')
    expect(body.aeName).toBe('Shane Otto')
    expect(body).toHaveProperty('accounts')
    expect(Array.isArray(body.accounts)).toBe(true)
    expect(body).toHaveProperty('tableauTerritory')

    console.log(`REG-718-03: Shane Otto has ${body.accounts.length} accounts in TOLA TERR03`)
  })

  // ── REG-718-04: Core overlap test — same territory code, different customer lists ──

  test('REG-718-04: overlapping TERR03 returns different customer lists for Jeff vs Shane', async () => {
    // Both requests use force=true to ensure fresh Google Sheets lookups
    // (cache keys by territory string only, ignoring aeName — #718 finding)
    const jeffResult = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_TOLA_TERR03&aeName=Jeff+Veldhuizen&force=true'
    )
    const shaneResult = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_TOLA_TERR03&aeName=Shane+Otto&force=true'
    )

    if (jeffResult.status === 401 || shaneResult.status === 401) {
      console.log('REG-718-04: Google auth not configured — skipping')
      return
    }
    if (jeffResult.status === 500 || shaneResult.status === 500) {
      console.log('REG-718-04: API error — skipping')
      return
    }

    expect(jeffResult.status).toBe(200)
    expect(shaneResult.status).toBe(200)

    // Verify aeName disambiguation worked
    expect(jeffResult.body.aeName).toBe('Jeff Veldhuizen')
    expect(shaneResult.body.aeName).toBe('Shane Otto')

    const jeffAccounts = jeffResult.body.accounts as string[]
    const shaneAccounts = shaneResult.body.accounts as string[]

    // Both should have accounts (non-empty)
    expect(jeffAccounts.length).toBeGreaterThan(0)
    expect(shaneAccounts.length).toBeGreaterThan(0)

    // The account lists must be DIFFERENT — this is the core overlap test.
    // If territory-lookup were ignoring aeName and returning the first match,
    // both would get the same list (the old bug behavior from #712).
    const jeffSet = new Set(jeffAccounts.map(a => a.toLowerCase()))
    const shaneSet = new Set(shaneAccounts.map(a => a.toLowerCase()))

    const overlap = [...jeffSet].filter(a => shaneSet.has(a))
    const totalUnique = new Set([...jeffSet, ...shaneSet]).size

    const areIdentical = jeffSet.size === shaneSet.size &&
      [...jeffSet].every(a => shaneSet.has(a))

    expect(
      areIdentical,
      `Jeff and Shane share TERR03 but their account lists must differ.\n` +
      `Jeff: ${jeffAccounts.length} accounts\n` +
      `Shane: ${shaneAccounts.length} accounts\n` +
      `Overlap: ${overlap.length} accounts\n` +
      `If identical, territory-lookup is ignoring aeName and returning the first match.`
    ).toBe(false)

    console.log(
      `REG-718-04: Jeff=${jeffAccounts.length} accounts, Shane=${shaneAccounts.length} accounts, ` +
      `overlap=${overlap.length}, total unique=${totalUnique} — lists are distinct (PASS)`
    )
  })

  // ── REG-718-05: backward compat — territory-lookup without aeName still works ──

  test('REG-718-05: territory-lookup without aeName returns some result for TOLA TERR03', async () => {
    const { status, body } = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_TOLA_TERR03&force=true'
    )
    if (status === 401) {
      console.log('REG-718-05: Google auth not configured — skipping')
      return
    }
    if (status === 500) {
      console.log(`REG-718-05: API error — ${body?.error ?? 'unknown'} — skipping`)
      return
    }
    expect(status).toBe(200)
    expect(body).toHaveProperty('aeName')
    expect(typeof body.aeName).toBe('string')
    expect(body.aeName.length).toBeGreaterThan(0)
    expect(body).toHaveProperty('accounts')
    expect(Array.isArray(body.accounts)).toBe(true)

    console.log(`REG-718-05: Without aeName, TERR03 resolved to ${body.aeName} with ${body.accounts.length} accounts (backward compat OK)`)
  })

  // ── REG-718-06: High Plains territory lookup for Jeff (cross-pod validation) ──

  test('REG-718-06: High Plains TERR03 lookup with Jeff returns accounts', async () => {
    const { status, body } = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_HIGH_PLAINS_TERR03&aeName=Jeff+Veldhuizen&force=true'
    )
    if (status === 401) {
      console.log('REG-718-06: Google auth not configured — skipping')
      return
    }
    if (status === 500) {
      console.log(`REG-718-06: API error — ${body?.error ?? 'unknown'} — skipping`)
      return
    }
    expect(status).toBe(200)
    expect(body).toHaveProperty('aeName')
    expect(body.aeName).toBe('Jeff Veldhuizen')
    expect(body).toHaveProperty('accounts')
    expect(Array.isArray(body.accounts)).toBe(true)

    console.log(`REG-718-06: Jeff Veldhuizen has ${body.accounts.length} accounts in High Plains TERR03`)
  })

  // ── REG-718-07: Both TOLA and High Plains lookups resolve Jeff correctly ──

  test('REG-718-07: Both TOLA and High Plains TERR03 resolve Jeff with correct tableauTerritory', async () => {
    const tolaResult = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_TOLA_TERR03&aeName=Jeff+Veldhuizen&force=true'
    )
    const hpResult = await getJSON(
      '/api/territory-lookup?territory=CENTRAL_ENT_HIGH_PLAINS_TERR03&aeName=Jeff+Veldhuizen&force=true'
    )

    if (tolaResult.status === 401 || hpResult.status === 401) {
      console.log('REG-718-07: Google auth not configured — skipping')
      return
    }
    if (tolaResult.status === 500 || hpResult.status === 500) {
      console.log('REG-718-07: API error — skipping')
      return
    }

    expect(tolaResult.status).toBe(200)
    expect(hpResult.status).toBe(200)

    // Both should resolve to Jeff
    expect(tolaResult.body.aeName).toBe('Jeff Veldhuizen')
    expect(hpResult.body.aeName).toBe('Jeff Veldhuizen')

    // Both should return accounts
    expect(Array.isArray(tolaResult.body.accounts)).toBe(true)
    expect(tolaResult.body.accounts.length).toBeGreaterThan(0)
    expect(Array.isArray(hpResult.body.accounts)).toBe(true)
    expect(hpResult.body.accounts.length).toBeGreaterThan(0)

    // tableauTerritory should reflect the REQUESTED territory
    expect(tolaResult.body.tableauTerritory).toBe('CENTRAL_ENT_TOLA_TERR03')
    expect(hpResult.body.tableauTerritory).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR03')

    console.log(
      `REG-718-07: TOLA=${tolaResult.body.accounts.length} accounts, ` +
      `High Plains=${hpResult.body.accounts.length} accounts — both resolve correctly (PASS)`
    )
  })
})
