/**
 * BKL-ARCH-01 (issue #54) — Step 1: Create AE Drive Folder.
 *
 * Code-move from src/bootstrap-orchestrator.ts (the inner IIFE around line 1247).
 * Behavior is identical: reuse an existing AE folder if `aes.json` already records
 * one, otherwise find-or-create under (parentFolderId / podName) hierarchy via
 * driveClient.ensureChildFolder, falling back to Drive root creation.
 *
 * Persists driveFolderId back to aes.json on creation. Records the folder
 * resource on autoBootstrapState.resources.driveFolder. Sets ctx.aeFolderId
 * so downstream steps (Customer Folders, Subscription Sheet, Data Sheets) can
 * read it.
 */
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../../google.ts'
import { driveClient } from '../../lib/drive-client.ts'
import { aes, saveAes } from '../../server-state.ts'
import { SETTINGS_PATH } from '../../drive-config-sync.ts'
import type { BootstrapStepDef, BootstrapContext } from './types.ts'

export const createDriveFolderStep: BootstrapStepDef = {
  name: 'Create Drive Folder',

  preconditions(ctx: BootstrapContext): boolean {
    return !!ctx.aeName
  },

  async execute(ctx: BootstrapContext): Promise<void> {
    const { aeName, parentFolderId, podName } = ctx

    // BKL-HERO-PARENT-FOLDER-CONFUSION: Guard against parentFolderId being
    // the same as podBookingsFolderId (Subscription Data folder). They are
    // semantically distinct — AE folders must not nest under Subscription Data.
    if (parentFolderId) {
      try {
        const { readFileSync } = await import('fs')
        const { normalizeSettings, getRegionById } = await import('../../region-config.ts')
        const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
        const settings = normalizeSettings(raw)
        // BKL-HERO-PARENT-REGION-BUG: pass ctx.regionId so we check the correct region's podBookingsFolderId
        const region = getRegionById(settings, ctx.regionId)
        if (region.podBookingsFolderId && parentFolderId === region.podBookingsFolderId) {
          throw new Error(
            'parentFolderId cannot be the same as podBookingsFolderId (Subscription Data folder). ' +
            'AE folders must be created under the CommandCenter root, not the Subscription Data folder.'
          )
        }
      } catch (e: any) {
        if (e?.message?.includes('parentFolderId cannot be the same as')) throw e
        console.warn('[auto-bootstrap] parentFolderId guard check failed (non-blocking):', e?.message)
      }
    }

    // Reuse if AE already has a Drive folder from a previous run.
    const existingAe = aes.find(a => a.name === aeName)
    let driveFolderId = existingAe?.driveFolderId ?? ''

    if (driveFolderId) {
      ctx.resources.driveFolder = {
        id: driveFolderId,
        url: `https://drive.google.com/drive/folders/${driveFolderId}`,
      }
      ctx.aeFolderId = driveFolderId
      ctx.setStep(0, 'done', `Folder: ${driveFolderId}`)
      console.log(`[auto-bootstrap] Drive folder already exists, reusing: ${driveFolderId}`)
      return
    }

    const drive = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })

    // BKL-DRIVE-01: If podName is provided, find-or-create POD subfolder under
    // parentFolderId; use it as effective parent for the AE folder.
    // Hierarchy: parentFolderId / POD Name / AE Name / customer folders.
    let effectiveParentId = parentFolderId
    if (podName && parentFolderId) {
      try {
        effectiveParentId = await driveClient.ensureChildFolder(parentFolderId, podName)
        console.log(`[auto-bootstrap] POD folder ready: ${podName} (${effectiveParentId})`)
      } catch (e: any) {
        console.warn(`[auto-bootstrap] POD folder ensure failed: ${e?.message} — falling back to parentFolderId`)
        effectiveParentId = parentFolderId
      }
    }

    // BKL-M27: Find-or-create AE folder under effective parent.
    if (effectiveParentId) {
      try {
        driveFolderId = await driveClient.ensureChildFolder(effectiveParentId, aeName)
        ctx.resources.driveFolder = {
          id: driveFolderId,
          url: `https://drive.google.com/drive/folders/${driveFolderId}`,
        }
        const updated = aes.map(a => a.name === aeName ? { ...a, driveFolderId } : a)
        saveAes(updated)
        ctx.setStep(0, 'done', `Folder: ${driveFolderId}`)
        console.log(`[auto-bootstrap] AE folder ready: ${aeName} (${driveFolderId})`)
      } catch (e: any) {
        console.warn(`[auto-bootstrap] AE folder ensure failed: ${e?.message}`)
      }
    }

    if (!driveFolderId) {
      // No effective parent — create at Drive root via legacy direct call.
      const folder = await drive.files.create({
        requestBody: {
          name: aeName,
          mimeType: 'application/vnd.google-apps.folder',
        },
        supportsAllDrives: true,
        fields: 'id,webViewLink',
      })
      driveFolderId = folder.data.id!
      ctx.resources.driveFolder = {
        id: driveFolderId,
        url: folder.data.webViewLink ?? `https://drive.google.com/drive/folders/${driveFolderId}`,
      }
      const updated = aes.map(a => a.name === aeName ? { ...a, driveFolderId } : a)
      saveAes(updated)
      ctx.setStep(0, 'done', `Folder: ${driveFolderId}`)
      console.log(`[auto-bootstrap] Drive folder created at root: ${driveFolderId}`)
    }

    ctx.aeFolderId = driveFolderId
  },
}
