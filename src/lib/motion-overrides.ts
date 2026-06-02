/**
 * src/lib/motion-overrides.ts
 * User Overrides for Expansion Motions — GitHub Issue #520
 *
 * Allows users to customize motions: add custom assets, create custom plays,
 * dismiss/pin motions and phases. All overrides augment system data, never replace it.
 *
 * Storage: Per-customer JSON at data/cache/{customerSlug}/motion-overrides.json
 */

import { readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { CACHE_DIR } from './paths.ts'
import { writeJsonAtomic } from './atomic-write.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MotionOverrides {
  customAssets: Array<{ phaseId: string; asset: { name: string; url: string; type: string } }>
  customPlays: Array<{ name: string; parentTdp: string; assets: Array<{ name: string; url: string; type: string }> }>
  dismissed: Array<{ motionId: string; dismissedAt: string }>
  pinned: Array<{ motionId: string; pinnedAt: string }>
  phaseDismissed: Array<{ phaseId: string; dismissedAt: string }>
  phasePinned: Array<{ phaseId: string; pinnedAt: string }>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const OVERRIDES_FILENAME = 'motion-overrides.json'

function emptyOverrides(): MotionOverrides {
  return {
    customAssets: [],
    customPlays: [],
    dismissed: [],
    pinned: [],
    phaseDismissed: [],
    phasePinned: [],
  }
}

function validateSlug(slug: string): void {
  if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) throw new Error(`[motion-overrides] unsafe slug: ${slug}`)
}

function overridesPath(customerSlug: string, cacheDir?: string): string {
  validateSlug(customerSlug)
  const base = cacheDir ?? CACHE_DIR
  return join(base, customerSlug, OVERRIDES_FILENAME)
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load overrides for a customer. Returns empty defaults if no file exists.
 */
export function loadOverrides(customerSlug: string, cacheDir?: string): MotionOverrides {
  const filePath = overridesPath(customerSlug, cacheDir)

  if (!existsSync(filePath)) {
    return emptyOverrides()
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    // Merge with defaults to handle schema evolution
    return { ...emptyOverrides(), ...parsed }
  } catch {
    return emptyOverrides()
  }
}

/**
 * Save overrides for a customer. Creates the directory if needed.
 */
export function saveOverrides(customerSlug: string, overrides: MotionOverrides, cacheDir?: string): void {
  const filePath = overridesPath(customerSlug, cacheDir)
  const dir = join(cacheDir ?? CACHE_DIR, customerSlug)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeJsonAtomic(filePath, overrides)
}

/**
 * Add a custom asset to a motion phase. Augments — never replaces.
 */
export function addCustomAsset(
  customerSlug: string,
  phaseId: string,
  asset: { name: string; url: string; type: string },
  cacheDir?: string,
): void {
  const overrides = loadOverrides(customerSlug, cacheDir)
  overrides.customAssets.push({ phaseId, asset })
  saveOverrides(customerSlug, overrides, cacheDir)
}

/**
 * Dismiss a motion. Idempotent — double-dismiss does not duplicate.
 */
export function dismissMotion(customerSlug: string, motionId: string, cacheDir?: string): void {
  const overrides = loadOverrides(customerSlug, cacheDir)

  if (overrides.dismissed.some(d => d.motionId === motionId)) {
    return // already dismissed
  }

  overrides.dismissed.push({ motionId, dismissedAt: new Date().toISOString() })
  saveOverrides(customerSlug, overrides, cacheDir)
}

/**
 * Pin a motion. Idempotent — double-pin does not duplicate.
 */
export function pinMotion(customerSlug: string, motionId: string, cacheDir?: string): void {
  const overrides = loadOverrides(customerSlug, cacheDir)

  if (overrides.pinned.some(p => p.motionId === motionId)) {
    return // already pinned
  }

  overrides.pinned.push({ motionId, pinnedAt: new Date().toISOString() })
  saveOverrides(customerSlug, overrides, cacheDir)
}

/**
 * Dismiss a phase. Idempotent.
 */
export function dismissPhase(customerSlug: string, phaseId: string, cacheDir?: string): void {
  const overrides = loadOverrides(customerSlug, cacheDir)

  if (overrides.phaseDismissed.some(d => d.phaseId === phaseId)) {
    return
  }

  overrides.phaseDismissed.push({ phaseId, dismissedAt: new Date().toISOString() })
  saveOverrides(customerSlug, overrides, cacheDir)
}

/**
 * Pin a phase. Idempotent.
 */
export function pinPhase(customerSlug: string, phaseId: string, cacheDir?: string): void {
  const overrides = loadOverrides(customerSlug, cacheDir)

  if (overrides.phasePinned.some(p => p.phaseId === phaseId)) {
    return
  }

  overrides.phasePinned.push({ phaseId, pinnedAt: new Date().toISOString() })
  saveOverrides(customerSlug, overrides, cacheDir)
}

/**
 * Undismiss a motion — removes the dismissed flag.
 */
export function undismissMotion(customerSlug: string, motionId: string, cacheDir?: string): void {
  const overrides = loadOverrides(customerSlug, cacheDir)
  overrides.dismissed = overrides.dismissed.filter(d => d.motionId !== motionId)
  saveOverrides(customerSlug, overrides, cacheDir)
}
