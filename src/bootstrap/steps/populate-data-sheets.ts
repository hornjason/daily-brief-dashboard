/**
 * BKL-ARCH-01 (issue #54) — Step 5: Populate Data Sheets via l3-bootstrap.
 *
 * Code-move from src/bootstrap-orchestrator.ts (the inner IIFE around lines 1533-1681).
 * Calls bootstrapAeL3 with a Drive-only client/reader shim (no browser, no
 * Tableau, no SF OAuth — BKL-ARCH-L4-SPLIT) to create CCSP, Pipeline, and
 * SF Bookings sheets. Patches AE config with the three sheet IDs and records
 * resources on autoBootstrapState.resources. Triggers a fire-and-forget
 * pipeline cache refresh.
 *
 * Watchdog timeout for this step is 60_000 ms (vs the 90_000 default) — set via
 * `timeoutMs` so the runner uses the shorter window. l3-bootstrap is local
 * Drive work only; longer waits indicate a stuck network call we want to fail
 * fast on.
 */
import { google as googApis } from 'googleapis'
import { readFileSync } from 'fs'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../../google.ts'
import { customers, patchAe } from '../../server-state.ts'
import { bootstrapAe as bootstrapAeL3, type AeBootstrapDeps } from '../../l3-bootstrap.ts'
import { refreshPipeline } from '../../refresh-engine.ts'
import { normalizeSettings } from '../../region-config.ts'
import { findExistingSheet, SETTINGS_PATH } from '../helpers.ts'
import type { BootstrapStepDef, BootstrapContext } from './types.ts'

export const populateDataSheetsStep: BootstrapStepDef = {
  name: 'Populate Data Sheets',
  timeoutMs: 60_000,

  preconditions(ctx: BootstrapContext): boolean {
    return !!ctx.aeFolderId
  },

  preconditionsSkipDetail(): string {
    return 'Skipped: Drive folder creation failed'
  },

  async execute(ctx: BootstrapContext): Promise<void> {
    const { aeName, aeFolderId, customerNames, sfReportId, tableauTerritories } = ctx

    // BKL-ARCH-L4-SPLIT: Hero install uses l3-bootstrap — no browser, no
    // Tableau, no SF OAuth. Build a minimal Drive client shim that wraps
    // googleapis for l3-bootstrap.
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const driveApi = googApis.drive({ version: 'v3', auth })
    const sheetsApi = googApis.sheets({ version: 'v4', auth })

    const l3DriveClient = {
      async createFolder(name: string, parentId: string): Promise<string> {
        const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const existing = await driveApi.files.list({
          q: `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }).catch(() => ({ data: { files: [] } }))
        if (existing.data.files?.length) return existing.data.files[0].id!
        const created = await withQuotaRetry(
          () => driveApi.files.create({
            requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            supportsAllDrives: true,
            fields: 'id',
          }),
          `createFolder:${name}`,
        )
        return created.data.id!
      },
      async createSheet(name: string, parentFolderId: string): Promise<string> {
        const existing = await findExistingSheet(driveApi, parentFolderId, name)
        if (existing) return existing
        const created = await withQuotaRetry(
          () => driveApi.files.create({
            requestBody: {
              name,
              mimeType: 'application/vnd.google-apps.spreadsheet',
              parents: [parentFolderId],
            },
            supportsAllDrives: true,
            fields: 'id',
          }),
          `createSheet:${name}`,
        )
        return created.data.id!
      },
      async writeRows(sheetId: string, rows: string[][]): Promise<void> {
        if (!rows.length) return
        await withQuotaRetry(
          () => sheetsApi.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: 'Sheet1!A1',
            valueInputOption: 'RAW',
            requestBody: { values: rows },
          }),
          `writeRows:${sheetId}`,
        )
      },
    }

    const l3DataReader = {
      async readSfBookings(cfg: { podId: string; aeName: string; customerNames: string[] }): Promise<string[][]> {
        try {
          const { fetchSfBookingsRaw, deriveSfCustomersByTerritory, listPodBookingSheets, matchPodSheet } = await import('../../sf-bookings-reader.ts')
          const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
          const normalized = normalizeSettings(rawSettings)
          const podKey = cfg.podId?.replace(/_TERR\d+$/, '')
          const region = normalized.regions.find((r: any) => podKey in (r.pods ?? {})) ?? normalized.regions[0]
          const folderId = region?.podBookingsFolderId
          if (!folderId) return [['Account Name', 'AE', 'Region']]
          const podSheets = await listPodBookingSheets(folderId)
          const podSheetId = matchPodSheet(podSheets, tableauTerritories.length > 0 ? tableauTerritories : [cfg.podId])
          if (!podSheetId) return [['Account Name', 'AE', 'Region']]
          const rawSfData = await fetchSfBookingsRaw(podSheetId)
          const existingCustomers = customers.filter(cx => cx.ae === cfg.aeName && !cx.inactive)
          const { results } = deriveSfCustomersByTerritory(
            rawSfData,
            tableauTerritories.length > 0 ? tableauTerritories : [cfg.podId],
            existingCustomers,
            cfg.aeName,
            false,
          )
          const header = ['Account Name', 'AE', 'Subscription Count']
          const rows: string[][] = [header]
          for (const r of results) {
            rows.push([r.customerName, cfg.aeName, String(r.rows.length)])
          }
          return rows
        } catch (e: any) {
          console.warn(`[l3-bootstrap] SF bookings L3 read failed: ${e?.message}`)
          return [['Account Name', 'AE', 'Subscription Count']]
        }
      },
      async readCcsp(_cfg: { podId: string; aeName: string; customerNames: string[] }): Promise<string[][]> {
        const header = ['Account Name', 'Cloud Partner', 'ACV+', 'Quarter']
        return [header]
      },
      async readPipeline(_cfg: { podId: string; aeName: string; customerNames: string[] }): Promise<string[][]> {
        const header = ['Account Name', 'Opportunity', 'Stage', 'ACV', 'Close Date']
        return [header]
      },
    }

    const l3Deps: AeBootstrapDeps = { driveClient: l3DriveClient, l3Reader: l3DataReader }
    const l3Result = await bootstrapAeL3({
      region: '',
      podId: tableauTerritories[0]?.replace(/_TERR\d+$/, '') ?? '',
      territoryCode: tableauTerritories[0] ?? '',
      aeName,
      customerNames,
      parentFolderId: aeFolderId,
      sfReportId,
    }, l3Deps)

    patchAe(aeName, {
      ccspSheetId: l3Result.ccspSheetId,
      pipelineSheetId: l3Result.pipelineSheetId,
      subscriptionSheetId: l3Result.sfBookingsSheetId,
    })

    ctx.resources.ccspSheet = {
      id: l3Result.ccspSheetId,
      url: `https://docs.google.com/spreadsheets/d/${l3Result.ccspSheetId}/edit`,
    }
    ctx.resources.pipelineSheet = {
      id: l3Result.pipelineSheetId,
      url: `https://docs.google.com/spreadsheets/d/${l3Result.pipelineSheetId}/edit`,
    }
    ctx.resources.supportableSheet = {
      id: l3Result.sfBookingsSheetId,
      url: `https://docs.google.com/spreadsheets/d/${l3Result.sfBookingsSheetId}/edit`,
    }

    if (l3Result.unmatchedCustomers.length > 0) {
      ctx.resources.unmatchedCustomers = l3Result.unmatchedCustomers
      console.warn(`[auto-bootstrap] l3-bootstrap: ${l3Result.unmatchedCustomers.length} unmatched customers: ${l3Result.unmatchedCustomers.join(', ')}`)
    }

    ctx.setStep(4, 'done', `3 sheets created (CCSP, Pipeline, SF Bookings)`)
    console.log(`[auto-bootstrap] l3-bootstrap complete for ${aeName}: ccsp=${l3Result.ccspSheetId} pipeline=${l3Result.pipelineSheetId} sfBookings=${l3Result.sfBookingsSheetId}`)

    refreshPipeline().catch(e => console.warn('[auto-bootstrap] post-bootstrap pipeline cache refresh failed:', e.message))
  },
}
