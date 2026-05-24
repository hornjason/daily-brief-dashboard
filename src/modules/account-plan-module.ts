/**
 * Account Plan Module — GitHub Issue #274
 * Migrates legacy account plan cache to registry signal contract.
 * GitHub Issue #328 — ensureFresh implementation
 * GitHub Issue #349 — Continuous enrichment from all signal sources
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const ACCOUNT_PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// ── Signal enrichment helpers (#349) ─────────────────────────────────────────

interface EnrichmentSummary {
  cases: { total: number; openSev1: number; openSev2: number }
  pipeline: { totalOpps: number; totalAcv: number }
  emails: { total: number; actionRequired: number }
}

function collectCaseEnrichment(customerSlug: string): EnrichmentSummary['cases'] {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  const casesPath = resolve(cacheDir, 'cases.json')
  if (!existsSync(casesPath)) return { total: 0, openSev1: 0, openSev2: 0 }

  try {
    const raw = JSON.parse(readFileSync(casesPath, 'utf-8'))
    const cases: any[] = raw.cases ?? (Array.isArray(raw) ? raw : [])
    const needle = customerSlug.replace(/-/g, ' ').toLowerCase()
    const customerCases = cases.filter(c => {
      const name = (c.customerName ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
      return name.includes(needle) || needle.includes(name.replace(/\s+/g, ' ').trim())
    })
    return {
      total: customerCases.length,
      openSev1: customerCases.filter(c => c.severity === '1' && c.status !== 'Closed').length,
      openSev2: customerCases.filter(c => c.severity === '2' && c.status !== 'Closed').length,
    }
  } catch { return { total: 0, openSev1: 0, openSev2: 0 } }
}

function collectPipelineEnrichment(customerSlug: string): EnrichmentSummary['pipeline'] {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  const pipePath = resolve(cacheDir, 'pipeline-data.json')
  if (!existsSync(pipePath)) return { totalOpps: 0, totalAcv: 0 }

  try {
    const raw = JSON.parse(readFileSync(pipePath, 'utf-8'))
    const records: any[] = raw.records ?? []
    const needle = customerSlug.replace(/-/g, ' ').toLowerCase()
    const customerRecords = records.filter(r => {
      const name = (r.accountName ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
      return name.includes(needle) || needle.includes(name.replace(/\s+/g, ' ').trim())
    })
    const totalAcv = customerRecords.reduce((sum: number, r: any) => sum + (Number(r.acv) || 0), 0)
    return { totalOpps: customerRecords.length, totalAcv }
  } catch { return { totalOpps: 0, totalAcv: 0 } }
}

function collectEmailEnrichment(customerSlug: string): EnrichmentSummary['emails'] {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  const emailPath = resolve(cacheDir, `${customerSlug}-emails.json`)
  if (!existsSync(emailPath)) return { total: 0, actionRequired: 0 }

  try {
    const raw = JSON.parse(readFileSync(emailPath, 'utf-8'))
    const emails: any[] = Array.isArray(raw) ? raw : raw.emails ?? []
    return {
      total: emails.length,
      actionRequired: emails.filter((e: any) => e.classification === 'ACTION_REQUIRED').length,
    }
  } catch { return { total: 0, actionRequired: 0 } }
}

/**
 * Check if account plan cache exists and is fresh.
 */
function isAccountPlanFresh(customerSlug: string): boolean {
  const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}-account-plan.md`)
  if (!existsSync(path)) return false

  try {
    const age = Date.now() - statSync(path).mtime.getTime()
    return age < ACCOUNT_PLAN_TTL_MS
  } catch {
    return false
  }
}

FeatureModuleRegistry.register({
  name: 'account-plan',
  scope: 'customer',
  cachePaths: () => [],
  cacheTtlMs: ACCOUNT_PLAN_TTL_MS,
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  refreshEndpoint: '/api/customer/_global/modules/account-plan/sync',
  async syncNow(customerName: string): Promise<void> {
    if (!customerName || customerName === '_global') return
    const { generateAndSaveAccountPlan } = await import('../account-plan.ts')
    const { customers } = await import('../server-state.ts')
    const customer = customers.find((c: any) => c.name.toLowerCase() === customerName.toLowerCase())
    if (!customer) return
    const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
    const configDir = process.env.CONFIG_DIR ?? 'config'
    await generateAndSaveAccountPlan(customer, cacheDir, configDir)
  },

  async ensureFresh(customerSlug: string): Promise<void> {
    if (isAccountPlanFresh(customerSlug)) {
      return  // Cache is fresh
    }

    // Cache is stale or missing — trigger generation
    const { generateAndSaveAccountPlan } = await import('../account-plan.ts')
    const { customers } = await import('../server-state.ts')
    const { toSlug } = await import('../cache-layer.ts')
    const customer = customers.find(c => toSlug(c.name) === customerSlug)

    if (!customer) {
      console.warn(`[account-plan-module] ensureFresh: customer not found for slug ${customerSlug}`)
      return
    }

    const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
    const configDir = process.env.CONFIG_DIR ?? 'config'
    await generateAndSaveAccountPlan(customer, cacheDir, configDir)
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}-account-plan.md`)
    if (!existsSync(path)) return []

    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch { return [] }

    if (!content.trim()) return []

    const mtime = statSync(path).mtime.toISOString()
    const firstLine = content.split('\n').find(l => l.trim()) ?? 'Account Plan'

    // #349: Collect enrichment from all signal sources
    const casesEnrich = collectCaseEnrichment(customerSlug)
    const pipelineEnrich = collectPipelineEnrichment(customerSlug)
    const emailsEnrich = collectEmailEnrichment(customerSlug)

    // Boost rawRelevance when enrichment sources have active signals
    let rawRelevance = 0.7
    const activeSourceCount =
      (casesEnrich.total > 0 ? 1 : 0) +
      (pipelineEnrich.totalOpps > 0 ? 1 : 0) +
      (emailsEnrich.total > 0 ? 1 : 0)

    if (activeSourceCount > 0) {
      rawRelevance = Math.min(1.0, rawRelevance + activeSourceCount * 0.05)
    }
    if (casesEnrich.openSev1 > 0) {
      rawRelevance = Math.min(1.0, rawRelevance + 0.1)
    }

    return [{
      source: 'account-plan',
      type: 'account-plan',
      headline: firstLine.replace(/^#+\s*/, '').substring(0, 80),
      detail: content.substring(0, 300),
      rawRelevance,
      timestamp: mtime,
      metadata: {
        customerSlug,
        contentLength: content.length,
        enrichment: {
          cases: casesEnrich,
          pipeline: pipelineEnrich,
          emails: emailsEnrich,
        },
      },
    }]
  },
})
