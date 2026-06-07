/**
 * Region Config — BKL-ARCH-01
 *
 * Normalizes settings.json into a multi-region shape. Supports both the
 * new `regions[]` schema and the legacy flat schema (`podBookingsFolderId`,
 * `territorySheetUrl`, `podSfReports` at top level) for backward compat.
 *
 * All settings.json reads in the app should go through `normalizeSettings()`
 * so adding a new region (commercial or enterprise) requires only a
 * settings.json edit — no code changes.
 */

export interface RegionPodConfig {
  sfReportId: string
  label: string
  hidden?: boolean
  prefixes?: string[]
}

export type RegionType = 'commercial' | 'enterprise'

export interface RegionConfig {
  id: string
  label: string
  type: RegionType
  territorySheetUrl: string
  podBookingsFolderId: string
  parentFolderId: string   // AE output folder (e.g. CommandCenter). Empty = not yet set.
  pods: Record<string, RegionPodConfig>
}

export interface NormalizedSettings {
  regions: RegionConfig[]
  // Preserve other top-level settings fields (refreshIntervalHours, weatherZip, etc.)
  [key: string]: unknown
}

/**
 * Normalize raw settings.json into a `{ regions: [...] }` shape.
 *
 * - If `regions[]` is present and non-empty, returns as-is (with other top-level keys preserved).
 * - Otherwise synthesizes a single `west-commercial` region from the legacy flat schema.
 * - Empty strings in `sfReportId` / `podBookingsFolderId` / `territorySheetUrl` are allowed;
 *   downstream code treats them as "not yet configured" rather than an error.
 */
export function normalizeSettings(raw: Record<string, unknown> | null | undefined): NormalizedSettings {
  const src = (raw && typeof raw === 'object') ? raw : {}

  const existingRegions = src.regions
  if (Array.isArray(existingRegions) && existingRegions.length > 0) {
    const regions: RegionConfig[] = existingRegions.map((r: unknown) => coerceRegion(r))
    return { ...src, regions }
  }

  // Legacy flat schema → synthesize west-commercial region
  const legacyPodSfReports = isRecord(src.podSfReports) ? src.podSfReports as Record<string, unknown> : {}
  const pods: Record<string, RegionPodConfig> = {}
  for (const [key, value] of Object.entries(legacyPodSfReports)) {
    pods[key] = {
      sfReportId: typeof value === 'string' ? value : '',
      label: defaultLabelForPodKey(key),
    }
  }

  const synthesized: RegionConfig = {
    id: 'west-commercial',
    label: 'West Commercial',
    type: 'commercial',
    territorySheetUrl: typeof src.territorySheetUrl === 'string' ? src.territorySheetUrl : '',
    podBookingsFolderId: typeof src.podBookingsFolderId === 'string' ? src.podBookingsFolderId : '',
    parentFolderId: '',
    pods,
  }

  return { ...src, regions: [synthesized] }
}

/**
 * Return the region with the given id, or the first region if no id is given
 * or no match is found. Always returns a region (callers can rely on non-null).
 */
export function getRegionById(settings: NormalizedSettings, regionId?: string): RegionConfig {
  const regions = settings.regions
  if (!regions.length) {
    throw new Error('getRegionById: settings has no regions — normalizeSettings should have synthesized one')
  }
  if (!regionId) return regions[0]
  return regions.find(r => r.id === regionId) ?? regions[0]
}

/**
 * BKL-HERO-01 Phase 0 — single source of truth for "is the pod filter active".
 *
 * `enabledPods` activates filtering only when present AND non-empty. `undefined`,
 * `null`, and `[]` all mean "no filter, show everything" — this is the
 * backward-compatibility guarantee for every legacy install (including every
 * existing primary install today). Inline-checking at call sites drifts; always
 * import this function.
 */
export function isPodFilterActive(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
}

/** { podKey: sfReportId } — mirrors the legacy `podSfReports` shape for one region. */
export function flattenPodSfReports(region: RegionConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, pod] of Object.entries(region.pods)) {
    out[key] = pod.sfReportId
  }
  return out
}

/** { podKey: label } — used by the frontend to render dropdown option text. */
export function flattenPodLabels(region: RegionConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, pod] of Object.entries(region.pods)) {
    out[key] = pod.label
  }
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function coerceRegion(r: unknown): RegionConfig {
  if (!isRecord(r)) {
    throw new Error('normalizeSettings: region entry is not an object')
  }
  const id = typeof r.id === 'string' ? r.id : ''
  const label = typeof r.label === 'string' ? r.label : id
  const typeRaw = typeof r.type === 'string' ? r.type : 'commercial'
  const type: RegionType = typeRaw === 'enterprise' ? 'enterprise' : 'commercial'
  const territorySheetUrl = typeof r.territorySheetUrl === 'string' ? r.territorySheetUrl : ''
  const podBookingsFolderId = typeof r.podBookingsFolderId === 'string' ? r.podBookingsFolderId : ''
  const parentFolderId = typeof r.parentFolderId === 'string' ? r.parentFolderId : ''

  const pods: Record<string, RegionPodConfig> = {}
  if (isRecord(r.pods)) {
    for (const [key, value] of Object.entries(r.pods)) {
      if (isRecord(value)) {
        pods[key] = {
          sfReportId: typeof value.sfReportId === 'string' ? value.sfReportId : '',
          label: typeof value.label === 'string' ? value.label : defaultLabelForPodKey(key),
          ...(value.hidden === true ? { hidden: true } : {}),
          ...(Array.isArray(value.prefixes) ? { prefixes: value.prefixes.filter((p: unknown) => typeof p === 'string') } : {}),
        }
      }
    }
  }

  return { id, label, type, territorySheetUrl, podBookingsFolderId, parentFolderId, pods }
}

/** Fallback label for a POD key when the region entry doesn't provide one. */
function defaultLabelForPodKey(key: string): string {
  if (key.includes('NORTHWEST')) return 'Northwest Corp'
  if (key.includes('SOUTHWEST')) return 'Southwest Corp'
  if (key.includes('NORTH_CENTRAL')) return 'North Central Corp'
  if (key.includes('SOUTH_CENTRAL')) return 'South Central Corp'
  const last = key.split('_').pop() ?? key
  return last.charAt(0).toUpperCase() + last.slice(1).toLowerCase()
}

/**
 * Segment-based tab-title keyword derivation for the commercial parser.
 *
 * Given a region's pod keys, returns a map of `podKey → [keyword, ...]` where
 * each keyword is a lowercase substring that, if found in a sheet tab title,
 * identifies that tab as belonging to that pod. Keywords are derived only
 * from the pod key itself (not hardcoded), so new regions work without code
 * changes.
 */
export function derivePodKeywordMap(region: RegionConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const key of Object.keys(region.pods)) {
    const segments = key.split('_').map(s => s.toLowerCase())
    const last = segments[segments.length - 1] ?? ''
    const keywords = new Set<string>()
    if (last) keywords.add(last)
    // Compound directional abbreviations (north+central → nc, north central)
    const hasNorth = segments.includes('north')
    const hasSouth = segments.includes('south')
    const hasCentral = segments.includes('central')
    if (hasNorth && hasCentral) {
      keywords.add('north central')
      keywords.add('nc')
    }
    if (hasSouth && hasCentral) {
      keywords.add('south central')
      keywords.add('sc')
    }
    // Directional abbreviations embedded in the last segment
    if (last === 'northwest') keywords.add('nw')
    if (last === 'southwest') keywords.add('sw')
    if (last === 'northcentral') {
      keywords.add('north central')
      keywords.add('nc')
    }
    if (last === 'southcentral') {
      keywords.add('south central')
      keywords.add('sc')
    }

    // For pod keys ending in bare _POD (no number): use geographic segments before _POD
    if (last === 'pod') {
      // Find geographic segments: skip leading directional (e.g. 'southeast', 'northeast')
      // and type segments ('ent', 'comm', 'corp'), use what's left before 'pod'
      const geoSegments = segments.slice(0, -1).filter(s =>
        !['east', 'west', 'north', 'south', 'central', 'northeast', 'northwest',
          'southeast', 'southwest', 'ent', 'comm', 'corp'].includes(s)
      )
      if (geoSegments.length > 0) {
        const geoKey = geoSegments.join(' ')      // e.g. "nc sc"
        const slashKey = geoSegments.join('/')    // e.g. "nc/sc"
        keywords.add(geoKey)
        keywords.add(slashKey)
      }
    }

    // For pod keys ending in _POD01, _POD02, etc.: add unpadded "pod N" variant
    const podNumMatch = last.match(/^pod0?(\d+)$/)
    if (podNumMatch) {
      keywords.add(`pod ${podNumMatch[1]}`)    // "pod 1", "pod 2", etc.
      keywords.add(`pod${podNumMatch[1]}`)     // "pod1", "pod2" (no space)
    }

    out[key] = Array.from(keywords)
  }
  return out
}
