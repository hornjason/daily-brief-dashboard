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
  | 'cloud-spend'

export interface Signal {
  /** Module name that produced this signal (e.g., 'news-radar', 'campaigns') */
  source: string
  /** Signal classification */
  type: SignalType
  /** Short summary */
  headline: string
  /** Full content */
  detail: string
  /** 0-1 normalized score, optional — omit when source has no natural ranking */
  score?: number
  /** ISO 8601 timestamp */
  timestamp: string
  /** Optional URL */
  url?: string
  /** Per-type extras (e.g., case severity, subscription node count) */
  metadata?: Record<string, unknown>
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
}

export interface ModuleStatus {
  lastRun: string | null
  lastSuccess: string | null
  lastError: string | null
  state: 'idle' | 'running' | 'failed'
}

export interface StartupCatchUpResult {
  moduleName: string
  action: 'skipped' | 'ran' | 'failed'
  reason: string
}

// ── Internal state ───────────────────────────────────────────────────────────

const _modules = new Map<string, FeatureModule>()
const _status = new Map<string, ModuleStatus>()

// ── Helper functions ─────────────────────────────────────────────────────────

function defaultStatus(): ModuleStatus {
  return {
    lastRun: null,
    lastSuccess: null,
    lastError: null,
    state: 'idle',
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

    return allSignals
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
   * Updates lastRun, lastSuccess/lastError, and state.
   */
  /**
   * Run catch-up for all modules whose lastRun is older than their refreshInterval.
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
      const lastRun = status?.lastRun ? new Date(status.lastRun).getTime() : 0
      const elapsed = Date.now() - lastRun

      if (elapsed < module.refreshInterval) {
        results.push({ moduleName: module.name, action: 'skipped', reason: `last run ${Math.round(elapsed / 60_000)}m ago, interval is ${Math.round(module.refreshInterval / 60_000)}m` })
        continue
      }

      console.log(`[feature-module-registry] startup catch-up: ${module.name} is stale (last run ${status?.lastRun ?? 'never'})`)

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

  recordOutcome(name: string, outcome: { success: boolean; error?: string }): void {
    const now = new Date().toISOString()
    let status = _status.get(name)

    if (!status) {
      status = defaultStatus()
      _status.set(name, status)
    }

    status.lastRun = now

    if (outcome.success) {
      status.lastSuccess = now
      status.lastError = null
      status.state = 'idle'
    } else {
      status.lastError = outcome.error ?? 'Unknown error'
      status.state = 'failed'
    }
  },
}
