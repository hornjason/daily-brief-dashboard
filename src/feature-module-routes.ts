// src/feature-module-routes.ts
// GitHub Issue #144 — Sync Now API endpoint for registered feature modules
import { Hono } from 'hono'
import { FeatureModuleRegistry } from './feature-module-registry'
import { customers } from './server-state'
import { sanitizeErr } from './utils'
import { schedulerRegistry } from './scheduler-registry'

export function createFeatureModuleRouter() {
  const router = new Hono()

  // POST /api/customer/:name/modules/:moduleName/sync
  router.post('/api/customer/:name/modules/:moduleName/sync', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const moduleName = c.req.param('moduleName')

    const module = FeatureModuleRegistry.get(moduleName)
    if (!module) {
      return c.json({ error: `Module '${moduleName}' not found` }, 404)
    }

    // Portfolio-scope modules accept _global as a sentinel (no customer needed)
    const isGlobal = customerName === '_global'
    if (!isGlobal) {
      const customer = customers.find(cu => cu.name.toLowerCase() === customerName.toLowerCase())
      if (!customer) {
        return c.json({ error: `Customer '${customerName}' not found` }, 404)
      }
    }

    try {
      await module.syncNow(customerName)
      FeatureModuleRegistry.recordOutcome(moduleName, { success: true })
      return c.json({ success: true, module: moduleName, customer: customerName })
    } catch (e: any) {
      FeatureModuleRegistry.recordOutcome(moduleName, { success: false, error: sanitizeErr(e) })
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/feature-modules/nav — GitHub Issue #234
  router.get('/api/feature-modules/nav', (c) => {
    const navEntries = FeatureModuleRegistry.getNav()
    const tabEntries = FeatureModuleRegistry.getAccountTabs()

    // Merge into a single list: all modules that declare nav OR accountTab
    const merged = new Map<string, { name: string; nav?: any; accountTab?: any; scope: string }>()

    for (const entry of navEntries) {
      merged.set(entry.name, { name: entry.name, nav: entry.nav, scope: entry.scope })
    }
    for (const entry of tabEntries) {
      const existing = merged.get(entry.name)
      if (existing) {
        existing.accountTab = entry.accountTab
      } else {
        merged.set(entry.name, { name: entry.name, accountTab: entry.accountTab, scope: entry.scope })
      }
    }

    return c.json(Array.from(merged.values()))
  })

  // GET /api/modules/status
  router.get('/api/modules/status', (c) => {
    const status = FeatureModuleRegistry.getStatus()
    const modules = Object.entries(status).map(([name, s]) => ({
      name,
      ...s,
      refreshInterval: FeatureModuleRegistry.get(name)?.refreshInterval ?? null
    }))
    return c.json({ modules })
  })

  // GET /api/modules/compliance — GitHub Issue #329
  router.get('/api/modules/compliance', (c) => {
    const report = FeatureModuleRegistry.getComplianceReport()
    return c.json(report)
  })

  // GET /api/admin/scheduler-status — ADR-028 Phase 1
  router.get('/api/admin/scheduler-status', (c) => {
    const entries = schedulerRegistry.getStatus()
    return c.json({ entries })
  })

  return router
}
