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
// BKL-HERO-04: Updated 2026-05-02 — re-pointed to "Carolanne Farrell" (live prod AE).
const FIXTURE_CAROLANNE = {
  name: 'Carolanne Farrell',
  sfReportId: '00OPe00000isU2zMAE',
  subscriptionSheetId: '150e3-q-8_6Uy3qnLhL-ARBVHyVy29P7tnAuFjxkkuCg',
  pipelineSheetId: '10H8Nl8oQQg1x9Zt0p5cys7JJp0b4ObfzhB-pPMot3BM',
  ccspSheetId: '1G8VIkKca9vmLBTsSBrBjE6OWeO2_jbXhNHSHIaGFSUw',
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
      'sfReportId', 'subscriptionSheetId', 'pipelineSheetId', 'ccspSheetId',
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
