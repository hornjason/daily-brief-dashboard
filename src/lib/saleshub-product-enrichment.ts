/**
 * SalesHub Product Enrichment — Gemini extraction (GitHub Issue #819, #867)
 *
 * Enriches product documents (content kits, messaging guides, battlecards,
 * case studies, competitive reviews) using callGemini() (ADR-023) with
 * ADR-024 quality validators.
 *
 * All extraction goes through extractWithGemini() — the single shared
 * ceremony that handles prompt building, fence stripping, parsing,
 * validation, and retry. Each doc type is a config object, not a
 * duplicated function body.
 *
 * Each function accepts an optional geminiCaller parameter for testing
 * (defaults to the real callGemini import).
 */

import { callGemini, type GeminiResult } from '../gemini-call.ts'
import { validateAndRetry, formatFailureFeedback } from '../gemini-quality-gate.ts'
import type { QualityValidator } from '../gemini-quality-gate.ts'
import {
  contentKitValidator,
  documentExtractionValidator,
  caseStudyValidator,
  competitiveReviewValidator,
} from '../quality-validators/product-enrichment-validator.ts'
import type {
  ContentKitExtraction,
  DocumentExtraction,
  ProductEnrichment,
  CaseStudyExtraction,
  CompetitiveReviewExtraction,
} from '../types/saleshub-product-types.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export type GeminiCaller = (system: string, user: string, opts: any) => Promise<GeminiResult>

interface ContentKitInput {
  name: string
  content: string
  cloudProvider: string
}

interface DocumentInput {
  name: string
  content: string
}

/**
 * Configuration for a single extraction type. Each doc type defines one of
 * these — extractWithGemini() handles the rest.
 */
export interface ExtractionConfig<T> {
  systemPrompt: string
  userPromptFn: (docName: string, content: string) => string
  validator?: QualityValidator
  parseResult: (raw: any, docName: string, fallbacks?: Record<string, any>) => T
  callType: string  // for callGemini cost tracking
}

// ── Content helpers ────────────────────────────────────────────────────────

const BINARY_MARKER = '[PDF:base64:'
function isBinaryContent(content: string): boolean {
  return content.startsWith(BINARY_MARKER)
}
function extractBase64(content: string): string {
  return content.slice(BINARY_MARKER.length, -1)
}
function buildGeminiOpts(content: string, baseOpts: any): any {
  if (isBinaryContent(content)) {
    return { ...baseOpts, inlineDataParts: [{ mimeType: 'application/pdf', data: extractBase64(content) }] }
  }
  return baseOpts
}
function extractLinksFromHtml(html: string): string {
  const links: string[] = []
  const matches = html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi)
  for (const m of matches) {
    let href = m[1]
    const text = m[2].trim()
    if (!href.startsWith('http') || text.length < 3) continue
    // Unwrap Google redirect URLs
    const googleRedirect = href.match(/google\.com\/url\?q=([^&]+)/)
    if (googleRedirect) href = decodeURIComponent(googleRedirect[1])
    links.push(`"${text}" → ${href}`)
  }
  if (links.length === 0) return ''
  return `\n\nURL REFERENCE — these are the actual hyperlink URLs from the document. Use these EXACT URLs in your extraction:\n${links.join('\n')}`
}

function buildUserPrompt(promptFn: (name: string, content: string) => string, name: string, content: string): string {
  if (isBinaryContent(content)) {
    return promptFn(name, '[See attached PDF document]')
  }
  // For HTML content, extract URLs and append as reference
  const urlRef = content.includes('<a ') ? extractLinksFromHtml(content) : ''
  return promptFn(name, content) + urlRef
}

interface EnrichmentDocumentInput {
  name: string
  content: string
  type: string
  cloudProvider?: string
}

// ── Fence stripping (single location — AC-3) ──────────────────────────────

/**
 * Strip markdown code fences from Gemini output. This is the ONLY place
 * this regex exists in the enrichment pipeline.
 */
export function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
}

// ── Shared extraction ceremony ─────────────────────────────────────────────

/**
 * Generic Gemini extraction that encapsulates the 7-step ceremony:
 * 1. Build user prompt (with binary/HTML detection, URL extraction)
 * 2. Build Gemini opts (handle binary content, inlineDataParts)
 * 3. Call callGemini()
 * 4. Strip markdown fences
 * 5. JSON.parse() the result
 * 6. Run through validateAndRetry() if validator provided
 * 7. Catch and warn on failure, return null
 */
export async function extractWithGemini<T>(
  config: ExtractionConfig<T>,
  docName: string,
  content: string,
  gemini: GeminiCaller = callGemini,
  fallbacks?: Record<string, any>,
): Promise<T | null> {
  try {
    const systemPrompt = config.systemPrompt
    const userPrompt = buildUserPrompt(config.userPromptFn, docName, content)
    const opts = buildGeminiOpts(content, {
      callType: config.callType,
      model: 'lite',
      deltaKey: `saleshub-enrich-${config.callType}-${docName}`,
    })

    const initialResult = await gemini(systemPrompt, userPrompt, opts)

    if (config.validator) {
      // Full validateAndRetry path
      const gateResult = await validateAndRetry(
        stripMarkdownFences(initialResult.text),
        { validator: config.validator, maxRetries: 2 },
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
          `[saleshub-product-enrichment] "${docName}" failed quality gate after ${gateResult.attempts} attempts (score: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold})`
        )
      }

      const cleaned = stripMarkdownFences(gateResult.output)
      const parsed = JSON.parse(cleaned)
      return config.parseResult(parsed, docName, fallbacks)
    } else {
      // No validator — parse directly
      const cleaned = stripMarkdownFences(initialResult.text)
      const parsed = JSON.parse(cleaned)
      return config.parseResult(parsed, docName, fallbacks)
    }
  } catch (e: any) {
    console.warn(`[saleshub-product-enrichment] Failed to enrich "${docName}": ${e.message}`)
    return null
  }
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

const CASE_STUDY_SYSTEM_PROMPT = `You are a structured data extraction engine for Red Hat customer case studies.
Extract customer success data and return valid JSON only. No markdown, no explanation.`

const CASE_STUDY_USER_PROMPT = (docName: string, content: string) => `Extract customer success data from this case study: "${docName}"

Return a JSON object with these fields:
- summary: string — 1-2 sentence summary of the customer success story
- customerName: string — name of the customer organization
- industry: string — customer's industry
- challenge: string — business challenge the customer faced
- solution: string — how Red Hat products solved it
- results: array of strings — measurable outcomes and benefits
- productsUsed: array of strings — Red Hat products mentioned
- keyPoints: array of strings — key takeaways for sales conversations
- links: array of { name: string, url: string } — all referenced URLs

Document content:
${content}`

const COMPETITIVE_REVIEW_SYSTEM_PROMPT = `You are a structured data extraction engine for Red Hat competitive reviews.
Extract competitive positioning data and return valid JSON only. No markdown, no explanation.`

const COMPETITIVE_REVIEW_USER_PROMPT = (docName: string, content: string) => `Extract competitive positioning from this review: "${docName}"

Return a JSON object with these fields:
- summary: string — 1-2 sentence summary of the competitive comparison
- competitor: string — name of the competitor being compared
- keyDifferentiators: array of strings — Red Hat advantages over the competitor
- competitorWeaknesses: array of strings — competitor disadvantages
- talkTracks: array of strings — recommended conversation approaches
- keyPoints: array of strings — key competitive insights
- links: array of { name: string, url: string } — all referenced URLs

Document content:
${content}`

// ── Extraction configs ─────────────────────────────────────────────────────

const contentKitConfig: ExtractionConfig<ContentKitExtraction> = {
  systemPrompt: CONTENT_KIT_SYSTEM_PROMPT,
  userPromptFn: CONTENT_KIT_USER_PROMPT,
  validator: contentKitValidator,
  callType: 'content-kit-extraction',
  parseResult: (parsed, docName, fallbacks) => ({
    documentName: docName,
    cloudProvider: (parsed.cloudProvider && parsed.cloudProvider !== 'none')
      ? parsed.cloudProvider
      : (fallbacks?.cloudProvider || 'unknown'),
    actionableSteps: parsed.actionableSteps ?? [],
    calculatorUrl: parsed.calculatorUrl ?? null,
    contactName: parsed.contactName ?? null,
    contactEmail: parsed.contactEmail ?? undefined,
    workshops: (parsed.workshops ?? []).slice(0, 5),
    demos: (parsed.demos ?? []).slice(0, 5),
    battlecards: (parsed.battlecards ?? []).slice(0, 5),
    internalMaterials: (parsed.internalMaterials ?? []).slice(0, 5),
    salesPlayAlignment: parsed.salesPlayAlignment ?? [],
  }),
}

const messagingGuideConfig: ExtractionConfig<DocumentExtraction> = {
  systemPrompt: MESSAGING_GUIDE_SYSTEM_PROMPT,
  userPromptFn: MESSAGING_GUIDE_USER_PROMPT,
  validator: documentExtractionValidator,
  callType: 'messaging-guide-extraction',
  parseResult: (parsed, docName) => ({
    documentName: docName,
    summary: parsed.summary ?? '',
    keyPoints: parsed.keyPoints ?? [],
    talkTracks: parsed.talkTracks ?? [],
    links: parsed.links ?? [],
  }),
}

const battlecardConfig: ExtractionConfig<DocumentExtraction> = {
  systemPrompt: BATTLECARD_SYSTEM_PROMPT,
  userPromptFn: BATTLECARD_USER_PROMPT,
  validator: documentExtractionValidator,
  callType: 'battlecard-extraction',
  parseResult: (parsed, docName) => ({
    documentName: docName,
    summary: parsed.summary ?? '',
    keyPoints: parsed.keyPoints ?? [],
    links: parsed.links ?? [],
  }),
}

const caseStudyConfig: ExtractionConfig<CaseStudyExtraction> = {
  systemPrompt: CASE_STUDY_SYSTEM_PROMPT,
  userPromptFn: CASE_STUDY_USER_PROMPT,
  validator: caseStudyValidator,
  callType: 'case-study-extraction',
  parseResult: (parsed, docName) => ({
    documentName: docName,
    customerName: parsed.customerName ?? '',
    industry: parsed.industry ?? '',
    challenge: parsed.challenge ?? '',
    solution: parsed.solution ?? '',
    results: (parsed.results ?? []).slice(0, 5),
    productsUsed: (parsed.productsUsed ?? []).slice(0, 5),
    keyPoints: (parsed.keyPoints ?? []).slice(0, 5),
    links: (parsed.links ?? []).slice(0, 5),
  }),
}

const competitiveReviewConfig: ExtractionConfig<CompetitiveReviewExtraction> = {
  systemPrompt: COMPETITIVE_REVIEW_SYSTEM_PROMPT,
  userPromptFn: COMPETITIVE_REVIEW_USER_PROMPT,
  validator: competitiveReviewValidator,
  callType: 'competitive-review-extraction',
  parseResult: (parsed, docName) => ({
    documentName: docName,
    competitor: parsed.competitor ?? '',
    keyDifferentiators: (parsed.keyDifferentiators ?? []).slice(0, 5),
    competitorWeaknesses: (parsed.competitorWeaknesses ?? []).slice(0, 5),
    talkTracks: (parsed.talkTracks ?? []).slice(0, 5),
    keyPoints: (parsed.keyPoints ?? []).slice(0, 5),
    links: (parsed.links ?? []).slice(0, 5),
  }),
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enrich a content kit document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with contentKitValidator.
 */
export async function enrichContentKit(
  doc: ContentKitInput,
  gemini: GeminiCaller = callGemini,
): Promise<ContentKitExtraction | null> {
  return extractWithGemini(
    contentKitConfig,
    doc.name,
    doc.content,
    gemini,
    { cloudProvider: doc.cloudProvider },
  )
}

/**
 * Enrich a messaging guide document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with documentExtractionValidator.
 */
export async function enrichMessagingGuide(
  doc: DocumentInput,
  gemini: GeminiCaller = callGemini,
): Promise<DocumentExtraction | null> {
  return extractWithGemini(messagingGuideConfig, doc.name, doc.content, gemini)
}

/**
 * Enrich a battlecard document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with documentExtractionValidator.
 */
export async function enrichBattlecard(
  doc: DocumentInput,
  gemini: GeminiCaller = callGemini,
): Promise<DocumentExtraction | null> {
  return extractWithGemini(battlecardConfig, doc.name, doc.content, gemini)
}

/**
 * Enrich a case study document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with caseStudyValidator (#868).
 */
export async function enrichCaseStudy(
  doc: DocumentInput,
  gemini: GeminiCaller = callGemini,
): Promise<CaseStudyExtraction | null> {
  return extractWithGemini(caseStudyConfig, doc.name, doc.content, gemini)
}

/**
 * Enrich a competitive review document with Gemini extraction.
 * Uses ADR-024 validateAndRetry with competitiveReviewValidator (#868).
 */
export async function enrichCompetitiveReview(
  doc: DocumentInput,
  gemini: GeminiCaller = callGemini,
): Promise<CompetitiveReviewExtraction | null> {
  return extractWithGemini(competitiveReviewConfig, doc.name, doc.content, gemini)
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
  const caseStudies: CaseStudyExtraction[] = []
  const competitiveReviews: CompetitiveReviewExtraction[] = []

  const getGemini = (type: string): GeminiCaller =>
    geminiFactory ? geminiFactory(type) : callGemini

  // Process in parallel batches of 5 (#841)
  const BATCH_SIZE = 5
  for (let batchStart = 0; batchStart < documents.length; batchStart += BATCH_SIZE) {
    const batch = documents.slice(batchStart, batchStart + BATCH_SIZE)
    const results = await Promise.allSettled(batch.map(async (doc) => {
      // Skip documents > 10MB
      if (doc.content.length > 10_000_000) {
        console.warn(`[saleshub-product-enrichment] Skipping "${doc.name}" — content too large (${Math.round(doc.content.length / 1_000_000)}MB)`)
        return null
      }
      return { doc, result: await enrichSingleDocument(doc, getGemini) }
    }))

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value?.result) continue
      const { doc, result } = r.value
      switch (doc.type) {
        case 'content-kit': contentKits.push(result as ContentKitExtraction); break
        case 'messaging-guide': messagingGuides.push(result as DocumentExtraction); break
        case 'battlecard': battlecards.push(result as DocumentExtraction); break
        case 'case-study': caseStudies.push(result as CaseStudyExtraction); break
        case 'competitive-review': competitiveReviews.push(result as CompetitiveReviewExtraction); break
      }
    }
  }

  return {
    productSlug,
    enrichedAt: new Date().toISOString(),
    contentKits,
    messagingGuides,
    battlecards,
    caseStudies,
    competitiveReviews,
  }
}

async function enrichSingleDocument(
  doc: EnrichmentDocumentInput,
  getGemini: (type: string) => GeminiCaller,
): Promise<any> {
  switch (doc.type) {
      case 'content-kit':
        return enrichContentKit(
          { name: doc.name, content: doc.content, cloudProvider: doc.cloudProvider ?? 'unknown' },
          getGemini('content-kit'),
        )
      case 'messaging-guide':
        return enrichMessagingGuide(
          { name: doc.name, content: doc.content },
          getGemini('messaging-guide'),
        )
      case 'battlecard':
        return enrichBattlecard(
          { name: doc.name, content: doc.content },
          getGemini('battlecard'),
        )
      case 'case-study':
        return enrichCaseStudy(
          { name: doc.name, content: doc.content },
          getGemini('case-study'),
        )
      case 'competitive-review':
        return enrichCompetitiveReview(
          { name: doc.name, content: doc.content },
          getGemini('competitive-review'),
        )
      default:
        console.warn(`[saleshub-product-enrichment] Unknown document type "${doc.type}" for "${doc.name}" — skipping`)
        return null
  }
}
