// src/feature-module-registry.ts
// ADR-020 — Feature Module Registry
// Server-side lifecycle registry for feature modules (campaigns, news, tools, etc.)
// Modeled after ScraperRegistry pattern — self-registration, status tracking, unified cleanup.

// ── Signal types ─────────────────────────────────────────────────────────────
// GitHub Issue #171 — Universal signal interface for auto-discovery

export type SignalType =
  | 'news' | 'intelligence' | 'expansion' | 'subscription'
  | 'case' | 'email' | 'meeting' | 'product-release'
  | 'event' | 'product-intel' | 'account-plan' | 'competitive' | 'brief'
  | 'cloud-spend' | 'qualification-gap' | 'technology'

export interface Signal {
  /** Module name that produced this signal (e.g., 'news-radar', 'campaigns') */
  source: string
  /** Signal classification */
  type: SignalType
  /** Short summary */
  headline: string
  /** Full content */
  detail: string
  /** 0-1 normalized score — SET ONLY BY REGISTRY, NOT MODULES (ADR-027) */
  score?: number
  /** 0-1: module's within-domain ranking (ADR-027) — replaces hardcoded score */
  rawRelevance?: number
  /** ISO 8601 timestamp */
  timestamp: string
  /** Optional URL */
  url?: string
  /** Per-type extras (e.g., case severity, subscription node count) */
  metadata?: Record<string, unknown>
  /** ISO 8601 — signal is stale/irrelevant after this date (GitHub Issue #278) */
  expiresAt?: string
}

// ── Centralized Scoring (ADR-027) ───────────────────────────────────────────

type Specificity = 'customer' | 'industry' | 'general'

const SPECIFICITY_RANGES: Record<Specificity, { floor: number; ceiling: number }> = {
  'customer': { floor: 0.50, ceiling: 1.00 },
  'industry': { floor: 0.35, ceiling: 0.69 },
  'general':  { floor: 0.10, ceiling: 0.35 },
}

const SIGNAL_BUDGETS: Record<string, number> = {
  'pipeline': 10,
  'ccsp': 8,
  'cases': 8,
  'cloud-marketplace': 10,
  'tech-stack': 8,
  'rh-rss': 5,
  'subscriptions': 5,
  'intelligence': 5,
  'value-maps': 3,
  'news-radar': 5,
  'solution-intelligence': 8,
}

const DEFAULT_BUDGET = 5

/**
 * Detect signal specificity from metadata.
 * ADR-027 §1 — Specificity determines score range.
 */
function detectSpecificity(signal: Signal): Specificity {
  const m = signal.metadata ?? {}

  // Customer-specific: has customerSlug, or source is inherently per-customer
  if (m.customerSlug || m.accountNumber || m.severity || m.acvPlus !== undefined) {
    return 'customer'
  }

  if (m.industryMatch) {
    return 'industry'
  }

  return 'general'
}

/**
 * Centralized signal scoring function.
 * ADR-027 §4 — Modules provide rawRelevance + metadata, registry scores.
 */
export function scoreSignal(signal: Signal): Signal {
  const specificity = detectSpecificity(signal)
  const { floor, ceiling } = SPECIFICITY_RANGES[specificity]
  const tierRange = ceiling - floor
  const rawRelevance = signal.rawRelevance ?? 0.5

  let baseScore = floor + (rawRelevance * tierRange)

  // Boosters from metadata (ADR-027 §3)
  const m: any = signal.metadata ?? {}

  if (Array.isArray(m.redHatProducts) && m.redHatProducts.length > 0) baseScore += 0.10
  if ((Number(m.acvPlus) || 0) > 0 || (Number(m.amount) || 0) > 0) baseScore += 0.10
  if (m.confidence === 'HIGH') baseScore += 0.05
  if (m.confidence === 'LOW') baseScore -= 0.10
  if (m.context === 'evaluating' || m.context === 'migrating_from') baseScore += 0.10

  if (m.severity) {
    const sev = Number(m.severity)
    if (sev <= 1) baseScore += 0.15
    else if (sev <= 2) baseScore += 0.10
  }

  if (m.endDate) {
    const daysToEnd = (new Date(String(m.endDate)).getTime() - Date.now()) / 86400000
    if (daysToEnd > 0 && daysToEnd <= 90) baseScore += 0.10
  }

  if (m.hasCloudSpend) baseScore += 0.10

  // Clamp to specificity range
  const finalScore = Math.max(floor, Math.min(ceiling, baseScore))

  return { ...signal, score: finalScore }
}

// ── Time decay function (GitHub Issue #278) ──────────────────────────────────

/**
 * Apply time-decay scoring to a signal.
 * - Signals age linearly over 30 days: score * (1 - dayAge/30), minimum 0.1
 * - Signals with expiresAt in the past get hard floor of 0.05
 * - Signals without score are returned unchanged
 */
export function applyTimeDecay(signal: Signal): Signal {
  if (!signal.score) return signal

  const age = Date.now() - new Date(signal.timestamp).getTime()
  const dayAge = age / (1000 * 60 * 60 * 24)

  // If expired, score drops to 0.05
  if (signal.expiresAt && new Date(signal.expiresAt).getTime() < Date.now()) {
    return { ...signal, score: 0.05 }
  }

  // Linear decay over 30 days: score * (1 - dayAge/30), minimum 0.1
  const decay = Math.max(0.1, 1 - dayAge / 30)
  return { ...signal, score: signal.score * decay }
}

// ── Nav / Scope types (GitHub Issue #234) ────────────────────────────────────

export type ModuleScope = 'portfolio' | 'customer' | 'both'

export interface NavDeclaration {
  label: string
  icon: string
  group: 'actions' | 'intelligence'
  path: string
  order?: number
}

export interface AccountTabDeclaration {
  label: string
  icon: string
  order?: number
}

// ── Feature Module contract ──────────────────────────────────────────────────

export interface FeatureModule {
  /** Unique identifier (e.g., 'campaigns', 'news-radar') */
  name: string
  /** Human-readable name for admin UI (GitHub Issue #308) */
  displayName?: string
  /** API endpoint to trigger manual refresh (GitHub Issue #308) */
  refreshEndpoint?: string
  /** Cache file paths for a given customer slug */
  cachePaths: (slug: string) => string[]
  /** Optional: Drive folder paths this module writes to */
  driveArtifacts?: (slug: string) => string[]
  /** Optional: true if this module produces NotebookLM-syncable content */
  notebookSources?: boolean
  /** Optional: ms between scheduled refreshes, null = on-demand only */
  refreshInterval?: number | null
  /** Pull fresh data for a customer */
  fetch: (customerName: string) => Promise<void>
  /** Remove all data for an archived customer */
  cleanup: (customerName: string) => Promise<void>
  /** Manual trigger (exposed via API) */
  syncNow: (customerName: string) => Promise<void>
  /** Optional: Provide signals for content generation (GitHub Issue #171) */
  signals?: (customerSlug: string) => Promise<Signal[]>
  /** Optional: Navigation declaration for sidebar/header (GitHub Issue #234) */
  nav?: NavDeclaration
  /** Optional: Account detail tab declaration (GitHub Issue #234) */
  accountTab?: AccountTabDeclaration
  /** Optional: Where this module applies — defaults to 'both' (GitHub Issue #234) */
  scope?: ModuleScope
  /** Optional: refresh stale data for a customer before signal collection. Called by ensureSignalsCurrent(). */
  ensureFresh?: (customerSlug: string) => Promise<void>
  /** Optional: how long cached data is considered fresh. Default: 1 hour. */
  cacheTtlMs?: number
}

export interface ModuleStatus {
  lastChecked: string | null    // When we last attempted refresh (even L1 cache hits)
  lastChanged: string | null    // When data actually changed (new records/content)
  lastError: string | null      // Actionable error message
  state: 'idle' | 'refreshing' | 'queued' | 'error'
  recordCount: number | null    // How many records in cache
}

export interface StartupCatchUpResult {
  moduleName: string
  action: 'skipped' | 'ran' | 'failed'
  reason: string
}

// ── Internal state ───────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const _modules = new Map<string, FeatureModule>()
const _status = new Map<string, ModuleStatus>()

// ── Status persistence (GitHub Issue #309) ──────────────────────────────────

const STATUS_MANIFEST_PATH = resolve(
  process.env.CACHE_DIR ?? 'data/cache',
  'data-sources-status.json'
)

function persistStatus(): void {
  try {
    const obj: Record<string, ModuleStatus> = {}
    for (const [name, status] of _status) {
      obj[name] = status
    }
    writeFileSync(STATUS_MANIFEST_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 })
  } catch (e: any) {
    console.warn('[registry] Failed to persist status:', e.message)
  }
}

function loadStatus(): void {
  try {
    if (existsSync(STATUS_MANIFEST_PATH)) {
      const data = JSON.parse(readFileSync(STATUS_MANIFEST_PATH, 'utf-8'))
      for (const [name, status] of Object.entries(data)) {
        if (_status.has(name)) {
          _status.set(name, { ..._status.get(name)!, ...(status as ModuleStatus), state: 'idle' })
        } else {
          _status.set(name, status as ModuleStatus)
        }
      }
      console.log(`[registry] Loaded status for ${Object.keys(data).length} modules from manifest`)
    }
  } catch (e: any) {
    console.warn('[registry] Failed to load status manifest:', e.message)
  }
}

// Load persisted status at module initialization
loadStatus()

// ── Helper functions ─────────────────────────────────────────────────────────

function defaultStatus(): ModuleStatus {
  return {
    lastChecked: null,
    lastChanged: null,
    lastError: null,
    state: 'idle',
    recordCount: null,
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const FeatureModuleRegistry = {
  /**
   * Register a feature module. Warns on duplicate registration but does not throw.
   */
  register(module: FeatureModule): void {
    if (_modules.has(module.name)) {
      console.warn(`[feature-module-registry] duplicate registration for module: ${module.name}`)
    }
    _modules.set(module.name, module)
    if (!_status.has(module.name)) {
      _status.set(module.name, defaultStatus())
    }
  },

  /**
   * Look up a module by name. Returns undefined when not registered.
   */
  get(name: string): FeatureModule | undefined {
    return _modules.get(name)
  },

  /**
   * Snapshot of all registered modules in insertion order.
   */
  list(): FeatureModule[] {
    return Array.from(_modules.values())
  },

  /**
   * Get all registered modules (for ensureSignalsCurrent iteration).
   */
  getRegisteredModules(): FeatureModule[] {
    return Array.from(_modules.values())
  },

  /**
   * Call cleanup() on every registered module for a given customer.
   * Each cleanup is try/caught individually — failures are logged but don't throw.
   * Mirrors ScraperRegistry.adoptAll pattern for error isolation.
   */
  async cleanupAll(customerName: string): Promise<void> {
    for (const module of _modules.values()) {
      try {
        await module.cleanup(customerName)
      } catch (e: any) {
        console.warn(
          `[feature-module-registry] cleanup failed for ${module.name} (customer: ${customerName}):`,
          e?.message ?? e
        )
      }
    }
  },

  /**
   * Call syncNow() on every registered module for a given customer.
   * Each syncNow is try/caught individually — failures are logged but don't throw.
   */
  async syncNowAll(customerName: string): Promise<void> {
    for (const module of _modules.values()) {
      try {
        await module.syncNow(customerName)
      } catch (e: any) {
        console.warn(
          `[feature-module-registry] syncNow failed for ${module.name} (customer: ${customerName}):`,
          e?.message ?? e
        )
      }
    }
  },

  /**
   * Collect signals from all registered modules that implement signals().
   * Each module is try/caught individually — failures are logged but don't throw (fail-open).
   * Returns a flat array of all signals from all modules.
   * GitHub Issue #171 — Signal auto-discovery
   * GitHub Issue #277 — Performance instrumentation
   * GitHub Issue #278 — Apply time-decay scoring before returning
   */
  async collectAllSignals(customerSlug: string): Promise<Signal[]> {
    const startTime = performance.now()
    const allSignals: Signal[] = []
    const moduleTimes: Array<{ name: string; ms: number; count: number }> = []

    for (const module of _modules.values()) {
      // Skip modules that don't implement signals()
      if (!module.signals) {
        continue
      }

      const moduleStartTime = performance.now()
      try {
        const signals = await module.signals(customerSlug)
        const moduleElapsed = performance.now() - moduleStartTime
        moduleTimes.push({ name: module.name, ms: moduleElapsed, count: signals.length })
        allSignals.push(...signals)
      } catch (e: any) {
        const moduleElapsed = performance.now() - moduleStartTime
        moduleTimes.push({ name: module.name, ms: moduleElapsed, count: 0 })
        console.warn(
          `[feature-module-registry] signals() failed for ${module.name} (customer: ${customerSlug}):`,
          e?.message ?? e
        )
      }
    }

    const totalElapsed = performance.now() - startTime

    // Only log when total time > 50ms (don't spam logs for fast calls)
    if (totalElapsed > 50) {
      console.log(
        `[signal-perf] collectAllSignals for ${customerSlug}: ${totalElapsed.toFixed(2)}ms (${allSignals.length} signals from ${moduleTimes.length} modules)`
      )
      for (const { name, ms, count } of moduleTimes) {
        console.log(`[signal-perf]   ${name}: ${ms.toFixed(2)}ms (${count} signals)`)
      }
    }

    // ADR-027: Score centrally, apply time decay, budget-cap per source
    const scored = allSignals.map(scoreSignal).map(applyTimeDecay)

    // Budget cap per source
    const bySource = new Map<string, Signal[]>()
    for (const s of scored) {
      const group = bySource.get(s.source) ?? []
      group.push(s)
      bySource.set(s.source, group)
    }

    const budgeted: Signal[] = []
    for (const [source, signals] of bySource) {
      const cap = SIGNAL_BUDGETS[source] ?? DEFAULT_BUDGET
      signals.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      budgeted.push(...signals.slice(0, cap))
    }

    budgeted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    return budgeted
  },

  /**
   * Return modules that declare nav, sorted by nav.order ascending (nulls last).
   * GitHub Issue #234 — Nav auto-discovery
   */
  getNav(): Array<{ name: string; nav: NavDeclaration; scope: ModuleScope }> {
    const entries: Array<{ name: string; nav: NavDeclaration; scope: ModuleScope }> = []
    for (const module of _modules.values()) {
      if (module.nav) {
        entries.push({ name: module.name, nav: module.nav, scope: module.scope ?? 'both' })
      }
    }
    return entries.sort((a, b) => {
      const oa = a.nav.order ?? Number.MAX_SAFE_INTEGER
      const ob = b.nav.order ?? Number.MAX_SAFE_INTEGER
      return oa - ob
    })
  },

  /**
   * Return modules that declare accountTab, sorted by accountTab.order ascending (nulls last).
   * GitHub Issue #234 — AccountTab auto-discovery
   */
  getAccountTabs(): Array<{ name: string; accountTab: AccountTabDeclaration; scope: ModuleScope }> {
    const entries: Array<{ name: string; accountTab: AccountTabDeclaration; scope: ModuleScope }> = []
    for (const module of _modules.values()) {
      if (module.accountTab) {
        entries.push({ name: module.name, accountTab: module.accountTab, scope: module.scope ?? 'both' })
      }
    }
    return entries.sort((a, b) => {
      const oa = a.accountTab.order ?? Number.MAX_SAFE_INTEGER
      const ob = b.accountTab.order ?? Number.MAX_SAFE_INTEGER
      return oa - ob
    })
  },

  /**
   * Get status map for all registered modules.
   * Returns a record keyed by module name.
   */
  getStatus(): Record<string, ModuleStatus> {
    const result: Record<string, ModuleStatus> = {}
    for (const [name, status] of _status.entries()) {
      result[name] = { ...status }
    }
    return result
  },

  /**
   * Record the outcome of a fetch/syncNow operation.
   * Updates lastChecked, lastChanged/lastError, and state.
   */
  /**
   * Run catch-up for all modules whose lastChecked is older than their refreshInterval.
   * Called once at startup to handle missed scheduled runs (e.g., container was down overnight).
   * Modules with refreshInterval=null (on-demand only) are skipped.
   */
  async startupCatchUp(customerNames: string[]): Promise<StartupCatchUpResult[]> {
    const results: StartupCatchUpResult[] = []

    for (const module of _modules.values()) {
      if (!module.refreshInterval) {
        results.push({ moduleName: module.name, action: 'skipped', reason: 'on-demand only (no refreshInterval)' })
        continue
      }

      const status = _status.get(module.name)
      const lastChecked = status?.lastChecked ? new Date(status.lastChecked).getTime() : 0
      const elapsed = Date.now() - lastChecked

      if (elapsed < module.refreshInterval) {
        results.push({ moduleName: module.name, action: 'skipped', reason: `last checked ${Math.round(elapsed / 60_000)}m ago, interval is ${Math.round(module.refreshInterval / 60_000)}m` })
        continue
      }

      console.log(`[feature-module-registry] startup catch-up: ${module.name} is stale (last checked ${status?.lastChecked ?? 'never'})`)

      for (const customerName of customerNames) {
        try {
          await module.fetch(customerName)
          this.recordOutcome(module.name, { success: true })
        } catch (e: any) {
          console.warn(`[feature-module-registry] catch-up failed for ${module.name}/${customerName}:`, e?.message ?? e)
          this.recordOutcome(module.name, { success: false, error: e?.message })
        }
        await new Promise(r => setTimeout(r, 2000))
      }

      results.push({ moduleName: module.name, action: 'ran', reason: `stale — ran for ${customerNames.length} customers` })
    }

    return results
  },

  /**
   * Pre-flight refresh: sync any modules whose last run is older than their
   * refreshInterval (or 1 hour for on-demand modules). Called before content
   * generation (meeting prep, campaigns, briefs) to ensure fresh signals.
   * Fails open — refresh errors don't block generation.
   * GitHub Issue #285
   */
  async refreshStaleSignals(customerSlug: string): Promise<{ refreshed: string[]; skipped: string[]; failed: string[] }> {
    const MAX_WAIT_MS = 30_000
    const ON_DEMAND_STALE_MS = 60 * 60 * 1000 // 1 hour for modules without refreshInterval
    const refreshed: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    const startTime = performance.now()
    const promises: Promise<void>[] = []

    for (const module of _modules.values()) {
      if (!module.syncNow) { skipped.push(module.name); continue }

      const status = _status.get(module.name)
      const lastChecked = status?.lastChecked ? new Date(status.lastChecked).getTime() : 0
      const elapsed = Date.now() - lastChecked
      const threshold = module.refreshInterval ?? ON_DEMAND_STALE_MS

      if (elapsed < threshold) {
        skipped.push(module.name)
        continue
      }

      promises.push(
        module.syncNow(customerSlug)
          .then(() => {
            this.recordOutcome(module.name, { success: true })
            refreshed.push(module.name)
          })
          .catch((e: any) => {
            console.warn(`[signal-refresh] ${module.name} failed: ${e?.message ?? e}`)
            this.recordOutcome(module.name, { success: false, error: e?.message })
            failed.push(module.name)
          })
      )
    }

    if (promises.length > 0) {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise(r => setTimeout(r, MAX_WAIT_MS)),
      ])
      const elapsed = performance.now() - startTime
      console.log(`[signal-refresh] pre-flight for ${customerSlug}: ${refreshed.length} refreshed, ${skipped.length} skipped, ${failed.length} failed (${elapsed.toFixed(0)}ms)`)
    }

    return { refreshed, skipped, failed }
  },

  recordOutcome(name: string, outcome: { success: boolean; error?: string; recordCount?: number; dataChanged?: boolean }): void {
    const now = new Date().toISOString()
    let status = _status.get(name)

    if (!status) {
      status = defaultStatus()
      _status.set(name, status)
    }

    status.lastChecked = now

    if (outcome.success) {
      // Only update lastChanged when data actually changed (not a no-op refresh)
      if (outcome.dataChanged !== false) {
        status.lastChanged = now
      }
      status.lastError = null
      status.state = 'idle'
    } else {
      status.lastError = outcome.error ?? 'Unknown error'
      status.state = 'error'
    }

    if (outcome.recordCount !== undefined) {
      status.recordCount = outcome.recordCount
    }

    persistStatus()
  },

  /**
   * Get status map for all modules (including non-registered ones seeded from manifest).
   * Returns a record keyed by module name. GitHub Issue #309
   */
  getAllStatus(): Record<string, ModuleStatus> {
    const result: Record<string, ModuleStatus> = {}
    for (const [name, status] of _status) {
      result[name] = { ...status }
    }
    return result
  },

  /**
   * Update status for a module externally (e.g., L1 cache hits, scraper bridges).
   * GitHub Issue #309
   */
  updateStatus(name: string, partial: Partial<ModuleStatus>): void {
    const current = _status.get(name) ?? defaultStatus()
    _status.set(name, { ...current, ...partial })
    persistStatus()
  },

  getAllModules(): Array<{ name: string; displayName: string; refreshEndpoint: string | null; refreshInterval: number | null; scope: ModuleScope }> {
    const result: Array<{ name: string; displayName: string; refreshEndpoint: string | null; refreshInterval: number | null; scope: ModuleScope }> = []
    for (const module of _modules.values()) {
      result.push({
        name: module.name,
        displayName: module.displayName ?? module.name,
        refreshEndpoint: module.refreshEndpoint ?? null,
        refreshInterval: module.refreshInterval ?? null,
        scope: module.scope ?? 'both',
      })
    }
    return result
  },

  /**
   * Get architecture compliance report — GitHub Issue #329
   * Categorizes modules by ensureFresh/cacheTtlMs implementation.
   */
  getComplianceReport(): {
    totalModules: number
    signalProducers: number
    withEnsureFresh: number
    withCacheTtl: number
    compliant: string[]
    advisory: string[]
    exempt: string[]
    score: number
  } {
    const modules = Array.from(_modules.values())
    const signalProducers = modules.filter(m => m.signals)
    const withEnsureFresh = signalProducers.filter(m => m.ensureFresh)
    const withCacheTtl = signalProducers.filter(m => m.cacheTtlMs)
    const compliant = signalProducers.filter(m => m.ensureFresh && m.cacheTtlMs).map(m => m.name)
    const advisory = signalProducers.filter(m => !m.ensureFresh || !m.cacheTtlMs).map(m => m.name)
    const exempt = modules.filter(m => !m.signals).map(m => m.name)

    const score = signalProducers.length > 0
      ? Math.round((compliant.length / signalProducers.length) * 100)
      : 100

    return {
      totalModules: modules.length,
      signalProducers: signalProducers.length,
      withEnsureFresh: withEnsureFresh.length,
      withCacheTtl: withCacheTtl.length,
      compliant,
      advisory,
      exempt,
      score,
    }
  },

  async getHealthReport(testCustomerSlug?: string): Promise<{
    modules: Array<{
      name: string
      status: 'healthy' | 'warning' | 'error'
      warnings: string[]
      signalCount: number
      tierDistribution: Record<string, number>
    }>
  }> {
    const modules = this.getRegisteredModules()
    const results: Array<{ name: string; status: 'healthy' | 'warning' | 'error'; warnings: string[]; signalCount: number; tierDistribution: Record<string, number> }> = []

    for (const mod of modules) {
      if (!mod.signals) {
        results.push({ name: mod.name, status: 'healthy', warnings: [], signalCount: 0, tierDistribution: {} })
        continue
      }

      try {
        const slug = testCustomerSlug ?? '_global'
        const signals = await mod.signals(slug)
        const scored = signals.map(scoreSignal)
        const warnings: string[] = []
        const tierDist: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Low: 0, Noise: 0 }

        for (const s of scored) {
          const sc = s.score ?? 0
          if (sc >= 0.90) tierDist.Critical++
          else if (sc >= 0.70) tierDist.High++
          else if (sc >= 0.50) tierDist.Medium++
          else if (sc >= 0.35) tierDist.Low++
          else tierDist.Noise++
        }

        if (scored.length === 0) warnings.push('No signals returned')
        if (scored.length > 0 && tierDist.Noise === scored.length) warnings.push('All signals scoring as Noise — check metadata')
        if (scored.length > 0 && new Set(scored.map(s => s.rawRelevance)).size === 1) warnings.push('All signals have same rawRelevance — no differentiation')
        if (scored.length > 0 && !scored.some(s => s.metadata?.customerSlug)) warnings.push('No customerSlug in metadata — all scoring as general')

        const status = warnings.some(w => w.includes('All signals scoring as Noise')) ? 'error' as const
          : warnings.length > 0 ? 'warning' as const : 'healthy' as const

        results.push({ name: mod.name, status, warnings, signalCount: scored.length, tierDistribution: tierDist })
      } catch (e: any) {
        results.push({ name: mod.name, status: 'error', warnings: [`Module threw: ${e.message}`], signalCount: 0, tierDistribution: {} })
      }
    }

    return { modules: results }
  },

  _resetForTesting(): void {
    _modules.clear()
    _status.clear()
  },
}
