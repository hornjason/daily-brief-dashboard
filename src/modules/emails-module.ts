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
import { getAllSlugs, getAliases, resolveToSlug } from '../lib/product-vocabulary.ts'
import { getAllCompetitors } from '../lib/competitive-vocabulary.ts'

// ── Cross-pollination: tech and competitive mention detection (#348) ─────────
// Now dynamic — reads from vocabulary resolvers instead of hardcoded arrays

function buildTechKeywords(): Array<{ pattern: RegExp; slug: string }> {
  const keywords: Array<{ pattern: RegExp; slug: string }> = []
  for (const slug of getAllSlugs()) {
    for (const alias of getAliases(slug)) {
      if (alias.length >= 3) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        keywords.push({ pattern: new RegExp(`\\b${escaped}\\b`, 'i'), slug })
      }
    }
  }
  return keywords
}

function extractTechMentions(text: string): string[] {
  const found = new Set<string>()
  for (const { pattern, slug } of buildTechKeywords()) {
    if (pattern.test(text)) found.add(slug)
  }
  return [...found]
}

function extractCompetitiveMentions(text: string): string[] {
  const found: string[] = []
  const lower = text.toLowerCase()
  for (const kw of getAllCompetitors()) {
    if (kw.length >= 3 && lower.includes(kw.toLowerCase())) found.push(kw)
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
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
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
    if (customer) {
      await fetchCustomerEmails(customer)
      FeatureModuleRegistry.recordOutcome('emails', { success: true })
    }
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
      const searchText = `${e.subject ?? ''} ${e.snippet ?? ''} ${e.bodyText ?? ''} ${e.body ?? ''}`

      // #476 — Use pre-extracted entities from cache when available, fall back to inline extraction
      const cachedEntities = e.entities
      const techMentions = cachedEntities?.techMentions?.length
        ? cachedEntities.techMentions
        : extractTechMentions(searchText)
      const competitiveMentions = cachedEntities?.competitiveMentions?.length
        ? cachedEntities.competitiveMentions
        : extractCompetitiveMentions(searchText)

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
          // #476 — Include full entity data for downstream consumers
          productMentions: cachedEntities?.productMentions ?? [],
          actionItems: cachedEntities?.actionItems ?? [],
        },
      }
    })
  },
})
