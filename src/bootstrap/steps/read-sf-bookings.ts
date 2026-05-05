/**
 * BKL-ARCH-01 (issue #54) — Step 3: Read SF Bookings Sheet.
 *
 * Code-move from src/bootstrap-orchestrator.ts (the inner IIFE around lines 1368-1492).
 * Includes both the POD bookings sheet resolution (settings.json → region →
 * podBookingsFolderId → matchPodSheet) AND the L2/L3 cache hierarchy read.
 *
 * BKL-INGEST-02: 4-level cache hierarchy preserved exactly.
 *   L2 = AE Supportable sheet modifiedTime < 24h → read rows directly
 *   L3 = POD-level SF bookings sheet via fetchSfBookingsRaw()
 *
 * Cross-step status: when no POD bookings sheet is found, the original code
 * marks BOTH step 2 (this step, "Read SF Bookings") AND step 3 (next step,
 * "Write Subscriptions") as 'skipped'. We preserve that — `execute` calls
 * `ctx.setStep(3, 'skipped', …)` directly so the runner observes step 3 in a
 * terminal state and skips it.
 *
 * Same cross-step pattern on error: original called setStep(2,'error') AND
 * setStep(3,'error', 'SF sheet read failed — no results to write'). We mirror
 * by pre-marking step 3 in catch, then rethrowing so runner records step 2 error.
 */
import { readFileSync } from 'fs'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../../google.ts'
import { aes, customers, CUSTOMERS_PATH } from '../../server-state.ts'
import { writeJsonAtomic } from '../../lib/atomic-write.ts'
import { normalizeSettings } from '../../region-config.ts'
import { fetchSfBookingsRaw, deriveSfCustomersByTerritory, listPodBookingSheets, matchPodSheet } from '../../sf-bookings-reader.ts'
import {
  CACHE_HIER_FRESH_MS,
  getSheetModifiedTime,
  readSfBookingsFromAeSheet,
} from '../../lib/cache-hierarchy.ts'
import { emitCacheLevel } from '../../ingest-events.js'
import { findExistingSheet, SETTINGS_PATH } from '../helpers.ts'
import type { BootstrapStepDef, BootstrapContext } from './types.ts'

export const readSfBookingsStep: BootstrapStepDef = {
  name: 'Read SF Bookings Sheet',

  preconditions(ctx: BootstrapContext): boolean {
    // Always run — the step itself decides whether a POD sheet is available
    // and pre-marks step 3 as skipped if not.
    return !!ctx.aeName && !!ctx.tableauTerritories.length
  },

  async execute(ctx: BootstrapContext): Promise<void> {
    const { aeName, tableauTerritories, aeFolderId } = ctx

    // ── Resolve POD bookings sheet from settings.json ──────────────────────
    // BKL-UX90: Read from regions[].podBookingsFolderId via normalizeSettings —
    // the flat root config's bookings folder field may hold the parent folder
    // ID (not the bookings folder).
    let podSheetId: string | null = null
    try {
      const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
      const normalized = normalizeSettings(rawSettings)
      const podKey = tableauTerritories[0]?.replace(/_TERR\d+$/, '')
      const region = podKey
        ? (normalized.regions.find(r => podKey in r.pods) ?? normalized.regions[0])
        : normalized.regions[0]
      const folderId = region?.podBookingsFolderId
      if (folderId) {
        const podSheets = await listPodBookingSheets(folderId)
        podSheetId = matchPodSheet(podSheets, tableauTerritories)
        if (podSheetId) {
          const matched = podSheets.find(s => s.sheetId === podSheetId)
          console.log(`[auto-bootstrap] Resolved POD sheet for ${aeName}: "${matched?.displayName}" (${podSheetId})`)
        }
      }
    } catch { /* no settings file or Drive error — fall back below */ }

    ctx.podSheetId = podSheetId

    if (!podSheetId) {
      // No POD sheet found for this AE's territory — skip subscription steps.
      // This app only processes PODs that have a sheet in the shared Drive folder.
      ctx.setStep(2, 'skipped', 'No SF bookings sheet found for this territory — add sheet to shared folder to enable')
      ctx.setStep(3, 'skipped', 'Skipped: no SF bookings sheet')
      console.warn(`[auto-bootstrap] No POD sheet found for ${aeName} (territories: ${tableauTerritories.join(', ')}) — skipping subscription steps`)
      return
    }

    // ── SF Bookings path — L2/L3 cache hierarchy ───────────────────────────
    try {
      ctx.setStep(2, 'running', `reading SF bookings sheet…`)
      console.log(`[auto-bootstrap] Using SF bookings sheet ${podSheetId} for ${aeName} (territories: ${tableauTerritories.join(', ')})`)

      // Cold-start guard — if customers.json was wiped we must re-derive even on a fresh L2 hit.
      const aeHasCustomers = customers.some(cx => cx.ae === aeName && !cx.inactive)

      // L2 probe — if AE's existing Supportable sheet is <24h old, read from it and skip L3.
      const existingSupportableIdForL2 = aes.find(a => a.name === aeName)?.subscriptionSheetId
        ?? (aeFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), aeFolderId, `Supportable — ${aeName}`) : null)
        ?? null
      let l2Results: Awaited<ReturnType<typeof readSfBookingsFromAeSheet>> = null
      if (existingSupportableIdForL2) {
        const supMt = await getSheetModifiedTime(existingSupportableIdForL2)
        if (supMt && (Date.now() - supMt.getTime()) < CACHE_HIER_FRESH_MS) {
          l2Results = await readSfBookingsFromAeSheet(existingSupportableIdForL2)
          if (l2Results && l2Results.length > 0) {
            const rowCount = l2Results.reduce((n, r) => n + r.rows.length, 0)
            console.log(`[bootstrap] ${aeName}: SF bookings cache L2 hit (AE Supportable sheet) — ${l2Results.length} customers, ${rowCount} rows${aeHasCustomers ? '' : ' (cold start — will re-derive from L3)'}`)
            emitCacheLevel({ ae: aeName, flow: 'sfBookings', level: 2, rowCount })
            ctx.sfBookingsResults = l2Results
            ctx.setStep(2, 'done', `${l2Results.length} customers from L2 cache (AE sheet)`)
            // Short-circuit — no L3 read, no customers.json upsert (prior run already wrote customers).
            // Guard: aeHasCustomers ensures this path only fires when customers.json already
            // has this AE's data. On cold start (empty customers.json), fall through to L3.
            // Step 4 (write Supportable sheet) still runs with the L2 results.
          } else {
            console.log(`[bootstrap] ${aeName}: SF bookings L2 read returned no rows — falling through to L3`)
            emitCacheLevel({ ae: aeName, flow: 'sfBookings', level: 3 })
          }
        } else {
          const ageH = supMt ? Math.round((Date.now() - supMt.getTime()) / 3_600_000) : null
          console.log(`[bootstrap] ${aeName}: SF bookings cache L2 stale (${ageH ?? '?'}h) — falling through to L3`)
          emitCacheLevel({ ae: aeName, flow: 'sfBookings', level: 3 })
        }
      }

      if (l2Results && l2Results.length > 0 && aeHasCustomers) {
        // L2 hit — skip L3 read + customer derivation. Continue to step 4 (sheet write).
      } else {
        const rawSfData = await fetchSfBookingsRaw(podSheetId)
        const existingCustomers = customers.filter(cx => cx.ae === aeName && !cx.inactive)
        const { results, matched, newCustomers, aliasedCustomers, ccspOnly } = deriveSfCustomersByTerritory(
          rawSfData, tableauTerritories, existingCustomers, aeName, false,
        )

        // Upsert net-new and alias-updated customers into customers array + disk
        for (const nc of newCustomers) {
          if (!customers.some(c => c.name === nc.name)) {
            customers.push(nc)
            console.log(`[auto-bootstrap] SF new customer: ${nc.name}`)
          }
        }
        for (const ac of aliasedCustomers) {
          const idx = customers.findIndex(c => c.name === ac.name)
          if (idx !== -1) customers[idx] = ac
        }
        for (const name of ccspOnly) {
          const cx = customers.find(c => c.name === name)
          if (cx) cx.ccspCustomer = true
        }
        writeJsonAtomic(CUSTOMERS_PATH, { customers })

        ctx.sfBookingsResults = results
        ctx.setStep(2, 'done', `${matched.length}/${results.length} customers with subscriptions`)
        console.log(`[auto-bootstrap] SF bookings: ${matched.length} matched, ${newCustomers.length} new, ${ccspOnly.length} CCSP-only`)
      }
    } catch (e: any) {
      // BKL-CANCEL-STEP3-OVERLAP: pre-mark step 3 as error so runner skips it.
      ctx.setStep(3, 'error', 'SF sheet read failed — no results to write')
      console.error('[auto-bootstrap] SF bookings read failed:', e.message)
      throw e
    }
  },
}
