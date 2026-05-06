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
      async createFolder(_name: string, _parentId: string): Promise<string> {
        // BKL-BOOTSTRAP-AE-FOLDER-LOCATION-01: step 1 already created the AE folder.
        // Returning aeFolderId directly prevents step 5 from creating a duplicate
        // folder in the wrong parent (parentFolderId vs parentFolderId/podName/).
        return aeFolderId
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
        const sheetId = created.data.id!
        // Rename the default "Sheet1" tab so downstream readers find the right tab name:
        //   Pipeline → "Pipeline" (fetchPipelineData reads "Pipeline!A1:Z5000")
        //   CCSP     → "CCSP Data" (fetchCCSPData KnownSheetResolver reads "CCSP Data")
        const tabName = name === 'Pipeline' ? 'Pipeline' : name === 'CCSP' ? 'CCSP Data' : null
        if (tabName) {
          await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId })
            .then(async meta => {
              const firstSheet = meta.data.sheets?.[0]
              if (firstSheet?.properties?.sheetId != null) {
                await sheetsApi.spreadsheets.batchUpdate({
                  spreadsheetId: sheetId,
                  requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: firstSheet.properties!.sheetId, title: tabName }, fields: 'title' } }] },
                })
              }
            })
            .catch(() => {})
        }
        return sheetId
      },
      async writeRows(sheetId: string, rows: string[][]): Promise<void> {
        if (!rows.length) return
        await withQuotaRetry(
          () => sheetsApi.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: 'A1',
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
        try {
          const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
          const normalized = normalizeSettings(rawSettings)
          const podKey = (_cfg.podId ?? '').replace(/_TERR\d+$/, '')
          const region = normalized.regions.find((r: any) => podKey in (r.pods ?? {})) ?? normalized.regions[0]
          const folderId = region?.podBookingsFolderId
          if (!folderId) return [header]

          const listRes = await driveApi.files.list({
            q: `name contains 'CCSP-${podKey}-' and '${folderId}' in parents and trashed = false`,
            fields: 'files(id, name, modifiedTime)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            orderBy: 'modifiedTime desc',
            pageSize: 5,
          }).catch(() => ({ data: { files: [] } }))
          const csvFile = (listRes.data.files ?? [])[0]
          if (!csvFile?.id) {
            // BKL-BOOTSTRAP-L3-DATA-GATE-01: hard gate — creating an empty sheet is misleading
            throw new Error(`CCSP data not found for pod '${podKey}' in L3 folder ${folderId} — run Mac Mini L4 CCSP scrape first, then re-bootstrap`)
          }

          const dlRes = await withQuotaRetry(
            () => driveApi.files.get({ fileId: csvFile.id!, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }),
            `readCcsp:download:${csvFile.id}`,
          )
          const csvText = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data)
          const { parseCsvToObjects } = await import('../../csv-parse.ts')
          const rawRows = parseCsvToObjects(csvText)
          if (rawRows.length === 0) return [header]

          // Territory-only filter — no quarter filter for bootstrap (avoids dependency on rolling window)
          let filtered = rawRows
          if (tableauTerritories.length > 0) {
            const terrSet = new Set(tableauTerritories)
            const terrCol = Object.keys(rawRows[0]).find(k => {
              const norm = k.toLowerCase().replace(/\s+/g, ' ').trim()
              return norm === 'account territory name' || norm === 'account territory'
            })
            if (terrCol) filtered = rawRows.filter(r => terrSet.has((r[terrCol] ?? '').trim()))
          }

          if (filtered.length === 0) return [header]

          const csvHeaders = Object.keys(filtered[0])
          const rows: string[][] = [csvHeaders]
          for (const row of filtered) rows.push(csvHeaders.map(h => row[h] ?? ''))
          console.log(`[l3-bootstrap] CCSP: ${filtered.length} rows from ${csvFile.name}`)
          return rows
        } catch (e: any) {
          // BKL-BOOTSTRAP-L3-DATA-GATE-01: re-throw gate errors — they are intentional
          // failures, not transient network issues. Only swallow genuine API/parse failures.
          if ((e as Error)?.message?.startsWith('CCSP data not found')) throw e
          console.warn(`[l3-bootstrap] CCSP L3 read failed: ${e?.message}`)
          return [header]
        }
      },
      async readPipeline(_cfg: { podId: string; aeName: string; customerNames: string[] }): Promise<string[][]> {
        const header = [
          'Opportunity ID', 'Opportunity Number', 'Account Name', 'Opportunity Name',
          'ACV Opportunity', 'Close Date', 'Forecast Category', 'Opportunity Owner',
          'Offering Group', 'Product Code', 'Opportunity Pod', 'Product Description',
          'Renewal', 'Opportunity Territory Name',
        ]
        try {
          const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
          const normalized = normalizeSettings(rawSettings)
          const podKey = (_cfg.podId ?? '').replace(/_TERR\d+$/, '')
          const region = normalized.regions.find((r: any) => podKey in (r.pods ?? {})) ?? normalized.regions[0]
          const folderId = region?.podBookingsFolderId
          if (!folderId) return [header]

          // Search by podKey (pod is in the filename regardless of which SF report generated it).
          // Filename format: SF-PIPELINE-{reportId}-{podKey}-{date}.csv — the podKey appears
          // after the reportId so we must search for it as a substring, not a prefix.
          const podKeySearch = podKey ? `-${podKey}-` : ''
          const baseQuery = `name contains 'SF-PIPELINE-' and '${folderId}' in parents and trashed = false`
          const narrowQuery = podKeySearch ? `${baseQuery} and name contains '${podKeySearch}'` : baseQuery
          const listRes = await driveApi.files.list({
            q: narrowQuery,
            fields: 'files(id, name, modifiedTime)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            orderBy: 'modifiedTime desc',
            pageSize: 5,
          }).catch(() => ({ data: { files: [] } }))
          // Fall back to any SF-PIPELINE file in the folder if pod-specific search returns nothing
          const files = listRes.data.files ?? []
          const fallbackFiles = files.length === 0 && podKeySearch ? (await driveApi.files.list({
            q: baseQuery,
            fields: 'files(id, name, modifiedTime)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            orderBy: 'modifiedTime desc',
            pageSize: 5,
          }).catch(() => ({ data: { files: [] } }))).data.files ?? [] : []
          const csvFile = files[0] ?? fallbackFiles[0]
          if (!csvFile?.id) {
            // BKL-BOOTSTRAP-L3-DATA-GATE-01: hard gate — creating an empty sheet is misleading
            throw new Error(`Pipeline data not found for pod '${podKey}' in L3 folder ${folderId} — run Mac Mini L4 SF pipeline scrape first, then re-bootstrap`)
          }

          const dlRes = await withQuotaRetry(
            () => driveApi.files.get({ fileId: csvFile.id!, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }),
            `readPipeline:download:${csvFile.id}`,
          )
          const csvText = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data)
          const { parseCsvToSfReport } = await import('../../csv-parse.ts')
          const { headers: parsedHeaders, rows: parsedRows } = parseCsvToSfReport(csvText)
          if (parsedRows.length === 0) return [header]

          // Territory filter
          let filtered = parsedRows
          if (tableauTerritories.length > 0) {
            const terrSet = new Set(tableauTerritories)
            const terrColIdx = parsedHeaders.indexOf('Opportunity Territory Name')
            if (terrColIdx >= 0) filtered = parsedRows.filter(row => terrSet.has((row[terrColIdx] ?? '').trim()))
          }

          if (filtered.length === 0) return [header]

          console.log(`[l3-bootstrap] Pipeline: ${filtered.length} rows from ${csvFile.name}`)
          return [parsedHeaders, ...filtered]
        } catch (e: any) {
          // BKL-BOOTSTRAP-L3-DATA-GATE-01: re-throw gate errors — they are intentional
          // failures, not transient network issues. Only swallow genuine API/parse failures.
          if ((e as Error)?.message?.startsWith('Pipeline data not found')) throw e
          console.warn(`[l3-bootstrap] Pipeline L3 read failed: ${e?.message}`)
          return [header]
        }
      },
    }

    const l3Deps: AeBootstrapDeps = { driveClient: l3DriveClient, l3Reader: l3DataReader }
    const l3Result = await bootstrapAeL3({
      region: '',
      podId: tableauTerritories[0]?.replace(/_TERR\d+$/, '') ?? '',
      territoryCode: tableauTerritories[0] ?? '',
      aeName,
      customerNames,
      parentFolderId: ctx.parentFolderId ?? aeFolderId,
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

    ctx.setStep(3, 'done', `3 sheets created (CCSP, Pipeline, SF Bookings)`)
    console.log(`[auto-bootstrap] l3-bootstrap complete for ${aeName}: ccsp=${l3Result.ccspSheetId} pipeline=${l3Result.pipelineSheetId} sfBookings=${l3Result.sfBookingsSheetId}`)

    refreshPipeline().catch(e => console.warn('[auto-bootstrap] post-bootstrap pipeline cache refresh failed:', e.message))
  },
}
