/**
 * Playbook Generator — ADR-026
 *
 * Core generation logic for the Customer Engagement Playbook.
 * Auto-generates playbooks from existing data sources using Gemini
 * for narrative sections and deterministic injection for ground truth data.
 *
 * Three public functions:
 *   - generatePlaybook(customer) — full auto-generation from all data sources
 *   - readPlaybook(customerSlug) — read existing playbook from disk
 *   - writePlaybook(state) — write playbook state atomically
 */

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { toSlug } from './cache-layer.ts'
import { callGemini } from './gemini-call.ts'
import { getAccountTeam, toPromptContext } from './account-team.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import { readSheetCache } from './cache-layer.ts'
import { fetchCases } from './redhat.ts'
import { readProductLifecycleCache } from './product-lifecycle.ts'
import { getAllProductSummaries } from './product-release-radar.ts'
import { getValueMap } from './value-map-loader.ts'
import { getCachedCustomerProductIntel } from './customer-product-intel.ts'
import { getCachedExpansionOpportunities } from './expansion-opportunities.ts'
import { extractProductProofPoints } from './meeting-prep-enrichment.ts'

import type { Customer, SupportCase } from './types.ts'
import type {
  PlaybookState,
  PlaybookSection,
  ProductAlignmentEntry,
  SubscriptionSnapshot,
  CaseSnapshot,
  LifecycleSnapshot,
  PlaybookSource,
} from './playbook-types.ts'

// ── Configuration ───────────────────────────────────────────────────────────

const DATA_DIR = process.env.CACHE_DIR
  ? resolve(process.env.CACHE_DIR, '..')
  : resolve(import.meta.dir, '../data')
const DEFAULT_PLAYBOOKS_DIR = resolve(DATA_DIR, 'cache/playbooks')

function getPlaybooksDir(): string {
  // Test override
  if (process.env.__PLAYBOOK_CACHE_DIR) return process.env.__PLAYBOOK_CACHE_DIR
  return DEFAULT_PLAYBOOKS_DIR
}

function playbookPath(customerSlug: string): string {
  if (!customerSlug || /[^a-zA-Z0-9_-]/.test(customerSlug)) {
    throw new Error(`[playbook] unsafe slug: "${customerSlug}"`)
  }
  return resolve(getPlaybooksDir(), `${customerSlug}.json`)
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Read a playbook from disk. Returns null if not found or malformed.
 */
export function readPlaybook(customerSlug: string): PlaybookState | null {
  try {
    const path = playbookPath(customerSlug)
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as PlaybookState
  } catch {
    return null
  }
}

/**
 * Write a playbook state to disk atomically.
 * Creates the playbooks directory if it doesn't exist.
 */
export function writePlaybook(state: PlaybookState): void {
  const dir = getPlaybooksDir()
  mkdirSync(dir, { recursive: true })
  const path = playbookPath(state.customerSlug)
  writeJsonAtomic(path, state)
}

/**
 * Auto-generate a playbook from all existing data sources.
 *
 * Flow:
 *   1. Load all data sources (signals, team, subscriptions, cases, lifecycle, etc.)
 *   2. Build Gemini prompt for narrative sections (1, 2, 3, 4-use-case, 7, 8)
 *   3. Call Gemini with responseSchema for structured JSON output
 *   4. Post-Gemini: inject deterministic data (proof points, lifecycle, links, etc.)
 *   5. Assemble PlaybookState, write to disk
 */
export async function generatePlaybook(customer: Customer): Promise<PlaybookState> {
  const slug = toSlug(customer.name)
  const now = new Date().toISOString()

  console.log(`[playbook] Generating playbook for ${customer.name} (${slug})`)

  // ── Step 1: Load all data sources ─────────────────────────────────────

  const [
    signalResult,
    teamMembers,
    subCache,
    allCases,
    lifecycleCache,
    productSummaries,
    expansionOpps,
  ] = await Promise.all([
    loadCustomerSignals(slug, customer.name),
    Promise.resolve(getAccountTeam(customer)),
    Promise.resolve(readSheetCache(customer.name)),
    fetchCases({ includeAll: false }).catch(() => [] as SupportCase[]),
    Promise.resolve(readProductLifecycleCache()),
    Promise.resolve(getAllProductSummaries()),
    Promise.resolve(getCachedExpansionOpportunities(slug)),
  ])

  // Intelligence cache
  let intelligenceContext = ''
  try {
    const intelPath = resolve(DATA_DIR, `cache/intelligence/${slug}.json`)
    if (existsSync(intelPath)) {
      const intelData = JSON.parse(readFileSync(intelPath, 'utf-8'))
      if (intelData.company) intelligenceContext += `Company Intelligence:\n${intelData.company}\n\n`
      if (intelData.industry) intelligenceContext += `Industry Analysis:\n${intelData.industry}\n\n`
    }
  } catch (e: any) {
    console.warn(`[playbook] Could not load intelligence cache for ${slug}:`, e?.message)
  }

  // Account plan
  let accountPlanContext = ''
  try {
    const planPath = resolve(DATA_DIR, `cache/intelligence/${slug}-account-plan.md`)
    if (existsSync(planPath)) {
      accountPlanContext = readFileSync(planPath, 'utf-8')
    }
  } catch { /* optional */ }

  // Determine product slugs from subscriptions
  const productSlugs = getProductSlugsFromSubscriptions(subCache)

  // Per-product data
  const perProductData: Array<{
    slug: string
    displayName: string
    valueMap: string | null
    intel: any
    lifecycle: any
    summary: any
  }> = []

  for (const ps of productSlugs) {
    const valueMap = getValueMap(ps)
    const intel = getCachedCustomerProductIntel(ps, slug)
    const lifecycle = lifecycleCache?.products?.find(p => p.slug === ps)
    const summary = productSummaries.find(p => p.slug === ps)
    perProductData.push({
      slug: ps,
      displayName: summary?.displayName ?? lifecycle?.displayName ?? ps.toUpperCase(),
      valueMap,
      intel,
      lifecycle,
      summary,
    })
  }

  // ── Step 2: Build Gemini prompt ───────────────────────────────────────

  const teamContext = toPromptContext(teamMembers)

  const signalSummary = signalResult.registrySignals
    .slice(0, 30)
    .map(s => `[${s.source}] ${s.headline}: ${s.detail}`)
    .join('\n')

  const subscriptionContext = subCache?.rows?.length
    ? subCache.rows.map(r => `${r.productDescription} — qty ${r.quantity}, ${r.status}${r.endDate ? `, ends ${r.endDate}` : ''}`).join('\n')
    : 'No subscription data available.'

  const customerCases = allCases.filter(c => c.customerName === customer.name || (customer.accountNumbers ?? []).some(an => c.accountNumber === an))
  const casesContext = customerCases.length
    ? customerCases.map(c => `Case ${c.caseNumber}: ${c.summary} (${c.status}, Sev ${c.severity}, ${c.daysOpen}d open)`).join('\n')
    : 'No open cases.'

  const productContext = perProductData.map(p => {
    const parts = [`Product: ${p.displayName} (${p.slug})`]
    if (p.intel?.relevanceScore && p.intel.relevanceScore !== 'NONE') {
      parts.push(`  Relevance: ${p.intel.relevanceScore}`)
      if (p.intel.priorityAction) parts.push(`  Priority action: ${p.intel.priorityAction}`)
      if (p.intel.featureTalkingPoints?.length) {
        parts.push(`  Feature talking points: ${p.intel.featureTalkingPoints.slice(0, 3).map((f: any) => `${f.feature} (${f.status}): ${f.reason}`).join('; ')}`)
      }
    }
    if (p.summary?.summaryBullets?.length) {
      parts.push(`  What's new: ${p.summary.summaryBullets.slice(0, 3).join('; ')}`)
    }
    if (p.lifecycle) {
      parts.push(`  Lifecycle: v${p.lifecycle.currentVersion} (GA: ${p.lifecycle.gaDate?.slice(0, 10) ?? '?'}, EOL: ${p.lifecycle.eolDate?.slice(0, 10) ?? '?'})`)
    }
    return parts.join('\n')
  }).join('\n\n')

  const expansionContext = expansionOpps?.recommendations?.length
    ? expansionOpps.recommendations.map(r => `- ${r.product} (${r.confidence}): ${r.why}`).join('\n')
    : ''

  const systemPrompt = `You are a strategic account intelligence analyst for Red Hat. Generate a Customer Engagement Playbook for the specified customer. Your output must be structured JSON matching the schema provided.

The playbook has 6 narrative sections you must generate:
1. strategicPosition — High-level strategic assessment of the customer relationship (200+ chars)
2. keyRelationships — Key contacts, decision makers, and relationship dynamics
3. currentPriorities — What the customer is focused on right now
4. productAlignment — Per-product assessment with use case and confidence level (HIGH/MEDIUM/LOW)
5. expansionOpportunities — Where Red Hat can grow the footprint
6. renewalsAndRisk — Renewal timeline, risk factors, and retention strategy

Sections 5 (openActionItems) and 6 (engagementHistory) are NOT generated — they start empty.

For productAlignment, generate one entry per product with:
- productSlug: the product identifier
- displayName: human-readable product name
- confidence: HIGH, MEDIUM, or LOW based on evidence strength
- useCase: 1-2 sentence description of how the customer uses or should use this product

Be specific, evidence-based, and actionable. Reference actual data from the customer's signals, subscriptions, and cases. Do not fabricate data points.`

  const userPrompt = `Generate the Customer Engagement Playbook for: ${customer.name}

<account_team>
${teamContext}
</account_team>

<signals>
${signalSummary || 'No signals available.'}
</signals>

<subscriptions>
${subscriptionContext}
</subscriptions>

<cases>
${casesContext}
</cases>

<products>
${productContext || 'No product-specific data available.'}
</products>

<expansion_analysis>
${expansionContext || 'No expansion analysis available.'}
</expansion_analysis>

<intelligence>
${intelligenceContext || 'No intelligence cache available.'}
</intelligence>

<account_plan>
${accountPlanContext || 'No account plan available.'}
</account_plan>

Generate the 6 narrative sections plus product alignment entries as structured JSON.`

  // Response schema for structured output
  const responseSchema = {
    type: 'OBJECT',
    properties: {
      strategicPosition: { type: 'STRING', description: 'Strategic position narrative (200+ chars)' },
      keyRelationships: { type: 'STRING', description: 'Key relationships narrative' },
      currentPriorities: { type: 'STRING', description: 'Current priorities narrative' },
      productAlignment: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            productSlug: { type: 'STRING' },
            displayName: { type: 'STRING' },
            confidence: { type: 'STRING', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            useCase: { type: 'STRING' },
          },
          required: ['productSlug', 'displayName', 'confidence', 'useCase'],
        },
      },
      expansionOpportunities: { type: 'STRING', description: 'Expansion opportunities narrative' },
      renewalsAndRisk: { type: 'STRING', description: 'Renewals and risk narrative' },
    },
    required: ['strategicPosition', 'keyRelationships', 'currentPriorities', 'productAlignment', 'expansionOpportunities', 'renewalsAndRisk'],
  }

  // ── Step 3: Call Gemini ───────────────────────────────────────────────

  const geminiResult = await callGemini(systemPrompt, userPrompt, {
    callType: 'playbook-generation',
    customerName: customer.name,
    model: 'full',
    responseSchema,
    deltaKey: `playbook-${slug}`,
    temperature: 0.3,
  })

  let geminiData: {
    strategicPosition: string
    keyRelationships: string
    currentPriorities: string
    productAlignment: Array<{ productSlug: string; displayName: string; confidence: string; useCase: string }>
    expansionOpportunities: string
    renewalsAndRisk: string
  }

  try {
    geminiData = JSON.parse(geminiResult.text)
  } catch {
    console.error(`[playbook] Failed to parse Gemini response for ${slug}`)
    throw new Error(`Gemini returned non-JSON response for playbook generation`)
  }

  // ── Step 4: Inject deterministic data ─────────────────────────────────

  const productEntries: ProductAlignmentEntry[] = (geminiData.productAlignment ?? []).map(gp => {
    const pd = perProductData.find(p => p.slug === gp.productSlug)
    const valueMap = pd?.valueMap ?? null
    const proofPoints = extractProductProofPoints(gp.productSlug, valueMap)
    const summaryBullets = pd?.summary?.summaryBullets ?? []
    const lifecycle = pd?.lifecycle
    const intel = pd?.intel

    return {
      productSlug: gp.productSlug,
      displayName: gp.displayName,
      confidence: gp.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      useCase: gp.useCase,
      proofPoints: proofPoints.length ? proofPoints.join(' | ') : '',
      whatsNew: summaryBullets.slice(0, 3).join('; ') || '',
      lifecycle: lifecycle
        ? `v${lifecycle.currentVersion} (GA: ${lifecycle.gaDate?.slice(0, 10) ?? '?'}, EOL: ${lifecycle.eolDate?.slice(0, 10) ?? '?'})${lifecycle.nextVersion ? ` → Next: v${lifecycle.nextVersion}` : ''}`
        : '',
      featureTalkingPoints: intel?.featureTalkingPoints?.length
        ? intel.featureTalkingPoints.slice(0, 3).map((f: any) => `${f.feature} (${f.status}): ${f.reason}`).join('; ')
        : '',
      dashboardLink: `/dashboard/products/${gp.productSlug}`,
    }
  })

  // Build deterministic snapshots
  const subscriptions: SubscriptionSnapshot[] = (subCache?.rows ?? []).map(r => ({
    sku: r.sku,
    productDescription: r.productDescription,
    quantity: r.quantity,
    status: r.status,
    startDate: r.startDate,
    endDate: r.endDate,
  }))

  const cases: CaseSnapshot[] = customerCases.map(c => ({
    caseNumber: c.caseNumber,
    summary: c.summary,
    status: c.status,
    severity: c.severity,
    product: c.product,
    daysOpen: c.daysOpen,
  }))

  const lifecycle: LifecycleSnapshot[] = (lifecycleCache?.products ?? [])
    .filter(p => productSlugs.length === 0 || productSlugs.includes(p.slug))
    .map(p => ({
      productSlug: p.slug,
      displayName: p.displayName,
      currentVersion: p.currentVersion,
      gaDate: p.gaDate ?? '',
      eolDate: p.eolDate ?? '',
      nextVersion: p.nextVersion ?? undefined,
      nextExpected: p.nextExpected ?? undefined,
    }))

  // ── Step 5: Assemble PlaybookState ────────────────────────────────────

  const defaultSection = (content: string): PlaybookSection => ({
    content,
    updatedAt: now,
    sourceNotes: [],
  })

  const playbookState: PlaybookState = {
    version: 1,
    customerSlug: slug,
    customerName: customer.name,
    generatedAt: now,
    lastMeetingNoteAt: null,
    sections: {
      strategicPosition: defaultSection(geminiData.strategicPosition),
      keyRelationships: defaultSection(geminiData.keyRelationships),
      currentPriorities: defaultSection(geminiData.currentPriorities),
      productAlignment: {
        products: productEntries,
        updatedAt: now,
        sourceNotes: [],
      },
      openActionItems: {
        items: [],
        updatedAt: now,
      },
      engagementHistory: {
        entries: [],
        updatedAt: now,
      },
      expansionOpportunities: defaultSection(geminiData.expansionOpportunities),
      renewalsAndRisk: defaultSection(geminiData.renewalsAndRisk),
    },
    deterministic: {
      subscriptions,
      cases,
      lifecycle,
      teamMembers: teamMembers,
    },
    sources: [
      {
        type: 'auto-generate',
        sourceId: 'auto',
        ingestedAt: now,
        sectionsUpdated: [
          'strategicPosition', 'keyRelationships', 'currentPriorities',
          'productAlignment', 'expansionOpportunities', 'renewalsAndRisk',
        ],
      },
    ],
  }

  // Write to disk
  writePlaybook(playbookState)

  console.log(`[playbook] Playbook generated for ${customer.name}: ${productEntries.length} products, ${subscriptions.length} subscriptions, ${cases.length} cases`)

  return playbookState
}

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Extract product slugs from subscription cache.
 * Same logic as getCustomerProductSlugs in meeting-prep-routes.ts.
 */
function getProductSlugsFromSubscriptions(
  subCache: { rows: Array<{ productDescription: string; [k: string]: any }> } | null
): string[] {
  if (!subCache?.rows) return []
  try {
    const nameToSlug: Record<string, string> = {
      'openshift': 'ocp', 'rhel': 'rhel', 'enterprise linux': 'rhel',
      'ansible': 'aap', 'satellite': 'satellite', 'quay': 'quay',
      'openshift ai': 'rhoai', 'developer hub': 'rhdh',
      'advanced cluster security': 'acs', 'advanced cluster management': 'acm',
    }
    const slugs: string[] = []
    const productNames = [...new Set(subCache.rows.map(r => r.productDescription ?? '').filter(Boolean))]
    for (const name of productNames) {
      const lower = name.toLowerCase()
      for (const [key, val] of Object.entries(nameToSlug)) {
        if (lower.includes(key)) { slugs.push(val); break }
      }
    }
    return [...new Set(slugs)]
  } catch { return [] }
}
