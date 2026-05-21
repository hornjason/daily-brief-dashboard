import { Hono } from 'hono'
import { aes, customers } from './server-state.ts'
import { sanitizeErr } from './utils.ts'
import {
  initDashboardService,
  computeHealthScores,
  computeSingleHealthScore,
  buildMorningSummary,
  computePriorityAction,
  computeStakeholderEngagement,
  computeTemporalDelta,
  computeFreshnessStatus,
  computeKpiHistory,
  computeAggregatedKPIs,
  computePodSummary,
  lookupTerritoryNames,
  lookupTerritory,
} from './dashboard-service.ts'

export function initDashboardRoutes(opts: {
  cacheDir: string
  rhCasesCachePath: string
  dataSourcesPath: string
}): void {
  initDashboardService(opts)
}


// ── Route registration ────────────────────────────────────────────────────────

export function createDashboardRouter(): Hono {
  const router = new Hono()

  // ── Health Score endpoints (R04) ──────────────────────────────────────────

  router.get('/api/health-scores', (c) => {
    try {
      const scores = computeHealthScores(customers)
      return c.json(scores)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.get('/api/health-scores/:name', (c) => {
    try {
      const name = decodeURIComponent(c.req.param('name'))
      const customer = customers.find(
        cu => cu.name.toLowerCase() === name.toLowerCase(),
      )
      if (!customer) return c.json({ error: 'Customer not found' }, 404)

      const score = computeSingleHealthScore(customer)
      return c.json(score)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Morning Summary + Priority Action (R06/R13) ──────────────────────────

  router.get('/api/morning-summary', async (c) => {
    try {
      const result = await buildMorningSummary(customers)
      return c.json(result)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.get('/api/customer/:name/priority-action', (c) => {
    try {
      const customerName = decodeURIComponent(c.req.param('name'))
      const customer = customers.find(cu => cu.name.toLowerCase() === customerName.toLowerCase())
      if (!customer) return c.json({ error: 'Customer not found' }, 404)

      const result = computePriorityAction(customer, customers)
      return c.json(result)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Stakeholder engagement (R31) ──────────────────────────────────────────
  router.get('/api/customer/:name/stakeholder-engagement', async (c) => {
    try {
      const customerName = decodeURIComponent(c.req.param('name'))
      const customer = customers.find(cu => cu.name.toLowerCase() === customerName.toLowerCase())
      if (!customer) return c.json({ error: 'Customer not found' }, 404)

      const result = await computeStakeholderEngagement(customer)
      return c.json(result)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Temporal delta (R33) ──────────────────────────────────────────────────
  router.get('/api/customer/:name/temporal-delta', async (c) => {
    try {
      const customerName = decodeURIComponent(c.req.param('name'))
      const result = await computeTemporalDelta(customerName)
      return c.json(result)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GitHub Issue #309: Registry-driven data freshness dashboard ─────────
  router.get('/api/status/freshness', (c) => {
    try {
      const result = computeFreshnessStatus()
      return c.json(result)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── R05: KPI history / sparkline data ────────────────────────────────────
  router.get('/api/kpis/history', (c) => {
    const days = parseInt(c.req.query('days') ?? '30', 10)
    try {
      const result = computeKpiHistory(days)
      return c.json(result)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/kpis — Aggregated KPIs for the dashboard ────────────────────
  router.get('/api/kpis', async (c) => {
    try {
      const result = await computeAggregatedKPIs(customers)
      return c.json(result)
    } catch (e: any) {
      return c.json({
        openCasesTotal: 0,
        sev1Count: 0,
        meetingsToday: 0,
        meetingsThisWeek: 0,
        renewalsWithin90Days: 0,
        totalAccounts: customers.length,
        totalProducts: 0,
        totalLicenses: 0,
      }, 500)
    }
  })

  // ── GET /api/pod/summary — Aggregated POD-level KPIs ─────────────────────
  router.get('/api/pod/summary', (c) => {
    try {
      const result = computePodSummary(customers, aes)
      return c.json(result)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/territory-names?pod=WEST_COMM_CORP_NORTHWEST ────────────────
  // Returns all territories for a POD with AE names — used to populate the territory dropdown.
  router.get('/api/territory-names', async (c) => {
    const pod = c.req.query('pod')?.trim()
    if (!pod || !/^[A-Z0-9_]+$/.test(pod)) return c.json({ error: 'Invalid pod format' }, 400)

    const forceRefresh = c.req.query('force') === 'true'
    try {
      const result = await lookupTerritoryNames(pod, forceRefresh)
      return c.json(result)
    } catch (e: any) {
      console.error('[territory-names] error:', e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/territory-lookup?territory=WEST_COMM_CORP_NORTHWEST_TERR01 ──
  // Reads the territory Google Sheet live and returns { aeName, accounts } for
  // the requested territory. Does not require aes.json to be populated.
  router.get('/api/territory-lookup', async (c) => {
    const requestedTerritory = c.req.query('territory')?.trim()
    if (!requestedTerritory || !/^[A-Z0-9_]+$/.test(requestedTerritory)) return c.json({ error: 'Invalid territory format' }, 400)

    const forceRefresh = c.req.query('force') === 'true'
    try {
      const result = await lookupTerritory(requestedTerritory, forceRefresh)
      return c.json(result)
    } catch (e: any) {
      console.error('[territory-lookup] error:', e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
