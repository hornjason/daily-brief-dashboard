/**
 * Product Intelligence — BKL-AI16
 *
 * Grounded Q&A for Red Hat products (RHEL, OpenShift, Ansible).
 * Uses the same Vertex AI / Google Search grounding pattern as account-intelligence.ts.
 * Returns answer text + extracted source citations + confidence level.
 */

import { callGemini, type GroundingChunk } from './gemini-call.ts'
import { buildCustomerIntelContext } from './customer-product-intel.ts'
import { loadCustomerContext } from './lib/customer-context-loader.ts'
import { getIntelligenceCacheEntry } from './account-intelligence.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProductKey = 'rhel' | 'ocp' | 'aap'
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW'

export interface ProductSource {
  title: string
  url: string
}

export interface ProductQueryResult {
  answer: string
  sources: ProductSource[]
  confidence: Confidence
}

const MAX_CONTEXT_LENGTH = 100_000

// ── Product display names ─────────────────────────────────────────────────────

const PRODUCT_NAMES: Record<ProductKey, string> = {
  rhel: 'Red Hat Enterprise Linux (RHEL)',
  ocp:  'Red Hat OpenShift Container Platform',
  aap:  'Red Hat Ansible Automation Platform (AAP)',
}

// ── Source extraction from Gemini grounding metadata ─────────────────────────

function extractSources(groundingMeta: { groundingChunks?: GroundingChunk[]; groundingSupports?: Array<{ segment?: { text: string }; groundingChunkIndices?: number[] }> } | undefined): ProductSource[] {
  if (!groundingMeta) return []

  const sources: ProductSource[] = []
  const seen = new Set<string>()

  // groundingMetadata.groundingChunks — each chunk has a .web object with uri + title
  const chunks: GroundingChunk[] = groundingMeta.groundingChunks ?? []
  for (const chunk of chunks) {
    const web = chunk.web
    if (!web?.uri) continue
    if (seen.has(web.uri)) continue
    seen.add(web.uri)
    let title = web.title
    if (!title) {
      try { title = new URL(web.uri).hostname } catch { title = web.uri }
    }
    sources.push({ title: title!, url: web.uri })
  }

  // Fallback: groundingSupports — older grounding format
  if (sources.length === 0) {
    const supports = groundingMeta.groundingSupports ?? []
    for (const support of supports) {
      for (const idx of (support.groundingChunkIndices ?? [])) {
        const web = chunks[idx]?.web
        if (!web?.uri || seen.has(web.uri)) continue
        seen.add(web.uri)
        sources.push({
          title: web.title ?? new URL(web.uri).hostname,
          url:   web.uri,
        })
      }
    }
  }

  return sources.slice(0, 8)
}

function deriveConfidence(sources: ProductSource[]): Confidence {
  if (sources.length >= 2) return 'HIGH'
  if (sources.length === 1) return 'MEDIUM'
  return 'LOW'
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Query Red Hat product documentation and knowledge base using Gemini grounded search.
 *
 * @param product      - 'rhel' | 'ocp' | 'aap'
 * @param question     - User's question (max 500 chars enforced by caller)
 * @param customerName - Optional customer context injected into the system prompt
 */
export async function queryProductIntelligence(
  product: ProductKey,
  question: string,
  customerName?: string,
): Promise<ProductQueryResult> {
  const productDisplay = PRODUCT_NAMES[product]

  // 3-layer system prompt per spec
  const systemParts: string[] = [
    `You are a Red Hat product expert. Answer questions about ${productDisplay} using current information from official Red Hat documentation, release notes, and authoritative technical sources.`,
  ]
  if (customerName) {
    systemParts.push(`Customer context: You are advising ${customerName}. Tailor your answer to be relevant to an enterprise customer evaluating or running Red Hat products.`)
  }
  systemParts.push(
    `Always cite your sources by referencing the documentation or article you used. If your confidence in the answer is low due to limited or ambiguous sources, explicitly state that at the end of your response.`,
  )

  const systemPrompt = systemParts.join('\n\n')

  const userPrompt = `Question about ${productDisplay}:\n\n${question}`

  const result = await callGemini(systemPrompt, userPrompt, {
    callType: 'product-query',
    customerName: customerName ?? product,
    grounding: true,
    temperature: 0.7,
    timeoutMs: 60_000,
  })

  const answer = result.text || 'No answer returned from Gemini.'
  const sources = extractSources(result.groundingMetadata)
  const confidence = deriveConfidence(sources)

  return { answer, sources, confidence }
}

// ── Customer Data Q&A — internal data only, no web grounding ─────────────────

/**
 * Query all customer data using Gemini (no Google Search grounding).
 * Loads subscriptions, cases, docs, pipeline, tech stack, and account intelligence
 * into context and answers the user's question from internal data only.
 */
export async function queryCustomerData(
  question: string,
  customerName: string,
  customerSlug: string,
): Promise<ProductQueryResult> {
  // Load all customer data sources in parallel
  const [intelContext, customerContext, intelligenceEntry] = await Promise.all([
    buildCustomerIntelContext(customerSlug),
    Promise.resolve(loadCustomerContext(customerSlug)),
    Promise.resolve(getIntelligenceCacheEntry(customerName)),
  ])

  const { subscriptions, supportCases, customerDocsText, opportunityNote } = intelContext
  const { techs } = customerContext

  // Build labeled context sections
  const sections: Array<{ label: string; content: string }> = []

  // SUBSCRIPTIONS
  const subsText = subscriptions.length > 0
    ? subscriptions.map((s: any) => `- ${s.productDescription ?? s.product ?? 'Unknown'}: ${s.quantity ?? '?'} units, expires ${s.endDate ?? s.expirationDate ?? '?'}`).join('\n')
    : 'No data available.'
  sections.push({ label: 'SUBSCRIPTIONS', content: subsText })

  // SUPPORT CASES
  const casesText = supportCases.length > 0
    ? supportCases.map((c: any) => `- [${c.severity ?? '?'}] ${c.subject ?? c.summary ?? 'No subject'} (status: ${c.status ?? '?'}, created: ${c.createdDate ?? c.created ?? '?'})`).join('\n')
    : 'No data available.'
  sections.push({ label: 'SUPPORT CASES', content: casesText })

  // DOCUMENTS
  const docsText = customerDocsText.length > 0
    ? customerDocsText
    : 'No data available.'
  sections.push({ label: 'DOCUMENTS', content: docsText })

  // PIPELINE
  const pipelineText = opportunityNote
    ? opportunityNote
    : 'No data available.'
  sections.push({ label: 'PIPELINE', content: pipelineText })

  // TECH STACK
  const techText = techs.length > 0
    ? techs.map(t => `- ${t}`).join('\n')
    : 'No data available.'
  sections.push({ label: 'TECH STACK', content: techText })

  // ACCOUNT INTELLIGENCE
  const intelText = intelligenceEntry
    ? [
        intelligenceEntry.company ? `Company:\n${intelligenceEntry.company}` : '',
        intelligenceEntry.industry ? `Industry:\n${intelligenceEntry.industry}` : '',
        intelligenceEntry.industryClassification ? `Classification: ${intelligenceEntry.industryClassification}` : '',
      ].filter(Boolean).join('\n\n') || 'No intelligence data available.'
    : 'No intelligence data available.'
  sections.push({ label: 'ACCOUNT INTELLIGENCE', content: intelText })

  // Assemble full context — truncate docs first if over limit
  let fullContext = sections.map(s => `=== ${s.label} ===\n${s.content}`).join('\n\n')

  if (fullContext.length > MAX_CONTEXT_LENGTH) {
    // Find the DOCUMENTS section and truncate it
    const docsIdx = sections.findIndex(s => s.label === 'DOCUMENTS')
    if (docsIdx >= 0) {
      const otherLength = sections.reduce((sum, s, i) =>
        i === docsIdx ? sum : sum + `=== ${s.label} ===\n${s.content}\n\n`.length, 0)
      const availableForDocs = MAX_CONTEXT_LENGTH - otherLength - '=== DOCUMENTS ===\n\n'.length
      if (availableForDocs > 200) {
        sections[docsIdx].content = sections[docsIdx].content.slice(0, availableForDocs) + '\n... [truncated]'
      } else {
        sections[docsIdx].content = '[Documents truncated due to context length limit]'
      }
      fullContext = sections.map(s => `=== ${s.label} ===\n${s.content}`).join('\n\n')
    }
    // Final hard cap
    if (fullContext.length > MAX_CONTEXT_LENGTH) {
      fullContext = fullContext.slice(0, MAX_CONTEXT_LENGTH)
    }
  }

  const systemPrompt = `You are an account intelligence assistant for ${customerName}. Answer the user's question using ONLY the customer data provided below. Do not invent or assume data that is not explicitly present in the provided context. If the data does not contain enough information to fully answer the question, say so clearly and indicate which data sources were checked.\n\n${fullContext}`

  const result = await callGemini(systemPrompt, question, {
    callType: 'customer-query',
    customerName,
    grounding: false,
    temperature: 0.3,
    timeoutMs: 60_000,
  })

  const answer = result.text || 'No answer returned from Gemini.'

  // Confidence: count sections with actual data (not "No data available." or "No intelligence data available.")
  const sectionsWithData = sections.filter(s =>
    s.content !== 'No data available.' &&
    s.content !== 'No intelligence data available.' &&
    s.content !== '[Documents truncated due to context length limit]'
  )
  const dataCount = sectionsWithData.length
  const confidence: Confidence = dataCount >= 4 ? 'HIGH' : dataCount >= 2 ? 'MEDIUM' : 'LOW'

  // Sources: internal section names for sections that had data
  const sources: ProductSource[] = sectionsWithData.map(s => ({
    title: s.label.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' '),
    url: '',
  }))

  return { answer, sources, confidence }
}
