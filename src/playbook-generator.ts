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
import { templateAll } from './lib/signal-templates.ts'

import type { Customer, SupportCase } from './types.ts'
import type {
  PlaybookState,
  PlaybookSection,
  ProductAlignmentEntry,
  ActionItem,
  EngagementEntry,
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
    loadCustomerSignals(slug, customer.name, { ensureFresh: true }),
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

  // Load partner data
  const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../data/config')
  let partnerContext = ''
  try {
    const partnersPath = resolve(CONFIG_DIR, 'partners.json')
    if (existsSync(partnersPath)) {
      const partners = JSON.parse(readFileSync(partnersPath, 'utf-8')) as Array<{
        name: string; specializations: string[]; country: string; catalogUrl?: string; partnershipLevel: string
      }>
      if (partners.length > 0) {
        partnerContext = '| Partner | Specializations | Region | Partnership Level |\n|---|---|---|---|\n' +
          partners.map(p => `| ${p.name} | ${p.specializations.join(', ')} | ${p.country} | ${p.partnershipLevel} |`).join('\n')
      }
    }
  } catch {}

  const templateResult = await templateAll(signalResult.registrySignals, teamMembers, {
    format: 'playbook',
    maxNarrative: 40,
    customerSlug: slug,
  })

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
    ? expansionOpps.recommendations.map(r => {
        const slug = r.productSlug ?? toSlug(r.product)
        const valueMap = getValueMap(slug)
        const proofPoints = valueMap ? extractProductProofPoints(slug, valueMap) : ''
        return `- ${r.product} (${r.confidence}): ${r.why}${proofPoints ? `\n  Business value metrics: ${proofPoints}` : ''}`
      }).join('\n')
    : ''

  const systemPrompt = `You are a strategic account intelligence analyst for Red Hat. Generate a Customer Engagement Playbook. Output structured JSON matching the schema.

FORMAT RULES (critical — the playbook must be scannable in 30 seconds):
- Use bullet points (- ), NEVER dense paragraphs
- Each bullet: one fact, one insight, or one action. Max 2 sentences per bullet.
- 4-6 bullets per section, not walls of text
- Bold key terms: **RHEL**, **Ansible**, **OpenShift**, company names, metrics
- For keyRelationships: use markdown table format: "| Name | Role | Focus Area |\\n|---|---|---|\\n| Person | Title | What they care about |"
- For renewalsAndRisk: lead with dates and urgency, then risk factors as bullets

The playbook has 8 narrative sections:
1. strategicPosition — 4-6 bullets: why this customer matters, where Red Hat fits, key opportunity
2. keyRelationships — TWO markdown tables: first "Red Hat Account Team" (Name | Role | Focus Area), then "Certified Partners" (Partner | Specializations | Region) with catalog links if available. Include ALL partners from the partner data.
3. currentPriorities — 4-6 bullets: what the customer is working on NOW, each citing a specific signal or data point
4. productAlignment — Per-product: 1-2 sentence use case tied to a specific customer initiative
5. expansionOpportunities — 3-5 bullets: products they don't have but should. Each bullet MUST include:
   - Product name and confidence (HIGH/MEDIUM/LOW)
   - The specific signal or customer initiative that suggests it
   - Business value metrics from value maps (e.g., "customers see 30% improvement in security staff productivity, 58% reduction in unplanned downtime")
   - Format: "**Product (CONFIDENCE):** Signal/initiative context. Business value: [specific metrics from value maps]."
6. renewalsAndRisk — Lead with renewal dates (bold if within 90 days), then 3-4 risk factor bullets
7. swotAnalysis — SWOT analysis of the Red Hat relationship with this customer:
   ### Strengths — 3-4 bullets: where Red Hat is strong (active subscriptions, engaged team, high-confidence products, good case resolution)
   ### Weaknesses — 3-4 bullets: gaps (expired subscriptions, no meeting history, low product confidence, unresolved cases)
   ### Opportunities — 3-4 bullets: expansion signals (cloud spend without managed service, new product fits, upcoming renewals to upsell)
   ### Threats — 3-4 bullets: risks (competitor presence, budget constraints, subscription lapses, compliance issues)

8. meddpicc — MEDDPICC sales qualification assessment. For each of the 8 fields, assess based on available data:
   - M (Metrics): what success metrics matter to this customer
   - E (Economic Buyer): who controls budget decisions
   - D1 (Decision Criteria): how they evaluate solutions
   - D2 (Decision Process): their buying/approval process
   - P (Paper Process): procurement and contracting process
   - I (Identified Pain): their pain points driving action
   - C1 (Champion): internal advocate for Red Hat
   - C2 (Competition): competitors or alternatives they're evaluating
   For each: return status (confirmed if clear evidence, developing if partial/inferred, unknown if no data) and 1-2 sentence evidence.

Sections 5 (openActionItems) and 6 (engagementHistory) are NOT generated — they start empty.

For productAlignment entries:
- productSlug: the product identifier
- displayName: human-readable product name
- confidence: HIGH, MEDIUM, or LOW based on evidence strength
- useCase: 1-2 sentences tying the product to a SPECIFIC customer initiative (not generic value props)

Be specific and evidence-based. Cite actual data: subscription quantities, case numbers, renewal dates, industry trends. Never fabricate.`

  const userPrompt = `Generate the Customer Engagement Playbook for: ${customer.name}

<account_team>
${teamContext}
</account_team>

<partners>
${partnerContext || 'No partner data available.'}
</partners>

<deterministic_sections>
${templateResult.deterministic || 'No deterministic signal data available.'}
</deterministic_sections>

<signals>
${templateResult.narrativeContext || 'No signals available.'}
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
      swotAnalysis: { type: 'STRING', description: 'SWOT analysis with ### Strengths, ### Weaknesses, ### Opportunities, ### Threats subsections' },
      meddpicc: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            field: { type: 'STRING', description: 'One of: M, E, D1, D2, P, I, C1, C2' },
            displayName: { type: 'STRING', description: 'Human name: Metrics, Economic Buyer, Decision Criteria, Decision Process, Paper Process, Identified Pain, Champion, Competition' },
            status: { type: 'STRING', enum: ['confirmed', 'developing', 'unknown'] },
            evidence: { type: 'STRING', description: '1-2 sentence evidence or justification' },
          },
          required: ['field', 'displayName', 'status', 'evidence'],
        },
      },
    },
    required: ['strategicPosition', 'keyRelationships', 'currentPriorities', 'productAlignment', 'expansionOpportunities', 'renewalsAndRisk', 'swotAnalysis', 'meddpicc'],
  }

  // ── Step 3: Call Gemini ───────────────────────────────────────────────

  const geminiResult = await callGemini(systemPrompt, userPrompt, {
    callType: 'playbook-generation',
    customerName: customer.name,
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
    swotAnalysis: string
    meddpicc: Array<{ field: string; displayName: string; status: string; evidence: string }>
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

  // Solution play snapshots from templateAll() (ADR-031: single data path)
  const solutionPlaySnapshots = templateResult.structured.solutionPlays

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
      swotAnalysis: defaultSection(geminiData.swotAnalysis),
      meddpicc: {
        entries: (geminiData.meddpicc ?? []).map((m: any) => ({
          field: m.field,
          displayName: m.displayName,
          status: m.status || 'unknown',
          evidence: m.evidence || '',
          sourceNoteId: null,
          updatedAt: now,
        })),
        qualificationScore: Math.round(
          ((geminiData.meddpicc ?? []).filter((m: any) => m.status === 'confirmed').length / 8) * 100
        ),
        updatedAt: now,
        sourceNotes: [],
      },
    },
    deterministic: {
      subscriptions,
      cases,
      lifecycle,
      teamMembers: teamMembers,
      solutionPlays: solutionPlaySnapshots,
      signalIntelligence: templateResult.deterministic || null,
    },
    sources: [
      {
        type: 'auto-generate',
        sourceId: 'auto',
        ingestedAt: now,
        sectionsUpdated: [
          'strategicPosition', 'keyRelationships', 'currentPriorities',
          'productAlignment', 'expansionOpportunities', 'renewalsAndRisk',
          'swotAnalysis', 'meddpicc',
        ],
      },
    ],
  }

  // Write to disk
  writePlaybook(playbookState)

  console.log(`[playbook] Playbook generated for ${customer.name}: ${productEntries.length} products, ${subscriptions.length} subscriptions, ${cases.length} cases`)

  return playbookState
}

/**
 * Ingest meeting notes into an existing playbook via Gemini merge.
 *
 * Per ADR-026 section 2: full-state merge in a single Gemini call.
 * Gemini receives the current playbook sections plus new meeting notes,
 * returns updated narrative sections + extracted action items.
 *
 * Post-Gemini:
 *   1. Merge updated sections into existing PlaybookState
 *   2. Add new action items to openActionItems.items
 *   3. Add engagement entry to engagementHistory.entries (newest first)
 *   4. Add provenance entry to sources array
 *   5. Update lastMeetingNoteAt timestamp
 *   6. Re-inject deterministic data (subscriptions, cases, lifecycle unchanged)
 *   7. Write updated playbook via writePlaybook()
 */
export async function ingestMeetingNotes(
  existing: PlaybookState,
  noteContent: string,
  docUrl: string,
): Promise<PlaybookState> {
  const now = new Date().toISOString()
  const docId = docUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? 'unknown'

  console.log(`[playbook] Ingesting meeting notes for ${existing.customerName} (doc: ${docId})`)

  // ── Build Gemini merge prompt (ADR-026 structured XML) ──────────────

  const systemPrompt = `You are updating a customer engagement playbook with new meeting notes. Merge the notes into the existing playbook, updating relevant sections. Do not lose existing information — add to it. Extract any action items. Update current priorities if the notes reveal new information.

Return structured JSON with:
- updatedSections: object with keys for each narrative section that changed (strategicPosition, keyRelationships, currentPriorities, expansionOpportunities, renewalsAndRisk, swotAnalysis). Only include sections that the notes actually update. The value is the full updated text for that section (merge existing + new information).
- newActionItems: array of { text, owner } for any commitments, follow-ups, or deadlines mentioned in the notes.
- engagements: array of meetings found in the notes. Each entry: { summary: "1-2 sentence summary", meetingDate: "YYYY-MM-DD", attendees: ["name1", "name2"] }. If the document contains notes from MULTIPLE meetings, create a SEPARATE entry for each meeting with its own date and attendees. Do NOT combine multiple meetings into one entry.
- meddpicUpdates: array of MEDDPICC fields that the meeting notes inform. Only include fields with new evidence. Each entry: { field: "M"|"E"|"D1"|"D2"|"P"|"I"|"C1"|"C2", status: "confirmed"|"developing"|"unknown", evidence: "1-2 sentence justification" }
- sectionsUpdated: array of section keys that were updated.`

  const currentSections: Record<string, string> = {
    strategicPosition: existing.sections.strategicPosition.content,
    keyRelationships: existing.sections.keyRelationships.content,
    currentPriorities: existing.sections.currentPriorities.content,
    expansionOpportunities: existing.sections.expansionOpportunities.content,
    renewalsAndRisk: existing.sections.renewalsAndRisk.content,
    swotAnalysis: existing.sections.swotAnalysis.content,
  }

  const userPrompt = `<current-playbook>
${JSON.stringify(currentSections, null, 2)}
</current-playbook>

<current-meddpicc>
${JSON.stringify(existing.sections.meddpicc?.entries ?? [], null, 2)}
</current-meddpicc>

<new-meeting-notes>
${noteContent}
</new-meeting-notes>

Update the playbook sections based on these meeting notes. Return the updated sections.
For action items: extract any commitments, follow-ups, or deadlines from the notes.
For engagement history: add a summary entry for this meeting.
For MEDDPICC: if the meeting notes provide evidence for any qualification field, include it in meddpicUpdates.`

  const responseSchema = {
    type: 'OBJECT',
    properties: {
      updatedSections: {
        type: 'OBJECT',
        properties: {
          strategicPosition: { type: 'STRING' },
          keyRelationships: { type: 'STRING' },
          currentPriorities: { type: 'STRING' },
          expansionOpportunities: { type: 'STRING' },
          renewalsAndRisk: { type: 'STRING' },
          swotAnalysis: { type: 'STRING' },
        },
      },
      newActionItems: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            text: { type: 'STRING' },
            owner: { type: 'STRING' },
          },
          required: ['text', 'owner'],
        },
      },
      engagements: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING' },
            meetingDate: { type: 'STRING' },
            attendees: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['summary', 'meetingDate', 'attendees'],
        },
      },
      meddpicUpdates: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            field: { type: 'STRING' },
            status: { type: 'STRING', enum: ['confirmed', 'developing', 'unknown'] },
            evidence: { type: 'STRING' },
          },
          required: ['field', 'status', 'evidence'],
        },
        description: 'MEDDPICC fields that the meeting notes inform. Only include fields with new evidence.',
      },
      sectionsUpdated: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['updatedSections', 'newActionItems', 'engagements', 'sectionsUpdated'],
  }

  // ── Call Gemini ──────────────────────────────────────────────────────

  const geminiResult = await callGemini(systemPrompt, userPrompt, {
    callType: 'playbook-note-ingestion',
    customerName: existing.customerName,
    responseSchema,
    deltaKey: `playbook-ingest-${existing.customerSlug}-${docId}`,
    temperature: 0.2,
  })

  let geminiData: {
    updatedSections: Record<string, string>
    newActionItems: Array<{ text: string; owner: string }>
    engagements: Array<{ summary: string; meetingDate: string; attendees: string[] }>
    meddpicUpdates?: Array<{ field: string; status: string; evidence: string }>
    sectionsUpdated: string[]
  }

  try {
    geminiData = JSON.parse(geminiResult.text)
  } catch {
    console.error(`[playbook] Failed to parse Gemini ingestion response for ${existing.customerSlug}`)
    throw new Error(`Gemini returned non-JSON response for playbook note ingestion`)
  }

  // ── 1. Merge updated narrative sections ─────────────────────────────

  const narrativeSections = ['strategicPosition', 'keyRelationships', 'currentPriorities', 'expansionOpportunities', 'renewalsAndRisk', 'swotAnalysis'] as const
  type NarrativeKey = typeof narrativeSections[number]

  const updatedPlaybook: PlaybookState = {
    ...existing,
    lastMeetingNoteAt: now,
    sections: { ...existing.sections },
  }

  for (const key of narrativeSections) {
    const updatedContent = geminiData.updatedSections[key]
    if (updatedContent) {
      const existingSection = existing.sections[key] as PlaybookSection
      updatedPlaybook.sections[key] = {
        content: updatedContent,
        updatedAt: now,
        sourceNotes: [...existingSection.sourceNotes, docId],
      }
    }
  }

  // ── 2. Add new action items ─────────────────────────────────────────

  const newItems: ActionItem[] = (geminiData.newActionItems ?? []).map(item => ({
    id: crypto.randomUUID(),
    text: item.text,
    owner: item.owner,
    sourceNoteId: docId,
    createdAt: now,
    completedAt: null,
    status: 'open' as const,
  }))

  updatedPlaybook.sections.openActionItems = {
    items: [...existing.sections.openActionItems.items, ...newItems],
    updatedAt: now,
  }

  // ── 2b. Merge MEDDPICC updates ──────────────────────────────────────

  if (geminiData.meddpicUpdates?.length && updatedPlaybook.sections.meddpicc) {
    for (const update of geminiData.meddpicUpdates) {
      const existing = updatedPlaybook.sections.meddpicc.entries.find(e => e.field === update.field)
      if (existing) {
        existing.status = update.status as 'confirmed' | 'developing' | 'unknown'
        existing.evidence = update.evidence
        existing.sourceNoteId = docId
        existing.updatedAt = now
      }
    }
    updatedPlaybook.sections.meddpicc.qualificationScore = Math.round(
      (updatedPlaybook.sections.meddpicc.entries.filter(e => e.status === 'confirmed').length / 8) * 100
    )
    updatedPlaybook.sections.meddpicc.updatedAt = now
    if (!updatedPlaybook.sections.meddpicc.sourceNotes.includes(docId)) {
      updatedPlaybook.sections.meddpicc.sourceNotes.push(docId)
    }
  }

  // ── 3. Add engagement history entry (newest first) ──────────────────

  // Handle multiple meetings from a single doc
  const newEntries: EngagementEntry[] = (geminiData.engagements ?? []).map(eng => ({
    date: eng.meetingDate || now.slice(0, 10),
    type: 'meeting' as const,
    summary: eng.summary,
    sourceNoteId: docId,
    attendees: eng.attendees ?? [],
  }))

  // Fallback: if no engagements array (legacy response), create single entry
  if (newEntries.length === 0) {
    newEntries.push({
      date: now.slice(0, 10),
      type: 'meeting',
      summary: 'Meeting notes ingested',
      sourceNoteId: docId,
      attendees: [],
    })
  }

  updatedPlaybook.sections.engagementHistory = {
    entries: [...newEntries, ...existing.sections.engagementHistory.entries],
    updatedAt: now,
  }

  // ── 4. Add provenance entry ─────────────────────────────────────────

  const provenanceEntry: PlaybookSource = {
    type: 'meeting-note',
    sourceId: docId,
    ingestedAt: now,
    sectionsUpdated: geminiData.sectionsUpdated ?? Object.keys(geminiData.updatedSections).filter(k => geminiData.updatedSections[k]),
  }

  updatedPlaybook.sources = [...existing.sources, provenanceEntry]

  // ── 5-6. Deterministic data is preserved (spread from existing) ─────
  // Already handled by the spread: updatedPlaybook.deterministic === existing.deterministic

  // ── 7. Write updated playbook ───────────────────────────────────────

  writePlaybook(updatedPlaybook)

  console.log(`[playbook] Notes ingested for ${existing.customerName}: ${newItems.length} new action items, ${geminiData.sectionsUpdated?.length ?? 0} sections updated`)

  return updatedPlaybook
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
