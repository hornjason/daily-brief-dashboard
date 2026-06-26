/**
 * Support Cases Module — GitHub Issue #274
 * Migrates legacy cases cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../cache-layer.ts'
import { normalizeForQuery } from '../utils.ts'
import { customers } from '../server-state.ts'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CASES_PATH = resolve(CACHE_DIR, 'cases.json')

function recommendedAction(product: string | undefined): string {
  const p = (product ?? '').toLowerCase()
  if (p.includes('ansible') || p.includes('aap')) return 'Offer automation best practices workshop'
  if (p.includes('openshift') || p.includes('ocp')) return 'Propose architecture review session'
  if (p.includes('rhel') || p.includes('enterprise linux')) return 'Suggest upgrade assessment or health check'
  return `Offer technical deep-dive on ${product ?? 'Unknown'}`
}

FeatureModuleRegistry.register({
  name: 'cases',
  displayName: 'RH Cases',
  refreshEndpoint: '/api/scrape/rh',
  scope: 'portfolio',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: 4 * 60 * 60 * 1000, // 4 hours — data from RH API scraper

  async ensureFresh(_customerSlug: string): Promise<void> {
    try {
      const stat = statSync(CASES_PATH)
      if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) return
    } catch { /* file doesn't exist */ }
    await this.syncNow('')
  },

  cachePaths: () => ['data/cache/cases.json'],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {
    if (!existsSync(CASES_PATH)) return
    try {
      const raw = JSON.parse(readFileSync(CASES_PATH, 'utf-8'))
      const cases = raw.cases ?? (Array.isArray(raw) ? raw : [])
      if (cases.length === 0) {
        console.warn(`[cases-module] syncNow: cache file exists but has 0 cases`)
        FeatureModuleRegistry.recordOutcome('cases', { success: false, error: 'Cache has 0 cases' })
        return
      }
      FeatureModuleRegistry.recordOutcome('cases', { success: true, recordCount: cases.length })
    } catch { /* corrupt cache */ }
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    if (!existsSync(CASES_PATH)) return []

    let allCases: any[]
    try {
      const raw = JSON.parse(readFileSync(CASES_PATH, 'utf-8'))
      allCases = raw.cases ?? (Array.isArray(raw) ? raw : [])
    } catch { return [] }

    const customer = customers.find(c => toSlug(c.name) === customerSlug)
    const needle = normalizeForQuery(customer?.name ?? customerSlug)

    const filterStartTime = performance.now()
    const totalRecords = allCases.length
    const customerCases = allCases.filter(c =>
      normalizeForQuery(c.customerName ?? '').includes(needle) || needle.includes(normalizeForQuery(c.customerName ?? ''))
    )
    const filterElapsed = performance.now() - filterStartTime

    // Only log when filter > 10ms
    if (filterElapsed > 10) {
      console.log(`[signal-perf] cases filter: ${filterElapsed.toFixed(2)}ms (${totalRecords} records → ${customerCases.length} matches)`)
    }

    if (customerCases.length === 0) return []

    // ADR-027: rawRelevance based on severity
    return customerCases.map(c => {
      let rawRelevance = 0.3
      if (c.severity === '1') rawRelevance = 0.9
      else if (c.severity === '2') rawRelevance = 0.7
      else if (c.severity === '3') rawRelevance = 0.5
      else rawRelevance = 0.3

      return {
        source: 'cases',
        type: 'case' as const,
        headline: `Case ${c.caseNumber}: ${c.summary?.substring(0, 80) ?? 'No summary'}`,
        detail: `Status: ${c.status} | Severity: ${c.severity} | Product: ${c.product ?? 'Unknown'} | Open ${c.daysOpen ?? '?'} days`,
        rawRelevance,
        timestamp: new Date().toISOString(),
        url: c.caseNumber ? `https://access.redhat.com/support/cases/#/case/${c.caseNumber}` : undefined,  // #479
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          caseNumber: c.caseNumber,
          status: c.status,
          severity: c.severity,
          product: c.product,
          daysOpen: c.daysOpen,
          caseDescription: c.description || undefined,
          contactName: c.contactName || undefined,
          recommendedAction: recommendedAction(c.product),
        },
      }
    })
  },
})
