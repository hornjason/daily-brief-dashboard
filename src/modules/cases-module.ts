/**
 * Support Cases Module — GitHub Issue #274
 * Migrates legacy cases cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../cache-layer.ts'
import { normalizeForQuery } from '../utils.ts'
import { customers } from '../server-state.ts'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CASES_PATH = resolve(CACHE_DIR, 'cases.json')

FeatureModuleRegistry.register({
  name: 'cases',
  displayName: 'RH Cases',
  refreshEndpoint: '/api/scrape/rh',
  scope: 'portfolio',
  cachePaths: () => ['data/cache/cases.json'],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

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
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          caseNumber: c.caseNumber,
          status: c.status,
          severity: c.severity,
          product: c.product,
          daysOpen: c.daysOpen,
        },
      }
    })
  },
})
