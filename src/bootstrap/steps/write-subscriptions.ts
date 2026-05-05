/**
 * BKL-ARCH-01 (issue #54) — Step 4: Write Subscriptions Sheet.
 *
 * Code-move from src/bootstrap-orchestrator.ts (the inner IIFE around lines 1496-1529).
 * Writes the SF bookings results (collected by Step 3) to the AE's Google
 * Subscriptions sheet ("Supportable — {aeName}"). Reuses an existing sheet ID
 * via aes.json or Drive find-by-name. Patches AE config with the resulting ID.
 * Warms the per-customer normalized-rows cache from in-memory data.
 *
 * BKL-CANCEL-STEP3-OVERLAP preserved: this step's watchdog (the runner's tid for
 * step 3) only starts when execute is called — the previous SF read step had
 * its own watchdog already cleared by the runner before we begin.
 */
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../../google.ts'
import { aes, patchAe } from '../../server-state.ts'
import { writeSubscriptionSheet } from '../../supportable-scraper.ts'
import { writeSheetCache } from '../../cache-layer.ts'
import { normalizeRows } from '../../sheets.ts'
import { findExistingSheet } from '../helpers.ts'
import type { BootstrapStepDef, BootstrapContext } from './types.ts'

export const writeSubscriptionsStep: BootstrapStepDef = {
  name: 'Write Subscriptions Sheet',

  preconditions(ctx: BootstrapContext): boolean {
    // Skipped when Drive folder creation failed OR no SF bookings data was read.
    return !!ctx.aeFolderId && ctx.sfBookingsResults.length > 0
  },

  preconditionsSkipDetail(ctx: BootstrapContext): string {
    if (!ctx.aeFolderId) return 'Skipped: Drive folder creation failed'
    return 'Skipped: no SF bookings results'
  },

  async execute(ctx: BootstrapContext): Promise<void> {
    const { aeName, aeFolderId, sfBookingsResults } = ctx

    ctx.setStep(3, 'running', 'writing to Google Sheet…')
    const existingSupportableId = aes.find(a => a.name === aeName)?.subscriptionSheetId
      ?? (aeFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), aeFolderId, `Supportable — ${aeName}`) : null)
      ?? null
    if (existingSupportableId) {
      console.log(`[auto-bootstrap] Subscription sheet found/reusing: ${existingSupportableId}`)
    }
    const sheetId = await writeSubscriptionSheet(
      sfBookingsResults,
      aeName,
      aeFolderId || undefined,
      existingSupportableId || undefined,
    )
    patchAe(aeName, { subscriptionSheetId: sheetId })
    ctx.resources.supportableSheet = {
      id: sheetId,
      url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    }
    // Warm sheet cache immediately from in-memory data — no extra API calls needed.
    for (const result of sfBookingsResults) {
      if (result.rows.length > 0) {
        const normalized = normalizeRows(result.rows, result.customerName)
        if (normalized.length > 0) writeSheetCache(result.customerName, normalized)
      }
    }
    ctx.setStep(3, 'done', `Sheet: ${sheetId}`)
    console.log(`[auto-bootstrap] Subscription sheet ${existingSupportableId ? 'updated' : 'created'}: ${sheetId}`)
  },
}
