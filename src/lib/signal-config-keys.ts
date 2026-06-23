/**
 * src/lib/signal-config-keys.ts
 * Extracts SIGNAL_CONFIGS keys from intelligence-graph.ts at runtime.
 *
 * GitHub Issue #875 — Intelligence Graph Health Audit
 *
 * SIGNAL_CONFIGS is a module-level const in intelligence-graph.ts (not exported).
 * Rather than modifying that file, we extract the keys by reading the source.
 * This file caches the result after first call.
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

let _cached: string[] | null = null

/**
 * Extract all keys from the SIGNAL_CONFIGS dict in intelligence-graph.ts.
 * Cached after first call.
 */
export function getSignalConfigKeys(): string[] {
  if (_cached) return _cached

  try {
    const dir = (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(dir, 'intelligence-graph.ts'), 'utf-8')

    // Find the SIGNAL_CONFIGS block and extract quoted keys
    const configBlock = src.match(/const SIGNAL_CONFIGS[^{]*\{([\s\S]*?)^\}/m)
    if (configBlock) {
      const keys = [...configBlock[1].matchAll(/'([^']+)'\s*:/g)].map(m => m[1])
      if (keys.length > 0) {
        _cached = keys
        return keys
      }
    }
  } catch {
    // fallback below
  }

  // If source parsing fails, return empty — caller handles gracefully
  _cached = []
  return _cached
}
