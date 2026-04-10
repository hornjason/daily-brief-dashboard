/**
 * Product Intelligence — BKL-AI16
 *
 * Grounded Q&A for Red Hat products (RHEL, OpenShift, Ansible).
 * Uses the same Vertex AI / Google Search grounding pattern as account-intelligence.ts.
 * Returns answer text + extracted source citations + confidence level.
 */

import { resolve } from 'path'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { getGeminiToken } from './gemini-auth.ts'
import { getGeminiModelLite } from './settings-api.ts'

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

// ── Raw Gemini call returning full response JSON (for grounding metadata) ─────

async function callGeminiGroundedRaw(opts: {
  systemPrompt: string
  userPrompt: string
  callType?: string
  customerName?: string
}): Promise<any> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModelLite()  // BKL-AI-COST-01: product Q&A is high-volume, use lite model
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — required for Gemini via Vertex AI')

  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: opts.userPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature:     0.7,
        maxOutputTokens: 4096,
        thinkingConfig:  { thinkingBudget: 0 },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    console.error(`[product-intelligence] Gemini error ${res.status}: ${err.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200)}`)
    throw new Error(`Gemini grounded API error ${res.status}`)
  }

  const json = await res.json() as any

  // Record token usage for cost tracking (BKL-M52)
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp:    new Date().toISOString(),
      callType:     opts.callType ?? 'product-query',
      customerName: opts.customerName ?? 'unknown',
      inputTokens:  usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
  }

  return json
}

// ── Source extraction from Gemini grounding metadata ─────────────────────────

function extractSources(json: any): ProductSource[] {
  const candidate = json.candidates?.[0]
  if (!candidate) return []

  const sources: ProductSource[] = []
  const seen = new Set<string>()

  // groundingMetadata.groundingChunks — each chunk has a .web object with uri + title
  const chunks: any[] = candidate.groundingMetadata?.groundingChunks ?? []
  for (const chunk of chunks) {
    const web = chunk.web
    if (!web?.uri) continue
    if (seen.has(web.uri)) continue
    seen.add(web.uri)
    let title = web.title
    if (!title) {
      try { title = new URL(web.uri).hostname } catch { title = web.uri }
    }
    sources.push({ title, url: web.uri })
  }

  // Fallback: groundingSupports — older grounding format
  if (sources.length === 0) {
    const supports: any[] = candidate.groundingMetadata?.groundingSupports ?? []
    for (const support of supports) {
      for (const chunk of (support.groundingChunkIndices ?? [])) {
        const web = chunks[chunk]?.web
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

  const json = await callGeminiGroundedRaw({
    systemPrompt,
    userPrompt,
    callType:     'product-query',
    customerName: customerName ?? product,
  })

  const answer = json.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No answer returned from Gemini.'
  const sources = extractSources(json)
  const confidence = deriveConfidence(sources)

  return { answer, sources, confidence }
}
