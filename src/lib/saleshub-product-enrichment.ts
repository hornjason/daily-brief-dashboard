/**
 * SalesHub Product Enrichment — Gemini extraction (GitHub Issue #819, #866)
 *
 * ADR-041: Universal DocumentIntelligence extraction replaces 5 type-specific
 * configs. Every document gets the same structured intelligence fields via
 * responseSchema (ADR-040). Post-extraction vocabulary resolution is
 * deterministic (no Gemini).
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
import {
  readManifest,
  updateGate3,
  computeGateSummary,
  writeManifest,
  type PipelineManifest,
} from './pipeline-manifest.ts'
import { validateAndRetry, formatFailureFeedback } from '../gemini-quality-gate.ts'
import type { QualityValidator } from '../gemini-quality-gate.ts'
import { documentIntelligenceValidator } from '../quality-validators/document-intelligence-validator.ts'
import type {
  DocumentIntelligence,
  ProductEnrichment,
} from '../types/saleshub-product-types.ts'
import { resolveDocumentIntelligence } from './document-intelligence-resolver.ts'
import { loadAllEcosystemPartners, type EcosystemPartnerCache } from './ecosystem-catalog.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export type GeminiCaller = (system: string, user: string, opts: any) => Promise<GeminiResult>

export interface EnrichmentDocumentInput {
  name: string
  content: string
  type: string
  cloudProvider?: string
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
  responseSchema?: object  // ADR-040: Gemini structured output schema
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

// ── Fence stripping (single location — AC-3) ──────────────────────────────

/**
 * Strip markdown code fences from Gemini output. This is the ONLY place
 * this regex exists in the enrichment pipeline.
 */
export function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
}

// ── Enrichment timeout ───────────────────────────────────────────────────────

const ENRICHMENT_TIMEOUT_MS = 120_000

// ── Shared extraction ceremony ─────────────────────────────────────────────

/**
 * Generic Gemini extraction that encapsulates the 7-step ceremony:
 * 1. Build user prompt (with binary/HTML detection, URL extraction)
 * 2. Build Gemini opts (handle binary content, inlineDataParts)
 * 3. Call callGemini()
 * 4. Strip markdown fences (BYPASSED when responseSchema is present — Gemini
 *    structured output returns clean JSON, no markdown fencing)
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
    const baseOpts: any = {
      callType: config.callType,
      model: 'lite',
      deltaKey: `saleshub-enrich-${config.callType}-${docName}`,
    }
    // ADR-040: pass responseSchema + temperature when configured
    if (config.responseSchema) {
      baseOpts.responseSchema = config.responseSchema
      baseOpts.temperature = 0.3
      baseOpts.timeoutMs = 90000
    }
    const opts = buildGeminiOpts(content, baseOpts)

    // When responseSchema is set, Gemini returns clean JSON — skip fence stripping
    const hasSchema = !!config.responseSchema

    // Per-document timeout — prevents a single slow Gemini call from blocking the batch (#934)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Enrichment timeout after ${ENRICHMENT_TIMEOUT_MS / 1000}s`)), ENRICHMENT_TIMEOUT_MS)
    )
    const initialResult = await Promise.race([gemini(systemPrompt, userPrompt, opts), timeoutPromise])

    if (config.validator) {
      const initialText = hasSchema ? initialResult.text : stripMarkdownFences(initialResult.text)
      // Full validateAndRetry path
      const gateResult = await validateAndRetry(
        initialText,
        { validator: config.validator, maxRetries: 2 },
        async (failures, _attempt) => {
          const feedback = formatFailureFeedback(failures)
          const retryResult = await gemini(
            systemPrompt,
            `${userPrompt}\n\n${feedback}`,
            opts,
          )
          return hasSchema ? retryResult.text : stripMarkdownFences(retryResult.text)
        },
      )

      if (!gateResult.scorecard.passed) {
        console.warn(
          `[saleshub-product-enrichment] "${docName}" failed quality gate after ${gateResult.attempts} attempts (score: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold})`
        )
        return null
      }

      const cleaned = hasSchema ? gateResult.output : stripMarkdownFences(gateResult.output)
      const parsed = JSON.parse(cleaned)
      return config.parseResult(parsed, docName, fallbacks)
    } else {
      // No validator — parse directly
      const cleaned = hasSchema ? initialResult.text : stripMarkdownFences(initialResult.text)
      const parsed = JSON.parse(cleaned)
      return config.parseResult(parsed, docName, fallbacks)
    }
  } catch (e: any) {
    const isTimeout = e.message?.includes('timeout') || e.message?.includes('Enrichment timeout') || e.name === 'AbortError'
    if (isTimeout) {
      console.warn(`[saleshub-product-enrichment] Timeout enriching "${docName}" — skipping (limit: ${ENRICHMENT_TIMEOUT_MS / 1000}s)`)
    } else {
      console.warn(`[saleshub-product-enrichment] Failed to enrich "${docName}": ${e.message}`)
    }
    return null
  }
}

// ── ADR-041: Document Intelligence Schema ──────────────────────────────────

export const DOCUMENT_INTELLIGENCE_SCHEMA = {
  type: 'object',
  properties: {
    documentCategory: {
      type: 'string',
      enum: ['content-kit', 'messaging-guide', 'battlecard', 'case-study',
             'competitive-review', 'solution-brief', 'design-guide',
             'workshop', 'demo', 'reference-architecture', 'migration-guide', 'other'],
      description: 'The editorial format/type of this document based on its structure and content.',
    },
    summary: {
      type: 'string',
      maxLength: 2000,
      description: 'Comprehensive summary paragraph covering the document purpose, key content, target audience, and main value propositions. Be thorough — at least 3-5 sentences.',
    },
    productsReferenced: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Red Hat product name as mentioned in the document.' },
        },
        required: ['name'],
      },
      description: 'All Red Hat products mentioned in the document. Extract exact product names.',
    },
    integrationsReferenced: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          technology: { type: 'string', description: 'Third-party technology name (e.g., ServiceNow, Cisco ACI, Splunk).' },
          category: { type: 'string', description: 'Technology category: ITSM, Networking, CI/CD, Monitoring, Security, Cloud, Storage, Virtualization, Database, or Other.' },
        },
        required: ['technology', 'category'],
      },
      nullable: true,
      description: 'Third-party technologies this document discusses integration with. Set null if the document does not reference any third-party integrations.',
    },
    competitorsReferenced: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Competitor company or product name.' },
          context: { type: 'string', enum: ['displacement', 'comparison', 'migration-from', 'coexistence'], description: 'How the competitor is referenced in the document.' },
        },
        required: ['name', 'context'],
      },
      nullable: true,
      description: 'Competitor technologies or products referenced — including indirect references like "legacy tools", "manual approaches", "incumbent solutions", or named alternatives (Puppet, Chef, Terraform, Ansible Tower vs AAP). Extract the competitive context even when competitors are implied rather than named. Only set null if the document makes zero competitive references.',
    },
    partnerSolutions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          partnerName: { type: 'string', description: 'Technology partner company name.' },
          solutionArea: { type: 'string', description: 'Solution category: ITSM, Security, Observability, Networking, Storage, or Other.' },
        },
        required: ['partnerName', 'solutionArea'],
      },
      nullable: true,
      description: 'Partner solutions referenced as complementary to Red Hat products. Set null if no partner solutions are mentioned.',
    },
    useCases: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: 'Specific use cases the document addresses (e.g., "Network automation", "Container security", "VM migration"). Set null if no specific use cases are described.',
    },
    customerScenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scenario: { type: 'string', description: 'Customer scenario described (e.g., "Migrating from VMware to OpenShift Virtualization").' },
          industry: { type: 'string', nullable: true, description: 'Industry if mentioned. Set null if industry-agnostic.' },
        },
        required: ['scenario'],
      },
      nullable: true,
      description: 'Customer scenarios or use cases with industry context. Set null if none described.',
    },
    cloudProviders: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: 'Cloud providers referenced (AWS, Azure, Google Cloud, IBM Cloud). Set null if not cloud-specific.',
    },
    audience: {
      type: 'string',
      enum: ['internal', 'partner', 'customer', 'mixed'],
      description: 'Primary audience for this document based on its content and tone.',
    },
    keyPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key messaging points or value propositions from the document.',
    },
    talkTracks: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: 'Recommended talk tracks for sales conversations — key messages a seller should deliver about this content. Extract even implicit selling points like competitive advantages, ROI claims, or customer success references. Only set null if the document is purely technical reference with no selling angle.',
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['name', 'url'],
      },
      description: 'All hyperlinks from the document. Preserve URLs exactly.',
    },
    actionableSteps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          url: { type: 'string', nullable: true },
        },
        required: ['step'],
      },
      nullable: true,
      description: 'Actionable steps with optional URLs. Set null if none present.',
    },
    tdpAlignment: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: 'TDP (Technical Decision Point) names this content supports — infer from topic and domain. Set null if no clear TDP alignment.',
    },
    buyingStage: {
      type: 'string',
      enum: ['awareness', 'discovery', 'evaluation', 'justification', 'expansion'],
      description: 'Buying stage this content best supports: awareness (thought leadership), discovery (pain identification), evaluation (competitive/technical), justification (ROI/success stories), expansion (cross-sell/upgrade).',
    },
    targetPersona: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: 'Target personas based on document tone, depth, and stated audience (e.g., "CTO", "Platform Engineer", "IT Director"). Set null if not determinable.',
    },
    customerProblem: {
      type: 'string',
      nullable: true,
      description: 'The specific business problem this content addresses. Must be at least 20 characters and specific to be useful. Set null if purely reference material.',
    },
    conversationOpener: {
      type: 'string',
      nullable: true,
      description: 'One observation-based sentence an AE can use to introduce this content. MUST start with a factual statement about a specific document detail — never a question. BANNED openers: "Are you", "Is your", "Have you", "Do you", "Would you", "Could you", "Can you". REQUIRED for customer-facing and mixed-audience docs (set null ONLY for internal/partner-only docs).',
    },
    techStackTriggers: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: 'Customer-side technologies that make this content relevant (e.g., "VMware", "Terraform", "Jenkins"). Focus on customer tech stack, not Red Hat products. Set null if technology-agnostic.',
    },
  },
  required: ['documentCategory', 'summary', 'productsReferenced', 'audience', 'keyPoints', 'links', 'buyingStage'],
}

// ── ADR-041: Document Intelligence Prompts ─────────────────────────────────

const DOCUMENT_INTELLIGENCE_SYSTEM_PROMPT = `You are a structured data extraction engine for Red Hat sales and product documents.
You're enriching sales content for an AE intelligence dashboard. Extract not just what the document SAYS, but how it CONNECTS to customer conversations.
Return valid JSON matching the provided schema.

## GROUNDING RULES (MANDATORY)
1. Every claim MUST come from the provided document content.
2. If the document does not mention a technology/product/competitor, set the field to null.
3. Never extrapolate integrations not explicitly discussed.
4. Preserve all URLs exactly.
5. For talkTracks: extract selling angles even when not explicitly labeled as talk tracks. Key messages, value propositions, and competitive differentiators count.
6. For competitorsReferenced: capture both named competitors AND indirect references to alternative approaches.
7. For tdpAlignment: classify which Technology Decision Patterns this content supports. Use ONLY these 8 canonical names: Automation, Container Management, Server and Cloud Computing, AI Platform, Application Development, Virtualization, Management, Security. If a document covers multiple TDPs, list all that apply. Example: a document about automating container deployments → ["Automation", "Container Management"].
8. For buyingStage: classify depth — thought leadership/overviews = awareness, pain identification/problem framing = discovery, competitive comparisons/technical deep-dives = evaluation, ROI analyses/customer success stories = justification, cross-sell/upgrade/expansion content = expansion.
9. For targetPersona: extract from document tone, technical depth, and stated audience — executive summaries target CxO, architecture guides target Platform Engineers, business cases target IT Directors.
10. For customerProblem: identify the specific business problem this content addresses. Must be at least 20 characters and specific — not generic like "improve efficiency." Example: "Managing heterogeneous VM workloads across on-prem and cloud without a unified control plane."
11. For conversationOpener: write one observation-based sentence an AE can use to introduce this content naturally. THIS IS A HARD CONSTRAINT — openers that violate it will be rejected by the quality gate and retried.
    MANDATORY FORMAT: Start with a factual observation about a SPECIFIC detail from the document — a named capability, a concrete metric, a particular use case, a specific integration. Use stems like "I noticed...", "I saw that...", "This document covers...", "There's a new...".
    ABSOLUTELY BANNED (regex-enforced, automatic rejection): Do NOT start with "Are you", "Is your", "Have you", "Do you", "Would you", "Could you", "Can you", or ANY question format. These are generic sales patterns that get ignored. Every opener starting with these words WILL be rejected.
    BAD (will be rejected): "Are you looking to streamline your automation?" / "Is your team struggling with container sprawl?" / "Have you considered migrating to a unified platform?"
    GOOD: "I noticed this joint Ansible-Cisco playbook collection automates 80% of common switch configurations." / "This migration guide walks through a 4-phase VMware-to-OpenShift transition with rollback procedures at each stage."
    REQUIRED for customer-facing and mixed-audience documents — set null ONLY for internal or partner-only documents.
12. For techStackTriggers: extract customer-side technologies that make this content relevant. Focus on what the CUSTOMER might have in their environment (VMware, Terraform, Jenkins, ServiceNow), not Red Hat product names.`

const DOCUMENT_INTELLIGENCE_USER_PROMPT = (docName: string, content: string) =>
  `Extract structured intelligence from this Red Hat document: "${docName}"

Classify the document type, extract all referenced Red Hat products, third-party integrations, competitors, partner solutions, use cases, and key messaging. Capture all hyperlinks exactly as they appear.

Document content:
${content}`

// ── ADR-041: Document Intelligence Extraction Config ───────────────────────

const documentIntelligenceConfig: ExtractionConfig<DocumentIntelligence> = {
  systemPrompt: DOCUMENT_INTELLIGENCE_SYSTEM_PROMPT,
  userPromptFn: DOCUMENT_INTELLIGENCE_USER_PROMPT,
  validator: documentIntelligenceValidator,
  callType: 'document-intelligence-extraction',
  responseSchema: DOCUMENT_INTELLIGENCE_SCHEMA,
  parseResult: (parsed, docName) => ({
    documentName: docName,
    documentCategory: parsed.documentCategory ?? 'other',
    summary: parsed.summary ?? '',
    productsReferenced: (parsed.productsReferenced ?? []).map((p: any) => ({
      name: p.name ?? '',
      slug: null, // resolved post-extraction by document-intelligence-resolver
    })),
    integrationsReferenced: parsed.integrationsReferenced ?? null,
    competitorsReferenced: parsed.competitorsReferenced ?? null,
    partnerSolutions: parsed.partnerSolutions ?? null,
    useCases: parsed.useCases ?? null,
    customerScenarios: parsed.customerScenarios ?? null,
    cloudProviders: parsed.cloudProviders ?? null,
    audience: parsed.audience ?? 'internal',
    tdpAlignment: parsed.tdpAlignment ?? null,
    buyingStage: parsed.buyingStage ?? 'awareness',
    targetPersona: parsed.targetPersona ?? null,
    customerProblem: parsed.customerProblem ?? null,
    conversationOpener: parsed.conversationOpener ?? null,
    techStackTriggers: parsed.techStackTriggers ?? null,
    keyPoints: parsed.keyPoints ?? [],
    talkTracks: parsed.talkTracks ?? null,
    links: parsed.links ?? [],
    actionableSteps: parsed.actionableSteps ?? null,
    enrichedAt: new Date().toISOString(),
    sourceProductSlug: '', // set by caller
  }),
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enrich a single document with universal DocumentIntelligence extraction (ADR-041).
 * Returns a DocumentIntelligence or null on failure.
 */
export async function enrichDocumentIntelligence(
  doc: EnrichmentDocumentInput,
  gemini: GeminiCaller = callGemini,
): Promise<DocumentIntelligence | null> {
  return extractWithGemini(documentIntelligenceConfig, doc.name, doc.content, gemini)
}

/**
 * Enrich all documents for a product using the universal DocumentIntelligence
 * schema (ADR-041). Each document gets the same extraction regardless of type.
 * Post-extraction resolution runs deterministically against vocabulary modules.
 *
 * @param geminiFactory - Optional factory that returns a GeminiCaller per doc type (for testing)
 * @param productDir - Optional directory path for pipeline manifest integration (#874)
 */
export async function enrichProductDocuments(
  productSlug: string,
  documents: EnrichmentDocumentInput[],
  geminiFactory?: (docType: string) => GeminiCaller,
  productDir?: string,
): Promise<ProductEnrichment> {
  const docs: DocumentIntelligence[] = []

  const getGemini = (_type: string): GeminiCaller =>
    geminiFactory ? geminiFactory(_type) : callGemini

  // Read pipeline manifest if productDir provided (#874)
  let manifest: PipelineManifest | null = null
  if (productDir) {
    manifest = readManifest(productDir)
  }

  // Load ecosystem partners once for the batch (not per-document)
  let partners: EcosystemPartnerCache[] = []
  try {
    partners = loadAllEcosystemPartners()
  } catch {
    // Ecosystem catalog not available — proceed without partner resolution
  }

  // Deduplicate enrichment inputs by normalized name (#873)
  const seenNames = new Set<string>()
  const uniqueDocuments: EnrichmentDocumentInput[] = []
  for (const doc of documents) {
    const normalized = doc.name.toLowerCase().trim()
    if (seenNames.has(normalized)) {
      console.log(`[saleshub-product-enrichment] Skipping duplicate: "${doc.name}"`)
      if (manifest) {
        updateGate3(manifest, doc.name, {
          gate3_enriched: false,
          gate3_enrichmentOutcome: 'skipped',
          gate3_enrichmentReason: 'duplicate',
        })
      }
      continue
    }
    seenNames.add(normalized)
    uniqueDocuments.push(doc)
  }

  // Process in parallel batches of 5 (#841)
  const BATCH_SIZE = 5
  for (let batchStart = 0; batchStart < uniqueDocuments.length; batchStart += BATCH_SIZE) {
    const batch = uniqueDocuments.slice(batchStart, batchStart + BATCH_SIZE)
    const results = await Promise.allSettled(batch.map(async (doc) => {
      // Skip documents > 10MB — explicit manifest outcome, no silent drop
      if (doc.content.length > 10_000_000) {
        console.warn(`[saleshub-product-enrichment] Skipping "${doc.name}" — content too large (${Math.round(doc.content.length / 1_000_000)}MB)`)
        if (manifest) {
          updateGate3(manifest, doc.name, {
            gate3_enriched: false,
            gate3_enrichmentOutcome: 'skipped',
            gate3_enrichmentReason: 'too-large',
          })
        }
        return { doc, result: null, outcome: 'skipped' as const, reason: 'too-large' }
      }

      // Skip documents with no content — explicit manifest outcome
      if (!doc.content || doc.content.trim().length === 0) {
        console.warn(`[saleshub-product-enrichment] Skipping "${doc.name}" — no content`)
        if (manifest) {
          updateGate3(manifest, doc.name, {
            gate3_enriched: false,
            gate3_enrichmentOutcome: 'skipped',
            gate3_enrichmentReason: 'no-content',
          })
        }
        return { doc, result: null, outcome: 'skipped' as const, reason: 'no-content' }
      }

      const result = await enrichDocumentIntelligence(doc, getGemini(doc.type))
      if (!result) {
        // enrichDocumentIntelligence returned null — Gemini call failed
        if (manifest) {
          updateGate3(manifest, doc.name, {
            gate3_enriched: false,
            gate3_enrichmentOutcome: 'failed',
            gate3_enrichmentReason: 'gemini-extraction-failed',
          })
        }
        return { doc, result: null, outcome: 'failed' as const, reason: 'gemini-extraction-failed' }
      }

      // Set source product slug and resolve against vocabularies
      result.sourceProductSlug = productSlug
      const resolved = resolveDocumentIntelligence(result, partners)

      // Update manifest with success
      if (manifest) {
        updateGate3(manifest, doc.name, {
          gate3_enriched: true,
          gate3_productsFound: resolved.productsReferenced?.length ?? 0,
          gate3_classificationsFound:
            (resolved.integrationsReferenced?.length ?? 0) +
            (resolved.competitorsReferenced?.length ?? 0) +
            (resolved.partnerSolutions?.length ?? 0),
          gate3_enrichmentOutcome: 'enriched',
        })
      }

      return { doc, result: resolved, outcome: 'enriched' as const, reason: null }
    }))

    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      if (r.value.outcome === 'enriched' && r.value.result) {
        docs.push(r.value.result)
      }
    }
  }

  // Write updated manifest after enrichment batch (#874)
  if (manifest && productDir) {
    computeGateSummary(manifest)
    writeManifest(manifest, productDir)
    console.log(`[saleshub-product-enrichment] Pipeline manifest updated: ${manifest.gates.gate2_enrichedCount} enriched, coverage ${(manifest.gates.gate2_enrichmentCoverage * 100).toFixed(0)}%`)
  }

  return {
    productSlug,
    enrichedAt: new Date().toISOString(),
    documents: docs,
  }
}
