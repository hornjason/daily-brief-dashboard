/**
 * BKL-UX52: Multi-pod configuration.
 *
 * Reads pod definitions from data-sources.json → pods[].
 * Each pod has an id, name, and list of AE names belonging to it.
 * If no pods config exists, synthesizes a single pod whose name is derived
 * from the AEs' territory codes (e.g. WEST_COMM_CORP_NORTHWEST_TERR02 → "Northwest").
 */
import { readFileSync } from 'fs'
import type { AE } from './types.ts'

export interface PodConfig {
  id: string
  name: string
  aeNames: string[]   // AE names belonging to this pod
}

/**
 * Recognised pod tokens that may appear inside a territory code such as
 * WEST_COMM_CORP_NORTHWEST_TERR02. Order matters — multi-word tokens
 * (NORTH_CENTRAL) must be checked before single-word ones (NORTH).
 */
const POD_TOKENS: { token: string; id: string; name: string }[] = [
  { token: 'NORTH_CENTRAL', id: 'nc', name: 'North Central' },
  { token: 'SOUTH_CENTRAL', id: 'sc', name: 'South Central' },
  { token: 'NORTHWEST', id: 'nw', name: 'Northwest' },
  { token: 'SOUTHWEST', id: 'sw', name: 'Southwest' },
  { token: 'NORTHEAST', id: 'ne', name: 'Northeast' },
  { token: 'SOUTHEAST', id: 'se', name: 'Southeast' },
]

/**
 * Derive a pod {id,name} from a set of AE territory codes. Picks the most
 * common pod token across the AEs' territories. Returns null if no AE has a
 * recognisable territory code.
 */
function derivePodFromAes(allAes: AE[]): { id: string; name: string } | null {
  const counts = new Map<string, number>()
  for (const ae of allAes) {
    for (const terr of ae.tableauTerritories ?? []) {
      const upper = terr.toUpperCase()
      for (const pod of POD_TOKENS) {
        if (upper.includes(pod.token)) {
          counts.set(pod.token, (counts.get(pod.token) ?? 0) + 1)
          break
        }
      }
    }
  }
  if (counts.size === 0) return null
  let bestToken = ''
  let bestCount = -1
  for (const [token, count] of counts) {
    if (count > bestCount) { bestToken = token; bestCount = count }
  }
  const match = POD_TOKENS.find(p => p.token === bestToken)
  return match ? { id: match.id, name: match.name } : null
}

/**
 * Read pod configuration from data-sources.json.
 * Falls back to a single pod (name derived from AE territory codes) when no
 * pods key is present in data-sources.json.
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

  // Fallback: single pod with all AEs. Derive the name from the AEs'
  // territory codes so the dashboard header reflects the actual region.
  const derived = derivePodFromAes(allAes)
  return [{
    id: derived?.id ?? 'pod',
    name: derived?.name ?? 'Pod',
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
