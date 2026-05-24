/**
 * Emails Module — GitHub Issue #274
 * Migrates legacy email cache to registry signal contract.
 * GitHub Issue #328 — ensureFresh implementation
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const EMAILS_TTL_MS = 4 * 60 * 60 * 1000  // 4 hours

/**
 * Check if email cache exists and is fresh.
 * Returns true if fresh, false if stale or missing.
 */
function isEmailCacheFresh(customerSlug: string): boolean {
  const path = resolve(CACHE_DIR, `${customerSlug}-emails.json`)
  if (!existsSync(path)) return false

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const age = Date.now() - new Date(raw.cachedAt).getTime()
    return age < EMAILS_TTL_MS
  } catch {
    return false
  }
}

FeatureModuleRegistry.register({
  name: 'emails',
  scope: 'customer',
  cachePaths: () => [],
  cacheTtlMs: EMAILS_TTL_MS,
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  refreshEndpoint: '/api/customer/_global/modules/emails/sync',
  async syncNow(customerName: string): Promise<void> {
    if (!customerName || customerName === '_global') return
    const { fetchCustomerEmails } = await import('../customer.ts')
    const { customers } = await import('../server-state.ts')
    const customer = customers.find((c: any) => c.name.toLowerCase() === customerName.toLowerCase())
    if (customer) await fetchCustomerEmails(customer)
  },

  async ensureFresh(customerSlug: string): Promise<void> {
    if (isEmailCacheFresh(customerSlug)) {
      return  // Cache is fresh, nothing to do
    }

    // Cache is stale or missing — trigger refresh
    const { fetchCustomerEmails } = await import('../customer.ts')
    const { customers } = await import('../server-state.ts')
    const customer = customers.find(c => {
      const { toSlug } = require('../cache-layer.ts')
      return toSlug(c.name) === customerSlug
    })

    if (!customer) {
      console.warn(`[emails-module] ensureFresh: customer not found for slug ${customerSlug}`)
      return
    }

    await fetchCustomerEmails(customer)
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, `${customerSlug}-emails.json`)
    if (!existsSync(path)) return []

    let emails: any[]
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      emails = Array.isArray(raw) ? raw : raw.emails ?? []
    } catch { return [] }

    if (emails.length === 0) return []

    return emails.slice(0, 50).map(e => ({
      source: 'emails',
      type: 'email' as const,
      headline: e.subject ?? e.snippet?.substring(0, 80) ?? 'Email',
      detail: `From: ${e.from ?? 'Unknown'} | ${e.date ?? ''}${e.classification ? ` | ${e.classification}` : ''}`,
      rawRelevance: e.classification === 'ACTION_REQUIRED' ? 0.8 : e.classification === 'RESPONSE_NEEDED' ? 0.6 : 0.4,
      timestamp: e.date ?? new Date().toISOString(),
      metadata: {
        customerSlug,
        from: e.from,
        to: e.to,
        classification: e.classification,
        threadId: e.threadId,
      },
    }))
  },
})
