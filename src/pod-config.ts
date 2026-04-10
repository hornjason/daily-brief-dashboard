/**
 * BKL-UX52: Multi-pod configuration.
 *
 * Reads pod definitions from data-sources.json → pods[].
 * Each pod has an id, name, and list of AE names belonging to it.
 * If no pods config exists, synthesizes a single "sw" pod containing all AEs.
 */
import { readFileSync } from 'fs'
import type { AE } from './types.ts'

export interface PodConfig {
  id: string
  name: string
  aeNames: string[]   // AE names belonging to this pod
}

/**
 * Read pod configuration from data-sources.json.
 * Falls back to a single "sw" pod with all AEs if no pods key exists.
 */
export function readPodConfig(dataSourcesPath: string, allAes: AE[]): PodConfig[] {
  try {
    const ds = JSON.parse(readFileSync(dataSourcesPath, 'utf-8'))
    if (Array.isArray(ds.pods) && ds.pods.length > 0) {
      return ds.pods.map((p: any) => ({
        id: String(p.id ?? ''),
        name: String(p.name ?? ''),
        aeNames: Array.isArray(p.aeNames) ? p.aeNames.map(String) : [],
      }))
    }
  } catch { /* data-sources.json missing or malformed — use fallback */ }

  // Fallback: single pod with all AEs
  return [{
    id: 'sw',
    name: 'Southwest',
    aeNames: allAes.map(a => a.name),
  }]
}

/**
 * Get AE names for a specific pod. Returns all AE names from the first pod if podId is omitted.
 */
export function getAeNamesForPod(pods: PodConfig[], podId?: string): string[] {
  if (!podId) return pods[0]?.aeNames ?? []
  const pod = pods.find(p => p.id === podId)
  return pod?.aeNames ?? pods[0]?.aeNames ?? []
}
