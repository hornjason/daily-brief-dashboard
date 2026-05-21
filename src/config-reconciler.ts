/**
 * Config reconciler — startup migration from monolithic data-sources.json
 * to three separate config files with single-writer ownership.
 *
 * Prevents cross-writer data loss (BKL-HERO-02, GitHub #112).
 *
 * Three config files:
 *   - auth.json          — RH offline token (writer: settings-api)
 *   - pod-config.json    — scaffold cache, POD config (writer: bootstrap-orchestrator)
 *   - user-settings.json — scheduler, weather, AI, automation (writer: settings-api)
 *
 * Legacy data-sources.json is migrated once at startup, then archived.
 * New files take priority over legacy on subsequent runs.
 *
 * Run this BEFORE the server starts: call reconcileConfig() from server.ts.
 */

import { readFileSync, existsSync, renameSync, mkdirSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import { CONFIG_DIR } from './lib/paths.ts'

function getConfigDir(): string {
  return CONFIG_DIR
}

export function getAuthConfigPath(): string {
  return resolve(getConfigDir(), 'auth.json')
}

export function getPodConfigPath(): string {
  return resolve(getConfigDir(), 'pod-config.json')
}

export function getUserSettingsPath(): string {
  return resolve(getConfigDir(), 'user-settings.json')
}

// Backward compatibility: export computed paths as constants
export const AUTH_CONFIG_PATH = getAuthConfigPath()
export const POD_CONFIG_PATH = getPodConfigPath()
export const USER_SETTINGS_PATH = getUserSettingsPath()

function getLegacyPath(): string {
  return resolve(getConfigDir(), 'data-sources.json')
}

/**
 * Reconcile config files at startup:
 * 1. Read all four files (tolerate missing)
 * 2. Migrate fields from legacy to new files (new files take priority)
 * 3. Write canonical copies
 * 4. Archive legacy if it had content
 */
export function reconcileConfig(): void {
  const CONFIG_DIR = getConfigDir()
  const authPath = resolve(CONFIG_DIR, 'auth.json')
  const podPath = resolve(CONFIG_DIR, 'pod-config.json')
  const settingsPath = resolve(CONFIG_DIR, 'user-settings.json')
  const legacyPath = getLegacyPath()

  mkdirSync(CONFIG_DIR, { recursive: true })

  // Read all files (tolerate missing)
  let auth: Record<string, unknown> = {}
  let pod: Record<string, unknown> = {}
  let settings: Record<string, unknown> = {}
  let legacy: Record<string, unknown> = {}

  try {
    auth = JSON.parse(readFileSync(authPath, 'utf-8'))
  } catch {
    /* file missing or invalid JSON */
  }
  try {
    pod = JSON.parse(readFileSync(podPath, 'utf-8'))
  } catch {
    /* file missing or invalid JSON */
  }
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch {
    /* file missing or invalid JSON */
  }
  try {
    legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'))
  } catch {
    /* file missing or invalid JSON */
  }

  // Migrate from legacy — new files take priority over legacy
  if (Object.keys(legacy).length > 0) {
    // Auth fields
    if (legacy.redhatOfflineToken && !auth.redhatOfflineToken) {
      auth.redhatOfflineToken = legacy.redhatOfflineToken
    }
    // Pod fields
    if (legacy.scaffoldCache && !pod.scaffoldCache)
      pod.scaffoldCache = legacy.scaffoldCache
    if (legacy.podConfig && !pod.podConfig) pod.podConfig = legacy.podConfig
    // Settings fields
    if (legacy.schedulerConfig && !settings.schedulerConfig)
      settings.schedulerConfig = legacy.schedulerConfig
    if (legacy.weather && !settings.weather) settings.weather = legacy.weather
    if (legacy.aiConfig && !settings.aiConfig)
      settings.aiConfig = legacy.aiConfig
    if (legacy.automationConfig && !settings.automationConfig)
      settings.automationConfig = legacy.automationConfig

    console.log('[reconciler] migrated fields from legacy data-sources.json')
  }

  // Write canonical copies
  writeJsonAtomic(authPath, auth)
  writeJsonAtomic(podPath, pod)
  writeJsonAtomic(settingsPath, settings)

  // Archive legacy if it had content
  if (Object.keys(legacy).length > 0 && existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, `${legacyPath}.migrated-${Date.now()}`)
      console.log('[reconciler] archived legacy data-sources.json')
    } catch (e: any) {
      console.warn(
        `[reconciler] could not archive legacy file: ${e.message}`,
      )
    }
  }

  console.log('[reconciler] config reconciliation complete')
}
