// GitHub Issue #197 — Product lifecycle feature module
// Registers product lifecycle fetcher with the Feature Module Registry
// and provides Signal generation for content generation features.
// GitHub Issue #350 — Version detection from cases and tech-stack

import { FeatureModuleRegistry, type Signal, type NavDeclaration, type ModuleScope } from '../feature-module-registry.ts'
import { fetchProductLifecycle, readProductLifecycleCache } from '../product-lifecycle.ts'
import { existsSync, unlinkSync, statSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { getCustomerProductContext } from '../lib/customer-product-context.ts'

const CACHE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'product-lifecycle.json')
const LIFECYCLE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// GitHub Issue #351 — Static URL mapping for lifecycle pages and upgrade guides
const PRODUCT_URLS: Record<string, { lifecycleUrl: string; upgradeGuideUrl: string | null }> = {
  'ocp': {
    lifecycleUrl: 'https://access.redhat.com/product-life-cycles#/openshift_container_platform',
    upgradeGuideUrl: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/upgrading/',
  },
  'rhel': {
    lifecycleUrl: 'https://access.redhat.com/product-life-cycles#/red_hat_enterprise_linux',
    upgradeGuideUrl: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/upgrading_from_rhel_9_to_rhel_10/',
  },
  'aap': {
    lifecycleUrl: 'https://access.redhat.com/product-life-cycles#/ansible_automation_platform',
    upgradeGuideUrl: 'https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.6/html/red_hat_ansible_automation_platform_upgrade_and_migration_guide/',
  },
}

// ── Version detection from cases and tech-stack (#350) ───────────────────────

const PRODUCT_CASE_PATTERNS: Record<string, RegExp> = {
  'ocp': /(?:openshift|ocp)\s*(\d+\.\d+(?:\.\d+)?)/i,
  'rhel': /(?:enterprise\s+linux|rhel)\s*(\d+(?:\.\d+)*)/i,
  'aap': /(?:ansible\s+automation|aap)\s*(\d+(?:\.\d+)*)/i,
}

const PRODUCT_TECH_PATTERNS: Record<string, RegExp> = {
  'ocp': /(?:openshift|ocp)\s*(\d+\.\d+(?:\.\d+)?)/i,
  'rhel': /(?:enterprise\s+linux|rhel)\s*(\d+(?:\.\d+)*)/i,
  'aap': /(?:ansible|aap)\s*(\d+(?:\.\d+)*)/i,
}

function detectVersionsFromCases(productSlug: string, customerSlug: string): string[] {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  const casesPath = resolve(cacheDir, 'cases.json')
  if (!existsSync(casesPath)) return []

  const pattern = PRODUCT_CASE_PATTERNS[productSlug]
  if (!pattern) return []

  try {
    const raw = JSON.parse(readFileSync(casesPath, 'utf-8'))
    const cases: any[] = raw.cases ?? (Array.isArray(raw) ? raw : [])

    // Filter to customer cases using slug-based matching
    const needle = customerSlug.replace(/-/g, ' ').toLowerCase()
    const customerCases = cases.filter(c => {
      const name = (c.customerName ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
      return name.includes(needle) || needle.includes(name.replace(/\s+/g, ' ').trim())
    })

    const versions = new Set<string>()
    for (const c of customerCases) {
      const match = pattern.exec(c.product ?? '')
      if (match) versions.add(match[1])
    }
    return [...versions]
  } catch { return [] }
}

function detectVersionsFromTechStack(productSlug: string, customerSlug: string): string[] {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  const techPath = resolve(cacheDir, 'tech-stack', `${customerSlug}.json`)
  if (!existsSync(techPath)) return []

  const pattern = PRODUCT_TECH_PATTERNS[productSlug]
  if (!pattern) return []

  try {
    const raw = JSON.parse(readFileSync(techPath, 'utf-8'))
    const technologies: any[] = raw.technologies ?? []

    const versions = new Set<string>()
    for (const tech of technologies) {
      const match = pattern.exec(tech.name ?? '')
      if (match) versions.add(match[1])
    }
    return [...versions]
  } catch { return [] }
}

function isOlderMajorVersion(detected: string[], currentVersion: string): boolean {
  if (detected.length === 0) return false
  const currentMajor = parseInt(currentVersion.split('.')[0], 10)
  if (isNaN(currentMajor)) return false

  return detected.some(v => {
    const major = parseInt(v.split('.')[0], 10)
    return !isNaN(major) && major < currentMajor
  })
}

FeatureModuleRegistry.register({
  name: 'product-lifecycle',
  displayName: 'Product Lifecycle',
  refreshEndpoint: '/api/products/refresh-all',

  scope: 'portfolio',

  nav: {
    label: 'Products',
    icon: 'Package',
    group: 'intelligence',
    path: '/dashboard/products',
    order: 10,
  },

  cachePaths: () => ['data/cache/product-lifecycle.json'],

  cacheTtlMs: LIFECYCLE_TTL_MS,

  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // weekly

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Portfolio-wide cache — check single file
    try {
      const stat = statSync(CACHE_PATH)
      if (Date.now() - stat.mtimeMs < LIFECYCLE_TTL_MS) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — refresh
    await fetchProductLifecycle()
  },

  async fetch(_customerName: string): Promise<void> {
    // Product lifecycle is global, not customer-specific
    await fetchProductLifecycle()
  },

  async cleanup(_customerName: string): Promise<void> {
    // Remove cache file when cleaning up (global, not per-customer)
    if (existsSync(CACHE_PATH)) {
      unlinkSync(CACHE_PATH)
    }
  },

  async syncNow(_customerName: string): Promise<void> {
    // Same as fetch for this module
    await fetchProductLifecycle()
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const cache = readProductLifecycleCache()

    if (!cache || !cache.products) {
      return []
    }

    const context = getCustomerProductContext(customerSlug)
    const signals: Signal[] = []
    const now = new Date()

    for (const product of cache.products) {
      // GitHub Issue #351 — Get lifecycle and upgrade guide URLs early
      const urls = PRODUCT_URLS[product.slug] || {
        lifecycleUrl: 'https://access.redhat.com/product-life-cycles',
        upgradeGuideUrl: null
      }

      // ADR-029: rawRelevance based on lifecycle urgency
      let rawRelevance = 0.5

      if (product.eolDate && product.eolDate !== 'N/A') {
        try {
          const eolDate = new Date(product.eolDate)
          const daysUntilEol = Math.floor((eolDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

          if (daysUntilEol < 90) {
            rawRelevance = 0.9
          } else if (product.nextVersion) {
            rawRelevance = 0.7
          }
        } catch {
          // Invalid date format — use default
        }
      } else if (product.nextVersion) {
        rawRelevance = 0.7
      }

      const versionPart = `${product.displayName.replace('Red Hat ', '')} ${product.currentVersion}`
      const eolPart = product.eolDate !== 'N/A'
        ? `EOL ${new Date(product.eolDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}`
        : 'Active support'

      const headline = `${versionPart} — ${eolPart}`

      const parts: string[] = []
      parts.push(`Current version: ${product.latestPatch}`)
      parts.push(`GA: ${new Date(product.gaDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`)
      parts.push(`Support ends: ${new Date(product.supportEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`)

      if (product.eusAvailable) {
        parts.push('EUS available')
      }

      if (product.nextVersion && product.nextExpected) {
        parts.push(`Next version: ${product.nextVersion} (expected ${new Date(product.nextExpected).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })})`)
      }

      // GitHub Issue #351 — Include lifecycle and upgrade guide URLs in detail
      parts.push(`Lifecycle: ${urls.lifecycleUrl}`)
      if (urls.upgradeGuideUrl) {
        parts.push(`Upgrade guide: ${urls.upgradeGuideUrl}`)
      }

      const detail = parts.join(' | ')

      // ADR-029: cross-reference against customer subscriptions/interests
      const isOwned = context.ownedProducts.includes(product.slug)
      const isInterest = !isOwned && context.interestProducts.includes(product.slug)

      // #350: Detect customer versions from cases and tech-stack
      const caseVersions = detectVersionsFromCases(product.slug, customerSlug)
      const techVersions = detectVersionsFromTechStack(product.slug, customerSlug)
      const detectedVersions = [...new Set([...caseVersions, ...techVersions])]
      const hasOlderVersion = isOlderMajorVersion(detectedVersions, product.currentVersion)

      if (hasOlderVersion) {
        rawRelevance = Math.min(1.0, rawRelevance + 0.2)
      }

      const metadata: Record<string, any> = {
        slug: product.slug,
        currentVersion: product.currentVersion,
        latestPatch: product.latestPatch,
        eolDate: product.eolDate,
        nextVersion: product.nextVersion,
        nextExpected: product.nextExpected,
        eusAvailable: product.eusAvailable,
        lifecycleUrl: urls.lifecycleUrl,
        upgradeGuideUrl: urls.upgradeGuideUrl,
        detectedVersions,
        hasOlderVersion,
      }

      if (isOwned) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'subscription'
        metadata.redHatProducts = [product.slug]
      } else if (isInterest) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'interest'
        metadata.context = 'evaluating'
        metadata.redHatProducts = [product.slug]
      }

      signals.push({
        source: 'product-lifecycle',
        type: 'product-release',
        headline,
        detail,
        rawRelevance,
        timestamp: cache.fetchedAt,
        metadata,
      })
    }

    return signals
  },
})
