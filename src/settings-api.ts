import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { Hono } from 'hono'
import { sanitizeErr, isValidDriveFolderId } from './utils.ts'
import { backupNow } from './backup-config.ts'
import { validateOfflineToken } from './redhat.ts'
import { generateBrief, getBriefProvider, isBriefConfigured } from './customer.ts'
import { normalizeSettings, getRegionById } from './region-config.ts'
import { readSettingsFromDrive, writeSettingsToDrive, applySettingsToLocal } from './drive-config-sync.ts'
import { loadServerState } from './server-state.ts'
import { initAiConfig, DEFAULT_AI_CONFIG, getAiConfig, getGeminiModel, getGeminiModelLite, DEFAULT_AUTOMATION_CONFIG, getAutomationConfig } from './ai-config.ts'
import type { AiConfig, AutomationConfig } from './ai-config.ts'
export { initAiConfig, DEFAULT_AI_CONFIG, getAiConfig, getGeminiModel, getGeminiModelLite, DEFAULT_AUTOMATION_CONFIG, getAutomationConfig }
export type { AiConfig, AutomationConfig }

/** Fire-and-forget backup after data-sources.json write. */
function _triggerBackup(): void {
  backupNow().catch(e => console.warn('[backup] async backup failed:', e.message))
}

// ── Module state ─────────────────────────────────────────────────────────────
let DATA_SOURCES_PATH = ''
let SETTINGS_PATH_MOD = ''

export function initSettingsApi(dataSourcesPath: string, settingsPath?: string): void {
  DATA_SOURCES_PATH = dataSourcesPath
  if (settingsPath) SETTINGS_PATH_MOD = settingsPath
  initAiConfig(dataSourcesPath)
}

// ── Email delivery settings (BKL-E05) ────────────────────────────────────────

const EMAIL_SETTINGS_PATH = resolve(process.env.DATA_DIR ?? 'data', 'config', 'email-settings.json')

export interface EmailSettings {
  enabled: boolean
  deliveryTime: string
  timezone: string
  schedule: string
  recipientEmail: string
  sections: {
    meetings: boolean
    emails: boolean
    cases: boolean
    pipeline: boolean
    brief: boolean
  }
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  enabled: false,
  deliveryTime: '07:00',
  timezone: 'America/New_York',
  schedule: 'weekdays',
  recipientEmail: '',
  sections: { meetings: true, emails: true, cases: true, pipeline: true, brief: true },
}

export function readEmailSettings(): EmailSettings {
  try {
    if (existsSync(EMAIL_SETTINGS_PATH)) {
      return { ...DEFAULT_EMAIL_SETTINGS, ...JSON.parse(readFileSync(EMAIL_SETTINGS_PATH, 'utf-8')) }
    }
  } catch {}
  return { ...DEFAULT_EMAIL_SETTINGS }
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

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
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
  writeJsonAtomic(DATA_SOURCES_PATH, { ...ds, schedulerConfig: config })
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
    writeJsonAtomic(DATA_SOURCES_PATH, ds)
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

// ── Offline token helpers ────────────────────────────────────────────────────

/** Persist REDHAT_OFFLINE_TOKEN to data-sources.json so it survives container restarts. */
export function saveOfflineToken(token: string): void {
  let ds: Record<string, unknown> = {}
  try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch {}
  writeJsonAtomic(DATA_SOURCES_PATH, { ...ds, redhatOfflineToken: token })
}

/** Read the persisted offline token (returns null if not saved). */
export function getPersistedOfflineToken(): string | null {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return typeof ds.redhatOfflineToken === 'string' ? ds.redhatOfflineToken : null
  } catch { return null }
}

// ── Route registration ──────────────────────────────────────────────────────

export function createSettingsRouter(deps: { rescheduleRefreshTimers: (intervals: typeof DEFAULT_REFRESH_INTERVALS) => void }): Hono {
  const router = new Hono()
  // GET /api/session-timestamps — when each scraper session was last established
  router.get('/api/session-timestamps', (c) => c.json(getSessionTimestamps()))

  // GET /api/settings/offline-token — check if token is configured (never expose the value)
  router.get('/api/settings/offline-token', (c) => {
    const configured = !!process.env.REDHAT_OFFLINE_TOKEN && process.env.REDHAT_OFFLINE_TOKEN !== 'your_offline_token_here'
    return c.json({ configured })
  })

  // POST /api/settings/offline-token — save REDHAT_OFFLINE_TOKEN to config + process.env
  router.post('/api/settings/offline-token', async (c) => {
    let body: { token?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const token = body.token
    // BKL-SEC-11: pre-try 400 error strings MUST be const-derived (no user input, no e.message).
    // sanitizeErr() is used only in catch blocks below. If adding a pre-try 400, follow this contract.
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
  router.get('/api/settings/refresh', (c) => {
    return c.json({
      intervals: getRefreshIntervals(),
      defaults: DEFAULT_REFRESH_INTERVALS,
      schedulerConfig: getSchedulerConfig(),
    })
  })

  // POST /api/settings/refresh — update refresh intervals
  router.post('/api/settings/refresh', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
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
      writeJsonAtomic(DATA_SOURCES_PATH, merged)
      _triggerBackup()
      deps.rescheduleRefreshTimers(updated)
      return c.json({ intervals: updated, schedulerConfig: getSchedulerConfig() })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Weather settings + proxy ──────────────────────────────────────────────

  router.get('/api/settings/weather', (c) => c.json(getWeatherSettings()))

  router.post('/api/settings/weather', async (c) => {
    const body = await c.req.json<Partial<WeatherSettings>>().catch(() => ({} as Partial<WeatherSettings>))
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
      writeJsonAtomic(DATA_SOURCES_PATH, { ...ds, weather: updated })
      _triggerBackup()
      _weatherCache = null // invalidate cache on settings change
      return c.json(updated)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── AI & Intelligence settings ────────────────────────────────────────────

  router.get('/api/settings/ai', (c) => c.json({ config: getAiConfig(), defaults: DEFAULT_AI_CONFIG }))

  router.post('/api/settings/ai', async (c) => {
    const body = await c.req.json<Partial<AiConfig>>().catch(() => ({} as Partial<AiConfig>))
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
      writeJsonAtomic(DATA_SOURCES_PATH, { ...ds, aiConfig: updated })
      _triggerBackup()
      return c.json({ config: updated })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Automation & Limits settings ─────────────────────────────────────────

  router.get('/api/settings/automation', (c) => c.json({ config: getAutomationConfig(), defaults: DEFAULT_AUTOMATION_CONFIG }))

  router.post('/api/settings/automation', async (c) => {
    const body = await c.req.json<Partial<AutomationConfig>>().catch(() => ({} as Partial<AutomationConfig>))
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
      writeJsonAtomic(DATA_SOURCES_PATH, { ...ds, automationConfig: updated })
      _triggerBackup()
      return c.json({ config: updated })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.get('/api/weather', async (c) => {
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

  // ── BKL-ARCH-11: Routes extracted from server.ts ──────────────────────────

  // GET /api/settings/from-drive — fetch Config/settings.json from Drive for a region
  router.get('/api/settings/from-drive', async (c) => {
    const regionId = c.req.query('region')
    try {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(readFileSync(SETTINGS_PATH_MOD, 'utf-8')) as Record<string, unknown>
      } catch {
        return c.json({ error: 'settings.json not found' }, 404)
      }
      const settings = normalizeSettings(raw)
      const region = getRegionById(settings, regionId)
      if (!region.parentFolderId) return c.json({ error: 'parentFolderId not set for this region' }, 404)
      // BKL-SEC-23: defense-in-depth — validate stored folder ID before using in Drive query
      if (!isValidDriveFolderId(region.parentFolderId)) return c.json({ error: 'parentFolderId in stored config is malformed' }, 500)
      try {
        const data = await readSettingsFromDrive(region.parentFolderId)
        return c.json(data)
      } catch (e: any) {
        const msg = String(e?.message ?? '')
        if (msg.includes('Config/ folder not found') || msg.includes('Config/settings.json not found')) {
          return c.json({ error: msg }, 404)
        }
        throw e
      }
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── BKL-DRIVE-BACKUP-API-01: Drive Config/settings.json backup + restore ─
  // Helper: resolve the configured parentFolderId for a region (or first region with one).
  function resolveParentFolderId(regionId?: string): { parentFolderId?: string; error?: string; status?: 404 | 500 } {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(SETTINGS_PATH_MOD, 'utf-8')) as Record<string, unknown>
    } catch {
      return { error: 'parentFolderId not set', status: 404 }
    }
    const settings = normalizeSettings(raw)
    let region
    if (regionId) {
      try { region = getRegionById(settings, regionId) }
      catch { return { error: 'parentFolderId not set', status: 404 } }
    } else {
      region = settings.regions.find(r => r.parentFolderId)
      if (!region) return { error: 'parentFolderId not set', status: 404 }
    }
    if (!region.parentFolderId) return { error: 'parentFolderId not set', status: 404 }
    if (!isValidDriveFolderId(region.parentFolderId)) {
      return { error: 'parentFolderId in stored config is malformed', status: 500 }
    }
    return { parentFolderId: region.parentFolderId }
  }

  // POST /api/config/backup — push local Config/settings.json to Drive
  router.post('/api/config/backup', async (c) => {
    const regionId = c.req.query('region') ?? undefined
    const resolved = resolveParentFolderId(regionId)
    if (resolved.error) return c.json({ error: resolved.error }, resolved.status!)
    try {
      const { fileId } = await writeSettingsToDrive(resolved.parentFolderId!)
      return c.json({ ok: true, fileId })
    } catch (e: any) {
      const msg = String(e?.message ?? '')
      if (msg.includes('Config/ folder not resolvable')) {
        return c.json({ error: 'Config/ folder not resolvable' }, 404)
      }
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/config/restore — pull Drive Config/settings.json into local file
  router.post('/api/config/restore', async (c) => {
    const regionId = c.req.query('region') ?? undefined
    const resolved = resolveParentFolderId(regionId)
    if (resolved.error) return c.json({ error: resolved.error }, resolved.status!)
    try {
      const parsed = await readSettingsFromDrive(resolved.parentFolderId!)
      applySettingsToLocal(normalizeSettings(parsed))
      // Mirror /api/admin/backup/restore — refresh in-memory state from disk
      loadServerState()
      return c.json({ ok: true, applied: true })
    } catch (e: any) {
      const msg = String(e?.message ?? '')
      if (msg.includes('Config/settings.json not found') || msg.includes('Config/ folder not found')) {
        return c.json({ error: 'Config/settings.json not found in Drive' }, 404)
      }
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/config — Dashboard configuration and provider status
  router.get('/api/config', (c) => {
    return c.json({
      briefProvider: getBriefProvider(),
      briefConfigured: isBriefConfigured(),
    })
  })

  // GET /api/config/test — test LLM provider connectivity
  router.get('/api/config/test', async (c) => {
    if (!isBriefConfigured()) {
      return c.json({ ok: false, error: `LLM_PROVIDER=${getBriefProvider()} is not configured. Check your .env file.` })
    }
    try {
      const result = await generateBrief(
        { name: 'Test Account', ae: 'Test', domain: '', accountNumbers: [], segment: '', region: '' } as any,
        [], [], [], [], [], []
      )
      return c.json({ ok: true, provider: getBriefProvider(), preview: result.slice(0, 120) })
    } catch (e: any) {
      return c.json({ ok: false, error: sanitizeErr(e) })
    }
  })

  // GET /api/env/gemini-model — env var status (BKL-SR02)
  router.get('/api/env/gemini-model', (c) => {
    const envVal = process.env.GEMINI_MODEL
    return c.json({ model: envVal ?? null, fromEnv: !!envVal })
  })

  // GET /api/settings/email — read email delivery settings (BKL-E05)
  router.get('/api/settings/email', (c) => {
    return c.json(readEmailSettings())
  })

  // PUT /api/settings/email — update email delivery settings (BKL-E05)
  router.put('/api/settings/email', async (c) => {
    try {
      const body = await c.req.json<Partial<EmailSettings>>().catch((): Partial<EmailSettings> => ({}))
      const current = readEmailSettings()

      // Validate deliveryTime
      if (body.deliveryTime != null) {
        if (typeof body.deliveryTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.deliveryTime)) {
          return c.json({ error: 'deliveryTime must be HH:MM format' }, 400)
        }
      }
      // Validate timezone
      if (body.timezone != null) {
        if (typeof body.timezone !== 'string' || body.timezone.length < 2 || body.timezone.length > 50) {
          return c.json({ error: 'Invalid timezone' }, 400)
        }
        try { Intl.DateTimeFormat(undefined, { timeZone: body.timezone }) }
        catch { return c.json({ error: 'Invalid timezone identifier' }, 400) }
      }
      // Validate schedule
      if (body.schedule != null) {
        if (!['daily', 'weekdays'].includes(body.schedule as string)) {
          return c.json({ error: 'schedule must be "daily" or "weekdays"' }, 400)
        }
      }
      // Validate email
      if (body.recipientEmail != null) {
        if (typeof body.recipientEmail !== 'string' || (body.recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recipientEmail))) {
          return c.json({ error: 'Invalid email address format' }, 400)
        }
        // BKL-SEC-22: RFC 5321 §4.5.3.1.3 caps addresses at 254 chars
        if (body.recipientEmail.length > 254) {
          return c.json({ error: 'Email exceeds RFC 5321 maximum (254 chars)' }, 400)
        }
      }

      const updated: EmailSettings = {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        deliveryTime: body.deliveryTime ?? current.deliveryTime,
        timezone: body.timezone ?? current.timezone,
        schedule: (body.schedule as string) ?? current.schedule,
        recipientEmail: body.recipientEmail ?? current.recipientEmail,
        sections: body.sections ? { ...current.sections, ...body.sections } : current.sections,
      }

      writeJsonAtomic(EMAIL_SETTINGS_PATH, updated)
      return c.json(updated)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
