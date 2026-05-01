/**
 * BKL-HERO-01 Phase 0 — region access catalog + persistence.
 *
 * Two endpoints:
 *   GET  /api/regions/catalog   → list of regions with selectable flags + pod sub-list
 *   POST /api/regions/access    → validate + persist enabledRegions/enabledPods to settings.json
 *
 * `enabledRegions` and `enabledPods` are top-level optional arrays on
 * settings.json. They sit alongside `regions[]`, not inside it. `normalizeSettings()`
 * preserves unknown top-level keys via spread, so legacy primary installs are
 * unaffected — no schema migration required.
 *
 * Atomic write pattern (read fresh, write tmp, renameSync) mirrors
 * server.ts:840–850 (validate-folder route). No `await` between read and write.
 */
import { readFileSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { Hono } from 'hono'
import { normalizeSettings, type RegionConfig } from './region-config.ts'
import { sanitizeErr } from './utils.ts'

interface CatalogPod {
  key: string
  label: string
  qualifiedKey: string  // `${regionId}.${podKey}` — globally unique
}

interface CatalogRegion {
  id: string
  label: string
  selectable: boolean
  comingSoonReason?: string
  pods: CatalogPod[]
}

/** A region is selectable when it has all three: territorySheetUrl, podBookingsFolderId, ≥1 pod with sfReportId. */
function buildCatalogRegion(region: RegionConfig): CatalogRegion {
  const pods: CatalogPod[] = Object.entries(region.pods).map(([key, pod]) => ({
    key,
    label: pod.label,
    qualifiedKey: `${region.id}.${key}`,
  }))

  const missing: string[] = []
  if (!region.territorySheetUrl) missing.push('territorySheetUrl')
  if (!region.podBookingsFolderId) missing.push('podBookingsFolderId')
  const hasPodWithReport = Object.values(region.pods).some(p => !!p.sfReportId)
  if (!hasPodWithReport) missing.push('sfReportId on any pod')

  const selectable = missing.length === 0
  const out: CatalogRegion = { id: region.id, label: region.label, selectable, pods }
  if (!selectable) out.comingSoonReason = `Missing: ${missing.join(', ')}`
  return out
}

export function createRegionAccessRouter(deps: { settingsPath: string }): Hono {
  const { settingsPath } = deps
  const router = new Hono()
  // GET /api/regions/catalog — list of regions with selectable flag + pod list
  router.get('/api/regions/catalog', (c) => {
    try {
      let raw: Record<string, unknown> = {}
      try { raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* missing → empty regions */ }
      const settings = normalizeSettings(raw)
      const catalog = settings.regions.map(buildCatalogRegion)
      return c.json({ regions: catalog })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/regions/access — current persisted selection (Phase 1 first-boot detection)
  // Returns the raw fields exactly as they appear in settings.json so the frontend
  // can distinguish `undefined` (first boot) from `[]` (deliberately cleared).
  router.get('/api/regions/access', (c) => {
    try {
      let raw: Record<string, unknown> = {}
      try { raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* new file */ }
      const out: { enabledRegions?: unknown; enabledPods?: unknown } = {}
      if ('enabledRegions' in raw) out.enabledRegions = raw.enabledRegions
      if ('enabledPods' in raw) out.enabledPods = raw.enabledPods
      return c.json(out)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/regions/access — validate + persist enabledRegions/enabledPods
  router.post('/api/regions/access', async (c) => {
    let body: { enabledRegions?: unknown; enabledPods?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const enabledRegions = body.enabledRegions
    const enabledPods = body.enabledPods
    if (!Array.isArray(enabledRegions) || !enabledRegions.every(s => typeof s === 'string')) {
      return c.json({ error: 'enabledRegions must be an array of strings' }, 400)
    }
    if (!Array.isArray(enabledPods) || !enabledPods.every(s => typeof s === 'string')) {
      return c.json({ error: 'enabledPods must be an array of strings' }, 400)
    }

    try {
      // Read fresh from disk (no await between this read and the write below).
      let rawSettings: Record<string, unknown> = {}
      try { rawSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* new file */ }
      const settings = normalizeSettings(rawSettings)
      const catalog = settings.regions.map(buildCatalogRegion)
      const catalogById = new Map(catalog.map(r => [r.id, r]))
      const validQualifiedKeys = new Set(catalog.flatMap(r => r.pods.map(p => p.qualifiedKey)))

      // Validate every enabledRegions ID exists AND is selectable.
      for (const regionId of enabledRegions as string[]) {
        const cat = catalogById.get(regionId)
        if (!cat) return c.json({ error: `Unknown region: ${regionId}` }, 400)
        if (!cat.selectable) {
          return c.json({ error: `Region ${regionId} is not selectable: ${cat.comingSoonReason ?? 'coming soon'}` }, 400)
        }
      }
      // Validate every enabledPods qualified key matches a real ${regionId}.${podKey}.
      for (const qualified of enabledPods as string[]) {
        if (!validQualifiedKeys.has(qualified)) {
          return c.json({ error: `Unknown pod qualified key: ${qualified}` }, 400)
        }
      }

      // Atomic write — preserve all other top-level fields via spread.
      const out = { ...rawSettings, enabledRegions, enabledPods }
      writeJsonAtomic(settingsPath, out)
      return c.json({ ok: true })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })
  return router
}
