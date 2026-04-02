import { readFileSync, writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import type { Hono } from 'hono'

// ── Module state ─────────────────────────────────────────────────────────────
let DATA_SOURCES_PATH = ''

export function initSettingsApi(dataSourcesPath: string): void {
  DATA_SOURCES_PATH = dataSourcesPath
}

// ── Refresh intervals ────────────────────────────────────────────────────────

export const DEFAULT_REFRESH_INTERVALS = {
  subscriptions: 4 * 60,   // minutes
  ccsp:          60 * 24,  // daily
  rhScrape:      90,       // RH portal support case scrape — every 90 min (Sev1 responsiveness)
}

export function getRefreshIntervals(): typeof DEFAULT_REFRESH_INTERVALS {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return { ...DEFAULT_REFRESH_INTERVALS, ...(ds.refreshIntervals ?? {}) }
  } catch { return DEFAULT_REFRESH_INTERVALS }
}

// ── Scheduler config ─────────────────────────────────────────────────────────

export interface SchedulerConfig {
  ccspTime: string
  supportableTime: string
  territoryTime: string
  sfPipelineTime: string
  ccspEnabled: boolean
  supportableEnabled: boolean
  territoryEnabled: boolean
  sfPipelineEnabled: boolean
  rhEnabled: boolean
  ccspLastRun: string | null
  supportableLastRun: string | null
  territoryLastRun: string | null
  sfPipelineLastRun: string | null
  rhLastRun: string | null
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  ccspTime: '06:30',
  supportableTime: '07:00',
  territoryTime: '01:45',
  sfPipelineTime: '02:00',
  ccspEnabled: true,
  supportableEnabled: true,
  territoryEnabled: true,
  sfPipelineEnabled: true,
  rhEnabled: true,
  ccspLastRun: null,
  supportableLastRun: null,
  territoryLastRun: null,
  sfPipelineLastRun: null,
  rhLastRun: null,
}

export function getSchedulerConfig(): SchedulerConfig {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return { ...DEFAULT_SCHEDULER_CONFIG, ...(ds.schedulerConfig ?? {}) }
  } catch { return { ...DEFAULT_SCHEDULER_CONFIG } }
}

export function updateSchedulerField(field: string, value: unknown): void {
  let ds: Record<string, unknown> = {}
  try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch {}
  const config = { ...DEFAULT_SCHEDULER_CONFIG, ...(ds.schedulerConfig ?? {} as any) }
  ;(config as any)[field] = value
  const tmpPath = DATA_SOURCES_PATH + '.tmp'
  writeFileSyncRaw(tmpPath, JSON.stringify({ ...ds, schedulerConfig: config }, null, 2), { mode: 0o600 })
  renameSync(tmpPath, DATA_SOURCES_PATH)
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const FLOOR_HOURS: Record<string, number> = {
  sfPipelineTime: 12,
  ccspTime: 6,
  supportableTime: 12,
  territoryTime: 6,
}

const LAST_RUN_KEY: Record<string, keyof SchedulerConfig> = {
  sfPipelineTime: 'sfPipelineLastRun',
  ccspTime: 'ccspLastRun',
  supportableTime: 'supportableLastRun',
  territoryTime: 'territoryLastRun',
}

// ── Weather settings ─────────────────────────────────────────────────────────

interface WeatherSettings { enabled: boolean; zipCode: string }

export function getWeatherSettings(): WeatherSettings {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return { enabled: false, zipCode: '', ...(ds.weather ?? {}) }
  } catch { return { enabled: false, zipCode: '' } }
}

// 30-minute in-memory weather cache
let _weatherCache: { data: object; fetchedAt: number } | null = null
const WEATHER_CACHE_MS = 30 * 60 * 1000

// ── Route registration ──────────────────────────────────────────────────────

export function registerSettingsRoutes(app: Hono, deps: { rescheduleRefreshTimers: (intervals: typeof DEFAULT_REFRESH_INTERVALS) => void }): void {
  // GET /api/settings/refresh — current refresh intervals + scheduler config
  app.get('/api/settings/refresh', (c) => {
    return c.json({
      intervals: getRefreshIntervals(),
      defaults: DEFAULT_REFRESH_INTERVALS,
      schedulerConfig: getSchedulerConfig(),
    })
  })

  // POST /api/settings/refresh — update refresh intervals
  app.post('/api/settings/refresh', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
    const ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_REFRESH_INTERVALS))
    const filtered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v
    }
    const current = getRefreshIntervals()
    const updated = { ...current, ...filtered }
    // Validate: all values must be positive numbers (explicit NaN guard — typeof NaN === 'number')
    for (const [k, v] of Object.entries(updated)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return c.json({ error: `${k} must be a positive number of minutes` }, 400)
    }
    // BKL-M37: server-side floor — RH scrape hammers the portal; 30 min minimum
    if (updated.rhScrape < 30) return c.json({ error: 'rhScrape minimum is 30 minutes — lower values risk portal rate-limiting' }, 400)

    // Scheduler config fields (time + enabled)
    const TIME_KEYS = ['ccspTime', 'supportableTime', 'territoryTime', 'sfPipelineTime'] as const
    const ENABLED_KEYS = ['ccspEnabled', 'supportableEnabled', 'territoryEnabled', 'sfPipelineEnabled', 'rhEnabled'] as const
    const currentConfig = getSchedulerConfig()
    let configChanged = false

    for (const k of TIME_KEYS) {
      if (k in body) {
        const v = body[k]
        if (typeof v !== 'string' || !TIME_RE.test(v)) return c.json({ error: `${k} must be HH:MM format` }, 400)
        const floorH = FLOOR_HOURS[k]
        const lastRunKey = LAST_RUN_KEY[k]
        if (floorH && lastRunKey) {
          const lastRun = currentConfig[lastRunKey]
          if (lastRun) {
            const elapsed = Date.now() - new Date(lastRun as string).getTime()
            if (elapsed < floorH * 3600_000) {
              return c.json({ error: `${k}: minimum ${floorH}h between runs (last run ${Math.round(elapsed / 60_000)}m ago)` }, 400)
            }
          }
        }
        ;(currentConfig as any)[k] = v
        configChanged = true
      }
    }
    for (const k of ENABLED_KEYS) {
      if (k in body) {
        if (typeof body[k] !== 'boolean') return c.json({ error: `${k} must be a boolean` }, 400)
        ;(currentConfig as any)[k] = body[k]
        configChanged = true
      }
    }

    try {
      let ds: Record<string, unknown> = {}
      try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch { /* file missing — start fresh */ }
      const merged: Record<string, unknown> = { ...ds, refreshIntervals: updated }
      if (configChanged) merged.schedulerConfig = currentConfig
      const tmpPath = DATA_SOURCES_PATH + '.tmp'
      writeFileSyncRaw(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 })
      renameSync(tmpPath, DATA_SOURCES_PATH)
      deps.rescheduleRefreshTimers(updated)
      return c.json({ intervals: updated, schedulerConfig: getSchedulerConfig() })
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e).slice(0, 200).replace(/\/[^\s:]+\.(ts|js|json)/g, '[file]') }, 500)
    }
  })

  // ── Weather settings + proxy ──────────────────────────────────────────────

  app.get('/api/settings/weather', (c) => c.json(getWeatherSettings()))

  app.post('/api/settings/weather', async (c) => {
    const body = await c.req.json<Partial<WeatherSettings>>().catch(() => ({}))
    const current = getWeatherSettings()
    const rawZip = typeof body.zipCode === 'string' ? body.zipCode.trim() : current.zipCode
    if (rawZip && !/^[A-Za-z0-9\s\-]{2,10}$/.test(rawZip)) {
      return c.json({ error: 'Invalid zip/postal code' }, 400)
    }
    const updated: WeatherSettings = {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
      zipCode: rawZip,
    }
    try {
      const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
      const tmpPath = DATA_SOURCES_PATH + '.tmp'
      writeFileSyncRaw(tmpPath, JSON.stringify({ ...ds, weather: updated }, null, 2), { mode: 0o600 })
      renameSync(tmpPath, DATA_SOURCES_PATH)
      _weatherCache = null // invalidate cache on settings change
      return c.json(updated)
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e).slice(0, 200).replace(/\/[^\s:]+\.(ts|js|json)/g, '[file]') }, 500)
    }
  })

  app.get('/api/weather', async (c) => {
    const settings = getWeatherSettings()
    if (!settings.enabled || !settings.zipCode) return c.json({ enabled: false })

    if (_weatherCache && Date.now() - _weatherCache.fetchedAt < WEATHER_CACHE_MS) {
      return c.json({ enabled: true, ..._weatherCache.data })
    }

    try {
      const res = await fetch(`https://wttr.in/${encodeURIComponent(settings.zipCode)}?format=j1`, {
        headers: { 'User-Agent': 'DailyBriefDashboard/1.0' },
      })
      if (!res.ok) throw new Error(`wttr.in ${res.status}`)
      const raw = await res.json() as any
      const cc = raw.current_condition?.[0] ?? {}
      const data = {
        tempF:     cc.temp_F ?? '',
        condition: cc.weatherDesc?.[0]?.value ?? '',
        humidity:  cc.humidity ?? '',
        feelsLikeF: cc.FeelsLikeF ?? '',
      }
      _weatherCache = { data, fetchedAt: Date.now() }
      return c.json({ enabled: true, ...data })
    } catch (e: any) {
      console.warn('[weather]', e.message)
      return c.json({ enabled: true, error: 'unavailable' })
    }
  })
}
