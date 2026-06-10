/**
 * BUILD_HASH Upgrade Detection (ADR-037, Layer 3, F1)
 *
 * Reads /app/BUILD_HASH (written at image build time) and compares
 * against data/cache/.last-build-hash to detect container upgrades.
 * Cold boot (no .last-build-hash) is treated as an upgrade.
 *
 * GitHub #748
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolve } from 'path'
import { CACHE_DIR } from './lib/paths.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface BuildHashInfo {
  gitSha: string
  timestamp: string
  imageTag: string
}

export interface UpgradeCheckResult {
  upgradeDetected: boolean
  oldSha?: string
  newSha?: string
  buildInfo: BuildHashInfo | null
}

// ── Module state ─────────────────────────────────────────────────────────────

let _upgradeDetected = false
let _buildHash: BuildHashInfo | null = null

// ── Default paths ────────────────────────────────────────────────────────────

const DEFAULT_BUILD_HASH_PATH = '/app/BUILD_HASH'
const DEFAULT_LAST_HASH_PATH = resolve(CACHE_DIR, '.last-build-hash')

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compare current BUILD_HASH against .last-build-hash.
 * Parameters accept overrides for testing; production uses defaults.
 */
export function checkForUpgrade(
  buildHashPath: string = DEFAULT_BUILD_HASH_PATH,
  lastHashPath: string = DEFAULT_LAST_HASH_PATH,
): UpgradeCheckResult {
  // Read current build hash (fall back to dev defaults if not in container)
  let currentInfo: BuildHashInfo
  try {
    const raw = readFileSync(buildHashPath, 'utf-8')
    currentInfo = JSON.parse(raw) as BuildHashInfo
  } catch {
    // Dev environment — no BUILD_HASH file
    currentInfo = {
      gitSha: 'dev',
      timestamp: new Date().toISOString(),
      imageTag: 'dev',
    }
  }

  _buildHash = currentInfo

  // Read previous build hash
  let oldInfo: BuildHashInfo | null = null
  try {
    const raw = readFileSync(lastHashPath, 'utf-8')
    oldInfo = JSON.parse(raw) as BuildHashInfo
  } catch {
    // Cold boot — no .last-build-hash
  }

  // Compare
  const upgraded = oldInfo === null || oldInfo.gitSha !== currentInfo.gitSha

  if (upgraded) {
    _upgradeDetected = true

    // Persist current hash for next startup comparison
    mkdirSync(dirname(lastHashPath), { recursive: true })
    writeFileSync(lastHashPath, JSON.stringify(currentInfo, null, 2))

    return {
      upgradeDetected: true,
      oldSha: oldInfo?.gitSha,
      newSha: currentInfo.gitSha,
      buildInfo: currentInfo,
    }
  }

  return {
    upgradeDetected: false,
    buildInfo: currentInfo,
  }
}

/** Returns the module-level upgrade flag (set by checkForUpgrade). */
export function isUpgradeDetected(): boolean {
  return _upgradeDetected
}

/** Returns the current build hash info (set by checkForUpgrade). */
export function getBuildHash(): BuildHashInfo | null {
  return _buildHash
}

/** Test-only: reset module-level state for isolation. */
export function _resetForTesting(): void {
  _upgradeDetected = false
  _buildHash = null
}
