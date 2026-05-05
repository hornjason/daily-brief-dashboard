/**
 * BKL-ARCH-01 (issue #54) — Step 2: Create Customer Folders.
 *
 * Code-move from src/bootstrap-orchestrator.ts (the inner IIFE around line 1319).
 * For each customer name, find-or-create a subfolder inside the AE Drive folder
 * via driveClient.ensureChildFolder. Persists folder IDs to customers.json.
 *
 * Original behavior preserved exactly: per-folder failures are logged and the
 * loop continues; aggregate count is reported in the step detail.
 *
 * Skipped (via runner) when ctx.aeFolderId is empty — original code marked it
 * 'skipped' with detail "Skipped: Drive folder creation failed".
 */
import { driveClient } from '../../lib/drive-client.ts'
import { customers, CUSTOMERS_PATH } from '../../server-state.ts'
import { writeJsonAtomic } from '../../lib/atomic-write.ts'
import type { BootstrapStepDef, BootstrapContext } from './types.ts'

export const createCustomerFoldersStep: BootstrapStepDef = {
  name: 'Create Customer Folders',

  preconditions(ctx: BootstrapContext): boolean {
    return !!ctx.aeFolderId
  },

  preconditionsSkipDetail(): string {
    return 'Skipped: Drive folder creation failed'
  },

  async execute(ctx: BootstrapContext): Promise<void> {
    const { aeFolderId, customerNames } = ctx
    ctx.setStep(1, 'running', `0/${customerNames.length} folders…`)

    const folderResources: Record<string, { id: string; url: string }> = {}
    for (let i = 0; i < customerNames.length; i++) {
      const cname = customerNames[i]
      try {
        const existingCustomer = customers.find(cx => cx.name === cname)
        let folderId = existingCustomer?.driveFolderId ?? ''
        if (!folderId) {
          // BKL-M27: find-or-create customer folder via drive-client (ADR-0016).
          folderId = await driveClient.ensureChildFolder(aeFolderId, cname)
          console.log(`[bootstrap] Customer folder ready: ${cname} (${folderId})`)
          if (existingCustomer) {
            existingCustomer.driveFolderId = folderId
            try {
              // BKL-DATA-03: folderId persisted to customers.json via atomic tmp+rename
              writeJsonAtomic(CUSTOMERS_PATH, { customers })
            } catch (e: any) {
              console.warn('[bootstrap] customer folder ID persist failed:', e.message)
            }
          }
          // Do NOT create territory-sheet customer records — territory sheet is
          // AE→territory map only. Customers are sourced exclusively from
          // sf-bookings-sync with canonical SF names.
        }
        folderResources[cname] = {
          id: folderId,
          url: `https://drive.google.com/drive/folders/${folderId}`,
        }
        ctx.setStep(1, 'running', `${i + 1}/${customerNames.length} folders…`)
        console.log(`[auto-bootstrap] Customer folder ready for ${cname}: ${folderId}`)
      } catch (e: any) {
        console.warn(`[auto-bootstrap] Customer folder creation failed for ${cname}: ${e.message}`)
      }
    }

    ctx.resources.customerFolders = folderResources
    ctx.setStep(1, 'done', `${Object.keys(folderResources).length}/${customerNames.length} folders created`)
    console.log(`[auto-bootstrap] Customer folders done: ${Object.keys(folderResources).length}/${customerNames.length}`)
  },
}
