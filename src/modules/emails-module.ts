/**
 * Emails Module — GitHub Issue #274
 * Migrates legacy email cache to registry signal contract.
 * GitHub Issue #328 — ensureFresh implementation
 * GitHub Issue #348 — Cross-pollination: extract tech-stack and competitive mentions
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { normalizeProductSlug } from '../lib/customer-product-context.ts'

// ── Cross-pollination: tech and competitive mention detection (#348) ─────────

const TECH_KEYWORDS: Array<{ pattern: RegExp; slug: string }> = [
  { pattern: /\bansible\b/i, slug: 'aap' },
  { pattern: /\bopenshift\b/i, slug: 'ocp' },
  { pattern: /\brhel\b/i, slug: 'rhel' },
  { pattern: /\benterprise linux\b/i, slug: 'rhel' },
  { pattern: /\bsatellite\b/i, slug: 'satellite' },
  { pattern: /\bquay\b/i, slug: 'quay' },
  { pattern: /\bdeveloper hub\b/i, slug: 'rhdh' },
  { pattern: /\badvanced cluster security\b/i, slug: 'acs' },
  { pattern: /\badvanced cluster management\b/i, slug: 'acm' },
  { pattern: /\bopenshift ai\b/i, slug: 'rhoai' },
  { pattern: /\brhel ai\b/i, slug: 'rhoai' },
]

const COMPETITIVE_KEYWORDS: string[] = [
  'VMware', 'Tanzu', 'vSphere', 'AWS EKS', 'Azure AKS', 'GKE',
  'Rancher', 'SUSE', 'Canonical', 'Ubuntu', 'CentOS Stream',
  'Docker Enterprise', 'Portworx', 'Nutanix', 'Chef', 'Puppet',
  'Terraform', 'Pulumi', 'CloudFoundry',
]

function extractTechMentions(text: string): string[] {
  const found = new Set<string>()
  for (const { pattern, slug } of TECH_KEYWORDS) {
    if (pattern.test(text)) found.add(slug)
  }
  return [...found]
}

function extractCompetitiveMentions(text: string): string[] {
  const found: string[] = []
  const lower = text.toLowerCase()
  for (const kw of COMPETITIVE_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) found.push(kw)
  }
  return found
}

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
      emails = Array.isArray(raw) ? raw : raw.data ?? raw.emails ?? []
    } catch { return [] }

    if (emails.length === 0) return []

    return emails.slice(0, 50).map(e => {
      const searchText = `${e.subject ?? ''} ${e.snippet ?? ''} ${e.body ?? ''}`
      const techMentions = extractTechMentions(searchText)
      const competitiveMentions = extractCompetitiveMentions(searchText)

      let rawRelevance = e.classification === 'ACTION_REQUIRED' ? 0.8
        : e.classification === 'RESPONSE_NEEDED' ? 0.6 : 0.4

      // Boost relevance when email contains actionable tech or competitive intelligence
      if (techMentions.length > 0 || competitiveMentions.length > 0) {
        rawRelevance = Math.min(1.0, rawRelevance + 0.15)
      }

      return {
        source: 'emails',
        type: 'email' as const,
        headline: e.subject ?? e.snippet?.substring(0, 80) ?? 'Email',
        detail: `From: ${e.from ?? 'Unknown'} | ${e.date ?? ''}${e.classification ? ` | ${e.classification}` : ''}`,
        rawRelevance,
        timestamp: e.date ?? new Date().toISOString(),
        url: e.threadId ? `https://mail.google.com/mail/u/0/#inbox/${e.threadId}` : undefined,  // #479
        metadata: {
          customerSlug,
          from: e.from,
          to: e.to,
          classification: e.classification,
          threadId: e.threadId,
          techMentions,
          competitiveMentions,
        },
      }
    })
  },
})
