import { readFileSync, writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import type { Hono } from 'hono'
import { sanitizeErr } from './utils.ts'
import { backupNow } from './backup-config.ts'
import { validateOfflineToken } from './redhat.ts'

/** Fire-and-forget backup after data-sources.json write. */
function _triggerBackup(): void {
  backupNow().catch(e => console.warn('[backup] async backup failed:', e.message))
}

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
  supportableEnabled: false, // BKL-UX67: permanently disabled
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
  _triggerBackup()
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

// ── Session timestamp tracking ──────────────────────────────────────────────

type SessionService = 'rh-portal' | 'tableau' | 'salesforce'

const SESSION_KEYS: Record<SessionService, string> = {
  'rh-portal': 'rhPortalSessionAt',
  'tableau': 'tableauSessionAt',
  'salesforce': 'salesforceSessionAt',
}

export function recordSessionEstablished(service: SessionService): void {
  try {
    let ds: Record<string, unknown> = {}
    try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch {}
    ds[SESSION_KEYS[service]] = new Date().toISOString()
    const tmpPath = DATA_SOURCES_PATH + '.tmp'
    writeFileSyncRaw(tmpPath, JSON.stringify(ds, null, 2), { mode: 0o600 })
    renameSync(tmpPath, DATA_SOURCES_PATH)
    _triggerBackup()
  } catch (e: any) {
    console.warn(`[session-timestamps] failed to record ${service}:`, e.message)
  }
}

export function getSessionTimestamps(): Record<string, string | null> {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return {
      'rh-portal': ds.rhPortalSessionAt ?? null,
      'tableau': ds.tableauSessionAt ?? null,
      'salesforce': ds.salesforceSessionAt ?? null,
    }
  } catch {
    return { 'rh-portal': null, 'tableau': null, 'salesforce': null }
  }
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

// ── AI & Intelligence config ─────────────────────────────────────────────────

export interface AiConfig {
  geminiModel: string                // 'gemini-2.5-flash' | 'gemini-2.5-pro'
  geminiModelLite: string            // 'gemini-2.5-flash-lite' — cheap model for high-volume brief/extract calls
  briefSynthesisTemperature: number  // 0.0–1.0
  customerIntelTemperature: number   // 0.0–1.0
  featureExtractionMaxFeatures: number
  geminiInputCostPerM: number        // USD per 1M input tokens
  geminiOutputCostPerM: number       // USD per 1M output tokens
  intelligenceEnabled: boolean       // false = disable all Gemini intelligence generation globally
  docClassifyMaxAgeDays: number      // 0 = unlimited; >0 = skip docs older than N days (BKL-AI-COST-04)
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  geminiModel: 'gemini-2.5-flash',
  geminiModelLite: 'gemini-2.5-flash-lite',
  briefSynthesisTemperature: 0.7,
  customerIntelTemperature: 0.3,
  featureExtractionMaxFeatures: 30,
  geminiInputCostPerM: 0.30,
  geminiOutputCostPerM: 2.50,
  intelligenceEnabled: true,
  docClassifyMaxAgeDays: 0,          // 0 = unlimited (classify all docs regardless of age)
}

export function getAiConfig(): AiConfig {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return { ...DEFAULT_AI_CONFIG, ...(ds.aiConfig ?? {}) }
  } catch { return { ...DEFAULT_AI_CONFIG } }
}

/** Gemini model selection: env var takes precedence over persisted config. */
export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL ?? getAiConfig().geminiModel
}

/** Lite model for high-volume cheap calls (brief-extract, brief-synthesize, product-qa, doc-classify). */
export function getGeminiModelLite(): string {
  return process.env.GEMINI_MODEL_LITE ?? getAiConfig().geminiModelLite
}

// ── Automation config ────────────────────────────────────────────────────────

export interface AutomationConfig {
  defaultScrapeTimeoutMs: number    // default 5 * 60 * 1000 (5 min)
  rhScrapeTimeoutMs: number         // default 10 * 60 * 1000 (10 min)
  circuitBreakerThreshold: number   // default 3
  circuitBreakerCooldownMs: number  // default 5 * 60 * 1000 (5 min)
  driveDocTextCap: number           // chars per doc, default 15000
  briefEmailsInPrompt: number       // emails included in brief, default 20
  briefHistoryDays: number          // days of brief history in prompt, default 7
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  defaultScrapeTimeoutMs: 5 * 60 * 1000,
  rhScrapeTimeoutMs: 10 * 60 * 1000,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 5 * 60 * 1000,
  driveDocTextCap: 15_000,
  briefEmailsInPrompt: 20,
  briefHistoryDays: 7,
}

export function getAutomationConfig(): AutomationConfig {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return { ...DEFAULT_AUTOMATION_CONFIG, ...(ds.automationConfig ?? {}) }
  } catch { return { ...DEFAULT_AUTOMATION_CONFIG } }
}

// ── Offline token helpers ────────────────────────────────────────────────────

/** Persist REDHAT_OFFLINE_TOKEN to data-sources.json so it survives container restarts. */
export function saveOfflineToken(token: string): void {
  let ds: Record<string, unknown> = {}
  try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch {}
  const tmpPath = DATA_SOURCES_PATH + '.tmp'
  writeFileSyncRaw(tmpPath, JSON.stringify({ ...ds, redhatOfflineToken: token }, null, 2), { mode: 0o600 })
  renameSync(tmpPath, DATA_SOURCES_PATH)
}

/** Read the persisted offline token (returns null if not saved). */
export function getPersistedOfflineToken(): string | null {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return typeof ds.redhatOfflineToken === 'string' ? ds.redhatOfflineToken : null
  } catch { return null }
}

// ── Route registration ──────────────────────────────────────────────────────

export function registerSettingsRoutes(app: Hono, deps: { rescheduleRefreshTimers: (intervals: typeof DEFAULT_REFRESH_INTERVALS) => void }): void {
  // GET /api/session-timestamps — when each scraper session was last established
  app.get('/api/session-timestamps', (c) => c.json(getSessionTimestamps()))

  // GET /api/settings/offline-token — check if token is configured (never expose the value)
  app.get('/api/settings/offline-token', (c) => {
    const configured = !!process.env.REDHAT_OFFLINE_TOKEN
    return c.json({ configured })
  })

  // POST /api/settings/offline-token — save REDHAT_OFFLINE_TOKEN to config + process.env
  app.post('/api/settings/offline-token', async (c) => {
    let body: { token?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const token = body.token
    if (typeof token !== 'string' || token.trim() === '') {
      return c.json({ error: 'token is required and must be a non-empty string' }, 400)
    }
    if (/[\r\n]/.test(token)) {
      return c.json({ error: 'token must not contain newline characters' }, 400)
    }
    // Sanity-check length: offline tokens are long JWTs; reject obvious garbage
    if (token.length > 8192) {
      return c.json({ error: 'token exceeds maximum allowed length' }, 400)
    }

    try {
      // BKL-HERO-01 Phase 3: validate before saving — fail loud at paste time
      await validateOfflineToken(token.trim())
      saveOfflineToken(token.trim())
      // Update in-memory env so the change takes effect immediately (no restart needed)
      process.env.REDHAT_OFFLINE_TOKEN = token.trim()
      return c.json({ ok: true })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 400)
    }
  })

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
      _triggerBackup()
      deps.rescheduleRefreshTimers(updated)
      return c.json({ intervals: updated, schedulerConfig: getSchedulerConfig() })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
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
      _triggerBackup()
      _weatherCache = null // invalidate cache on settings change
      return c.json(updated)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── AI & Intelligence settings ────────────────────────────────────────────

  app.get('/api/settings/ai', (c) => c.json({ config: getAiConfig(), defaults: DEFAULT_AI_CONFIG }))

  app.post('/api/settings/ai', async (c) => {
    const body = await c.req.json<Partial<AiConfig>>().catch(() => ({}))
    const current = getAiConfig()
    const ALLOWED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'])
    const updated: AiConfig = { ...current }

    if ('geminiModel' in body) {
      if (typeof body.geminiModel !== 'string' || !ALLOWED_MODELS.has(body.geminiModel)) {
        return c.json({ error: 'geminiModel must be one of: gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-lite' }, 400)
      }
      updated.geminiModel = body.geminiModel
    }
    if ('geminiModelLite' in body) {
      if (typeof body.geminiModelLite !== 'string' || !ALLOWED_MODELS.has(body.geminiModelLite)) {
        return c.json({ error: 'geminiModelLite must be one of: gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-lite' }, 400)
      }
      updated.geminiModelLite = body.geminiModelLite
    }
    const tempKeys: Array<keyof AiConfig> = ['briefSynthesisTemperature', 'customerIntelTemperature']
    for (const k of tempKeys) {
      if (k in body) {
        const v = body[k] as number
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
          return c.json({ error: `${k} must be a number between 0.0 and 1.0` }, 400)
        }
        ;(updated as any)[k] = v
      }
    }
    if ('featureExtractionMaxFeatures' in body) {
      const v = body.featureExtractionMaxFeatures as number
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
        return c.json({ error: 'featureExtractionMaxFeatures must be an integer between 1 and 100' }, 400)
      }
      updated.featureExtractionMaxFeatures = v
    }
    // BKL-WIZ-02: intelligenceEnabled toggle
    if ('intelligenceEnabled' in body) {
      if (typeof body.intelligenceEnabled !== 'boolean') {
        return c.json({ error: 'intelligenceEnabled must be a boolean' }, 400)
      }
      updated.intelligenceEnabled = body.intelligenceEnabled
    }

    const priceKeys: Array<keyof AiConfig> = ['geminiInputCostPerM', 'geminiOutputCostPerM']
    for (const k of priceKeys) {
      if (k in body) {
        const v = body[k] as number
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) {
          return c.json({ error: `${k} must be a non-negative number` }, 400)
        }
        ;(updated as any)[k] = v
      }
    }
    // BKL-AI-COST-04: docClassifyMaxAgeDays — skip doc classification for docs older than N days (0 = unlimited)
    if ('docClassifyMaxAgeDays' in body) {
      const v = body.docClassifyMaxAgeDays as number
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 365) {
        return c.json({ error: 'docClassifyMaxAgeDays must be an integer between 0 and 365' }, 400)
      }
      updated.docClassifyMaxAgeDays = v
    }

    try {
      let ds: Record<string, unknown> = {}
      try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch {}
      const tmpPath = DATA_SOURCES_PATH + '.tmp'
      writeFileSyncRaw(tmpPath, JSON.stringify({ ...ds, aiConfig: updated }, null, 2), { mode: 0o600 })
      renameSync(tmpPath, DATA_SOURCES_PATH)
      _triggerBackup()
      return c.json({ config: updated })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Automation & Limits settings ─────────────────────────────────────────

  app.get('/api/settings/automation', (c) => c.json({ config: getAutomationConfig(), defaults: DEFAULT_AUTOMATION_CONFIG }))

  app.post('/api/settings/automation', async (c) => {
    const body = await c.req.json<Partial<AutomationConfig>>().catch(() => ({}))
    const current = getAutomationConfig()
    const updated: AutomationConfig = { ...current }

    const timeoutKeys: Array<keyof AutomationConfig> = ['defaultScrapeTimeoutMs', 'rhScrapeTimeoutMs', 'circuitBreakerCooldownMs']
    for (const k of timeoutKeys) {
      if (k in body) {
        const v = body[k] as number
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 60_000 || v > 3_600_000) {
          return c.json({ error: `${k} must be an integer between 60000 (1 min) and 3600000 (60 min)` }, 400)
        }
        ;(updated as any)[k] = v
      }
    }

    if ('circuitBreakerThreshold' in body) {
      const v = body.circuitBreakerThreshold as number
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 20) {
        return c.json({ error: 'circuitBreakerThreshold must be an integer between 1 and 20' }, 400)
      }
      updated.circuitBreakerThreshold = v
    }

    if ('driveDocTextCap' in body) {
      const v = body.driveDocTextCap as number
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1_000 || v > 100_000) {
        return c.json({ error: 'driveDocTextCap must be an integer between 1000 and 100000' }, 400)
      }
      updated.driveDocTextCap = v
    }

    if ('briefEmailsInPrompt' in body) {
      const v = body.briefEmailsInPrompt as number
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 50) {
        return c.json({ error: 'briefEmailsInPrompt must be an integer between 1 and 50' }, 400)
      }
      updated.briefEmailsInPrompt = v
    }

    if ('briefHistoryDays' in body) {
      const v = body.briefHistoryDays as number
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 30) {
        return c.json({ error: 'briefHistoryDays must be an integer between 1 and 30' }, 400)
      }
      updated.briefHistoryDays = v
    }

    try {
      let ds: Record<string, unknown> = {}
      try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch {}
      const tmpPath = DATA_SOURCES_PATH + '.tmp'
      writeFileSyncRaw(tmpPath, JSON.stringify({ ...ds, automationConfig: updated }, null, 2), { mode: 0o600 })
      renameSync(tmpPath, DATA_SOURCES_PATH)
      _triggerBackup()
      return c.json({ config: updated })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
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
