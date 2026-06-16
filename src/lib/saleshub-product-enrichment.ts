/**
 * SalesHub Product Enrichment — Gemini extraction (GitHub Issue #819)
 *
 * Enriches product documents (content kits, messaging guides, battlecards)
 * using callGemini() (ADR-023) with ADR-024 quality validators.
 *
 * Each function accepts an optional geminiCaller parameter for testing
 * (defaults to the real callGemini import).
 */

import { callGemini, type GeminiResult } from '../gemini-call.ts'
import { validateAndRetry, formatFailureFeedback } from '../gemini-quality-gate.ts'
import { contentKitValidator, documentExtractionValidator } from '../quality-validators/product-enrichment-validator.ts'
import type {
  ContentKitExtraction,
  DocumentExtraction,
  ProductEnrichment,
} from '../types/saleshub-product-types.ts'

// ── Types ───────────────────────────────────────────────────────────────────

type GeminiCaller = (system: string, user: string, opts: any) => Promise<GeminiResult>

interface ContentKitInput {
  name: string
  content: string
  cloudProvider: string
}

interface DocumentInput {
  name: string
  content: string
}

const PDF_MARKER = '[PDF:base64:'
function isPdfContent(content: string): boolean {
  return content.startsWith(PDF_MARKER)
}
function extractPdfBase64(content: string): string {
  return content.slice(PDF_MARKER.length, -1)
}
function buildGeminiOpts(content: string, baseOpts: any): any {
  if (isPdfContent(content)) {
    return { ...baseOpts, inlineDataParts: [{ mimeType: 'application/pdf', data: extractPdfBase64(content) }] }
  }
  return baseOpts
}
function buildUserPrompt(promptFn: (name: string, content: string) => string, name: string, content: string): string {
  if (isPdfContent(content)) {
    return promptFn(name, '[See attached PDF document]')
  }
  return promptFn(name, content)
}

interface EnrichmentDocumentInput {
  name: string
  content: string
  type: string
  cloudProvider?: string
}

// ── Prompts ─────────────────────────────────────────────────────────────────

const CONTENT_KIT_SYSTEM_PROMPT = `You are a structured data extraction engine for Red Hat sales content kits.
Extract engagement data and return valid JSON only. No markdown, no explanation.`

const CONTENT_KIT_USER_PROMPT = (docName: string, content: string) => `Extract structured engagement data from this sales content kit document: "${docName}"

Return a JSON object with these fields:
- actionableSteps: array of { step: string, url?: string } — preserve all URLs exactly
- calculatorUrl: string or null — URL to any ROI/cost calculator
- contactName: string or null — any named contact person
- workshops: array of { name: string, url: string }
- demos: array of { name: string, url: string }
- battlecards: array of { name: string, url: string, competitor?: string }
- internalMaterials: array of { name: string, url: string }
- salesPlayAlignment: array of strings
- cloudProvider: string — the primary cloud provider this content targets: "AWS", "Azure", "Google Cloud", or "none" if not cloud-specific. Detect from document content, not just the title.

IMPORTANT: Preserve ALL URLs exactly as they appear in the document. Every link must be captured.

Document content:
${content}`

const MESSAGING_GUIDE_SYSTEM_PROMPT = `You are a structured data extraction engine for Red Hat messaging guides.
Extract key messaging data and return valid JSON only. No markdown, no explanation.`

const MESSAGING_GUIDE_USER_PROMPT = (docName: string, content: string) => `Extract structured messaging data from this guide: "${docName}"

Return a JSON object with these fields:
- summary: string — 1-2 sentence summary of the messaging guide
- keyPoints: array of strings — key messaging points and value propositions
- talkTracks: array of strings — recommended talk tracks for sales conversations
- links: array of { name: string, url: string } — all referenced URLs

Document content:
${content}`

const BATTLECARD_SYSTEM_PROMPT = `You are a structured data extraction engine for Red Hat competitive battlecards.
Extract competitive intelligence and return valid JSON only. No markdown, no explanation.`

const BATTLECARD_USER_PROMPT = (docName: string, content: string) => `Extract competitive intelligence from this battlecard: "${docName}"

Return a JSON object with these fields:
- summary: string — 1-2 sentence summary of the competitive positioning
- keyPoints: array of strings — competitive differentiators and angles
- links: array of { name: string, url: string } — all referenced URLs

Document content:
${content}`

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enrich a content kit document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with contentKitValidator.
 * Returns a ContentKitExtraction or null on failure.
 */
export async function enrichContentKit(
  doc: ContentKitInput,
  gemini: GeminiCaller = callGemini,
): Promise<ContentKitExtraction | null> {
  try {
    const systemPrompt = CONTENT_KIT_SYSTEM_PROMPT
    const userPrompt = buildUserPrompt(CONTENT_KIT_USER_PROMPT, doc.name, doc.content)
    const opts = buildGeminiOpts(doc.content, { callType: 'content-kit-extraction', model: 'lite' })

    const initialResult = await gemini(systemPrompt, userPrompt, opts)

    const gateResult = await validateAndRetry(
      initialResult.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
      { validator: contentKitValidator, maxRetries: 2 },
      async (failures, _attempt) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await gemini(
          systemPrompt,
          `${userPrompt}\n\n${feedback}`,
          opts,
        )
        return retryResult.text
      },
    )

    if (!gateResult.scorecard.passed) {
      console.warn(
        `[saleshub-product-enrichment] Content kit "${doc.name}" failed quality gate after ${gateResult.attempts} attempts (score: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold})`
      )
    }

    const cleaned = gateResult.output.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const parsed = JSON.parse(cleaned)

    return {
      documentName: doc.name,
      cloudProvider: (parsed.cloudProvider && parsed.cloudProvider !== 'none')
        ? parsed.cloudProvider
        : (doc.cloudProvider || 'unknown'),
      actionableSteps: parsed.actionableSteps ?? [],
      calculatorUrl: parsed.calculatorUrl ?? null,
      contactName: parsed.contactName ?? null,
      contactEmail: parsed.contactEmail ?? undefined,
      workshops: (parsed.workshops ?? []).slice(0, 5),
      demos: (parsed.demos ?? []).slice(0, 5),
      battlecards: (parsed.battlecards ?? []).slice(0, 5),
      internalMaterials: (parsed.internalMaterials ?? []).slice(0, 5),
      salesPlayAlignment: parsed.salesPlayAlignment ?? [],
    }
  } catch (e: any) {
    console.warn(`[saleshub-product-enrichment] Failed to enrich content kit "${doc.name}": ${e.message}`)
    return null
  }
}

/**
 * Enrich a messaging guide document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with documentExtractionValidator.
 * Returns a DocumentExtraction or null on failure.
 */
export async function enrichMessagingGuide(
  doc: DocumentInput,
  gemini: GeminiCaller = callGemini,
): Promise<DocumentExtraction | null> {
  try {
    const systemPrompt = MESSAGING_GUIDE_SYSTEM_PROMPT
    const userPrompt = buildUserPrompt(MESSAGING_GUIDE_USER_PROMPT, doc.name, doc.content)
    const opts = buildGeminiOpts(doc.content, { callType: 'content-kit-extraction', model: 'lite' })

    const initialResult = await gemini(systemPrompt, userPrompt, opts)

    const gateResult = await validateAndRetry(
      initialResult.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
      { validator: documentExtractionValidator, maxRetries: 2 },
      async (failures, _attempt) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await gemini(
          systemPrompt,
          `${userPrompt}\n\n${feedback}`,
          opts,
        )
        return retryResult.text
      },
    )

    if (!gateResult.scorecard.passed) {
      console.warn(
        `[saleshub-product-enrichment] Messaging guide "${doc.name}" failed quality gate after ${gateResult.attempts} attempts (score: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold})`
      )
    }

    const cleaned = gateResult.output.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const parsed = JSON.parse(cleaned)

    return {
      documentName: doc.name,
      summary: parsed.summary ?? '',
      keyPoints: parsed.keyPoints ?? [],
      talkTracks: parsed.talkTracks ?? [],
      links: parsed.links ?? [],
    }
  } catch (e: any) {
    console.warn(`[saleshub-product-enrichment] Failed to enrich messaging guide "${doc.name}": ${e.message}`)
    return null
  }
}

/**
 * Enrich a battlecard document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with documentExtractionValidator.
 * Returns a DocumentExtraction or null on failure.
 */
export async function enrichBattlecard(
  doc: DocumentInput,
  gemini: GeminiCaller = callGemini,
): Promise<DocumentExtraction | null> {
  try {
    const systemPrompt = BATTLECARD_SYSTEM_PROMPT
    const userPrompt = buildUserPrompt(BATTLECARD_USER_PROMPT, doc.name, doc.content)
    const opts = buildGeminiOpts(doc.content, { callType: 'content-kit-extraction', model: 'lite' })

    const initialResult = await gemini(systemPrompt, userPrompt, opts)

    const gateResult = await validateAndRetry(
      initialResult.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
      { validator: documentExtractionValidator, maxRetries: 2 },
      async (failures, _attempt) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await gemini(
          systemPrompt,
          `${userPrompt}\n\n${feedback}`,
          opts,
        )
        return retryResult.text
      },
    )

    if (!gateResult.scorecard.passed) {
      console.warn(
        `[saleshub-product-enrichment] Battlecard "${doc.name}" failed quality gate after ${gateResult.attempts} attempts (score: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold})`
      )
    }

    const cleaned = gateResult.output.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const parsed = JSON.parse(cleaned)

    return {
      documentName: doc.name,
      summary: parsed.summary ?? '',
      keyPoints: parsed.keyPoints ?? [],
      links: parsed.links ?? [],
    }
  } catch (e: any) {
    console.warn(`[saleshub-product-enrichment] Failed to enrich battlecard "${doc.name}": ${e.message}`)
    return null
  }
}

/**
 * Enrich all documents for a product, routing each to the appropriate
 * enrichment function based on document type.
 *
 * @param geminiFactory - Optional factory that returns a GeminiCaller per doc type (for testing)
 */
export async function enrichProductDocuments(
  productSlug: string,
  documents: EnrichmentDocumentInput[],
  geminiFactory?: (docType: string) => GeminiCaller,
): Promise<ProductEnrichment> {
  const contentKits: ContentKitExtraction[] = []
  const messagingGuides: DocumentExtraction[] = []
  const battlecards: DocumentExtraction[] = []

  const getGemini = (type: string): GeminiCaller =>
    geminiFactory ? geminiFactory(type) : callGemini

  for (const doc of documents) {
    switch (doc.type) {
      case 'content-kit': {
        const result = await enrichContentKit(
          { name: doc.name, content: doc.content, cloudProvider: doc.cloudProvider ?? 'unknown' },
          getGemini('content-kit'),
        )
        if (result) contentKits.push(result)
        break
      }
      case 'messaging-guide': {
        const result = await enrichMessagingGuide(
          { name: doc.name, content: doc.content },
          getGemini('messaging-guide'),
        )
        if (result) messagingGuides.push(result)
        break
      }
      case 'battlecard': {
        const result = await enrichBattlecard(
          { name: doc.name, content: doc.content },
          getGemini('battlecard'),
        )
        if (result) battlecards.push(result)
        break
      }
      default:
        console.warn(`[saleshub-product-enrichment] Unknown document type "${doc.type}" for "${doc.name}" — skipping`)
    }
  }

  return {
    productSlug,
    enrichedAt: new Date().toISOString(),
    contentKits,
    messagingGuides,
    battlecards,
  }
}
