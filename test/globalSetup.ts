/**
 * Playwright global setup — BKL-TEST-19: Stale fixture detection.
 *
 * Fetches live /api/aes and compares the first AE's key IDs against the
 * hardcoded values in test/fixtures.ts (CAROLANNE constant). Logs a warning
 * if they differ — does NOT fail the suite, since the live AE config may
 * legitimately change between sessions.
 *
 * To suppress the warning, update the CAROLANNE constant in test/fixtures.ts
 * to match the live values.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

// Mirrors the CAROLANNE constant in fixtures.ts — update both together.
// BKL-TEST-FIXTURE-DRIFT-01: Re-pointed from "Carolanne Farrell" (no longer
// in roster) to "TBH" — first AE in data/config/aes.json with full config.
const FIXTURE_CAROLANNE = {
  name: 'TBH',
  sfReportId: '00OPe00000k5m9ZMAQ',
  supportableSheetId: '1HcGqHoR6tsK-dK2hipC3vwNMu8I_OV27OixwgOsEixY',
  pipelineSheetId: '1uLUThdFEz_WTfePNP40V_y5ES8TJTbTMCecwbtdDcLk',
  ccspSheetId: '1me9Vz4rTpo2g9dz11vsVLuxAq77MlZ9t__07CPds-Bc',
}

export default async function globalSetup() {
  try {
    const res = await fetch(`${BASE}/api/aes`)
    if (!res.ok) {
      console.warn(`[globalSetup] Could not fetch /api/aes (status ${res.status}) — fixture staleness check skipped`)
      return
    }

    const data = await res.json()
    const aes: Array<Record<string, unknown>> = data.aes ?? []

    if (aes.length === 0) {
      console.warn('[globalSetup] No AEs returned from /api/aes — fixture staleness check skipped (empty dataset)')
      return
    }

    // Find Carolanne in the live AE list
    const liveCarolanne = aes.find((ae) => ae.name === FIXTURE_CAROLANNE.name)
    if (!liveCarolanne) {
      console.warn(
        `[globalSetup] FIXTURE DRIFT: AE "${FIXTURE_CAROLANNE.name}" not found in live data. ` +
        `Live AEs: ${aes.map((a) => a.name).join(', ')}. ` +
        'Update CAROLANNE constant in test/fixtures.ts.'
      )
      return
    }

    // Check each key ID field
    const fieldsToCheck: Array<keyof typeof FIXTURE_CAROLANNE> = [
      'sfReportId', 'supportableSheetId', 'pipelineSheetId', 'ccspSheetId',
    ]
    const drifted: string[] = []
    for (const field of fieldsToCheck) {
      if (liveCarolanne[field] !== FIXTURE_CAROLANNE[field]) {
        drifted.push(`${field}: fixture="${FIXTURE_CAROLANNE[field]}" live="${liveCarolanne[field]}"`)
      }
    }

    if (drifted.length > 0) {
      console.warn(
        '[globalSetup] FIXTURE DRIFT DETECTED — hardcoded IDs in test/fixtures.ts differ from live data:\n' +
        drifted.map((d) => `  ${d}`).join('\n') +
        '\nUpdate the CAROLANNE constant in test/fixtures.ts to suppress this warning.'
      )
    }
  } catch (e) {
    console.warn(`[globalSetup] Fixture staleness check failed (server may be down): ${e}`)
  }
}
