/**
 * BKL-ARCH-01 (issue #54) — Shared helpers used by both bootstrap-orchestrator
 * and the per-step modules under src/bootstrap/steps/. Lives in its own module
 * to break the circular import between bootstrap-orchestrator.ts and
 * src/bootstrap/steps/* (steps need findExistingSheet + SETTINGS_PATH; the
 * orchestrator's IIFE replacement re-exports the steps).
 */
import { resolve } from 'path'
import { driveClient } from '../lib/drive-client.ts'

const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../../config')
export const SETTINGS_PATH = resolve(SRV_CONFIG_DIR, 'settings.json')

/**
 * BKL-W2-12: Search for an existing Google Sheet by name inside a Drive folder
 * before creating a new one. ADR-0016: drive-client supplies supportsAllDrives
 * unconditionally. `drive` arg retained for caller-call-site compatibility but
 * is unused.
 */
export async function findExistingSheet(_drive: unknown, folderId: string, name: string): Promise<string | null> {
  try {
    return await driveClient.findSheetByName(folderId, name)
  } catch {
    return null
  }
}
