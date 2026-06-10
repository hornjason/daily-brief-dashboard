// src/staleness-monitor.ts
// ADR-037 F3 — Heartbeat staleness flagging
// Checks module freshness using registry status timestamps + cacheTtlMs.
// Called on every heartbeat tick to maintain a live staleness map.

import { FeatureModuleRegistry } from './feature-module-registry.ts'

export type StalenessLevel = 'fresh' | 'expiring-soon' | 'stale' | 'unknown'

export interface ModuleFreshness {
  level: StalenessLevel
  lastChecked: string | null  // ISO timestamp from registry status
  cacheTtlMs: number | null
  timeUntilExpiry: number | null  // ms, negative if expired
}

const _stalenessMap = new Map<string, ModuleFreshness>()

/**
 * Scan all registered modules and update the staleness map.
 * Uses registry ModuleStatus.lastChecked + module.cacheTtlMs to compute freshness.
 *
 * Thresholds:
 *   - age < 75% of TTL → 'fresh'
 *   - age >= 75% of TTL but < TTL → 'expiring-soon'
 *   - age >= TTL → 'stale'
 *   - no cacheTtlMs declared → 'unknown'
 *   - cacheTtlMs but no lastChecked → 'stale' (never run)
 */
export function checkModuleStaleness(): void {
  const modules = FeatureModuleRegistry.getRegisteredModules()
  const statusMap = FeatureModuleRegistry.getStatus()
  const now = Date.now()

  for (const mod of modules) {
    if (!mod.cacheTtlMs) {
      _stalenessMap.set(mod.name, {
        level: 'unknown',
        lastChecked: statusMap[mod.name]?.lastChecked ?? null,
        cacheTtlMs: null,
        timeUntilExpiry: null,
      })
      continue
    }

    const status = statusMap[mod.name]
    const lastChecked = status?.lastChecked ?? null

    if (!lastChecked) {
      // Module has TTL but has never been checked — treat as stale
      _stalenessMap.set(mod.name, {
        level: 'stale',
        lastChecked: null,
        cacheTtlMs: mod.cacheTtlMs,
        timeUntilExpiry: null,
      })
      continue
    }

    const lastCheckedMs = new Date(lastChecked).getTime()
    const age = now - lastCheckedMs
    const timeUntilExpiry = mod.cacheTtlMs - age

    let level: StalenessLevel
    if (age >= mod.cacheTtlMs) {
      level = 'stale'
    } else if (age >= mod.cacheTtlMs * 0.75) {
      level = 'expiring-soon'
    } else {
      level = 'fresh'
    }

    _stalenessMap.set(mod.name, {
      level,
      lastChecked,
      cacheTtlMs: mod.cacheTtlMs,
      timeUntilExpiry,
    })
  }
}

/**
 * Return the current staleness map as a plain object.
 * Keyed by module name.
 */
export function getStalenessMap(): Record<string, ModuleFreshness> {
  return Object.fromEntries(_stalenessMap)
}

/** Test-only: clear the staleness map. */
export function _resetStalenessForTesting(): void {
  _stalenessMap.clear()
}
