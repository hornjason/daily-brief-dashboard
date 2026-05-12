/**
 * BKL-ARCH-01 (issue #54) — Step 2: Read SF Bookings Sheet.
 *
 * Resolves the POD bookings sheet from settings.json → region →
 * podBookingsFolderId → matchPodSheet, then reads subscription data via
 * fetchSfBookingsRaw + deriveSfCustomersByTerritory and upserts customers.
 */
import { readFileSync } from 'fs'
import { customers, CUSTOMERS_PATH } from '../../server-state.ts'
import { writeJsonAtomic } from '../../lib/atomic-write.ts'
import { normalizeSettings } from '../../region-config.ts'
import { fetchSfBookingsRaw, deriveSfCustomersByTerritory, listPodBookingSheets, matchPodSheet } from '../../sf-bookings-reader.ts'
import { SETTINGS_PATH } from '../helpers.ts'
import type { BootstrapStepDef, BootstrapContext } from './types.ts'

export const readSfBookingsStep: BootstrapStepDef = {
  name: 'Read SF Bookings Sheet',

  preconditions(ctx: BootstrapContext): boolean {
    return !!ctx.aeName && !!ctx.tableauTerritories.length
  },

  async execute(ctx: BootstrapContext): Promise<void> {
    const { aeName, tableauTerritories } = ctx

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
      ctx.setStep(2, 'skipped', 'No SF bookings sheet found for this territory — add sheet to shared folder to enable')
      console.warn(`[auto-bootstrap] No POD sheet found for ${aeName} (territories: ${tableauTerritories.join(', ')}) — skipping`)
      return
    }

    try {
      ctx.setStep(2, 'running', `reading SF bookings sheet…`)
      console.log(`[auto-bootstrap] Using SF bookings sheet ${podSheetId} for ${aeName} (territories: ${tableauTerritories.join(', ')})`)

      const rawSfData = await fetchSfBookingsRaw(podSheetId)
      const existingCustomers = customers.filter(cx => cx.ae === aeName)

      // BKL-BOOTSTRAP-CUSTOMER-FOLDER-DEDUP-01: On a fresh install, existingCustomers is empty
      // because createCustomerFoldersStep intentionally does NOT write territory-sheet names into
      // customers.json. Build virtual Customer records from ctx.customerNames so that SF legal
      // names ("Greenheck Fan Corporation") fuzzy-match the territory names already created in
      // step 1 and don't produce duplicate Drive folders.
      const customerFolderMap = ctx.resources.customerFolders ?? {}
      const territoryVirtuals = (ctx.customerNames ?? [])
        .filter(name => !existingCustomers.some(ec => ec.name === name))
        .map(name => ({
          name,
          ae: aeName,
          importedFrom: 'territory' as const,
          driveFolderId: customerFolderMap[name]?.id ?? '',
          accountNumbers: [] as string[],
        }))

      const { results, matched, newCustomers, aliasedCustomers, ccspOnly } = deriveSfCustomersByTerritory(
        rawSfData, tableauTerritories, [...existingCustomers, ...territoryVirtuals], aeName, false,
      )

      for (const nc of newCustomers) {
        if (!customers.some(c => c.name === nc.name)) {
          customers.push(nc)
          console.log(`[auto-bootstrap] SF new customer: ${nc.name}`)
        }
      }

      // BKL-BOOTSTRAP-CUSTOMER-FOLDER-DEDUP-01: Upsert territory-virtual customers that received
      // SF subscription data into customers.json.
      for (const tv of territoryVirtuals) {
        if (results.some(r => r.customerName === tv.name) && !customers.some(c => c.name === tv.name)) {
          customers.push({ ...tv, importedFrom: 'sf-bookings' })
          console.log(`[auto-bootstrap] Territory customer promoted to sf-bookings: ${tv.name}`)
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

      ctx.setStep(2, 'done', `${matched.length}/${results.length} customers with subscriptions`)
      console.log(`[auto-bootstrap] SF bookings: ${matched.length} matched, ${newCustomers.length} new, ${ccspOnly.length} CCSP-only`)
    } catch (e: any) {
      console.error('[auto-bootstrap] SF bookings read failed:', e.message)
      throw e
    }
  },
}
