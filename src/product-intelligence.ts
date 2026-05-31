/**
 * Product Intelligence — BKL-AI16
 *
 * Grounded Q&A for Red Hat products (RHEL, OpenShift, Ansible).
 * Uses the same Vertex AI / Google Search grounding pattern as account-intelligence.ts.
 * Returns answer text + extracted source citations + confidence level.
 */

import { callGemini, type GroundingChunk } from './gemini-call.ts'

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
