// ── Document Extraction Sub-Pipeline (R19) ──────────────────────────────────
// Classifies Google Drive docs and extracts structured intelligence fields
// before feeding into the main brief pipeline.
// See: docs/GEMINI-BRIEF-ARCHITECTURE.md §Document Extraction Sub-Pipeline

import { google } from 'googleapis'
import { existsSync } from 'node:fs'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { callGemini } from './gemini-call.ts'
import { readDocClassCache, writeDocClassCache } from './cache-layer.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface DocClassification {
  type: 'MEETING_NOTES' | 'ACCOUNT_PLAN' | 'TECHNICAL_DOC' | 'PROPOSAL' | 'COMPANY_INTELLIGENCE' | 'INDUSTRY_ANALYSIS' | 'OTHER'
  action_items: { text: string; owner?: string; deadline?: string }[]
  decisions: { text: string; participants?: string[] }[]
  stakeholders_mentioned: { name: string; role?: string; sentiment?: string }[]
  technical_signals: { technology: string; context: 'using' | 'evaluating' | 'migrating_from' }[]
  competitive_mentions: { competitor: string; context: string }[]
  timelines: { event: string; date: string }[]
  pain_points: { text: string; severity?: string }[]
  strategic_signals: { signal_type: 'swot' | 'trigger_event' | 'product_fit'; text: string; significance?: string }[]
}

// ── Prompt & Schema ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a document intelligence extraction system for a Red Hat Account Solution Architect.
Your job is to classify customer documents and extract structured fields that feed into daily briefs.

Rules:
- Only extract information explicitly present in the document
- If a field has no matches, return an empty array
- For stakeholders, infer role from context clues (title mentions, sign-off lines)
- For technical signals, distinguish between active use, evaluation, and migration
- Never fabricate data not present in the source document`

const DOC_CLASSIFICATION_PROMPT = `Classify this document and extract structured fields:

DOCUMENT: {doc_name} (modified: {modified_time})
CONTENT: {content}

Classify as one of: MEETING_NOTES, ACCOUNT_PLAN, TECHNICAL_DOC, PROPOSAL, COMPANY_INTELLIGENCE, INDUSTRY_ANALYSIS, OTHER
COMPANY_INTELLIGENCE: Company Brief, Executive Summary, Account Overview docs.
INDUSTRY_ANALYSIS: Industry Analysis, Market Brief, Vertical Overview docs.

Extract (if present):
- action_items: [{text, owner, deadline}]
- decisions: [{text, participants}]
- stakeholders_mentioned: [{name, role, sentiment}]
- technical_signals: [{technology, context: "using" | "evaluating" | "migrating_from"}]
- competitive_mentions: [{competitor, context}]
- timelines: [{event, date}]
- pain_points: [{text, severity}]
- strategic_signals: [{signal_type: "swot"|"trigger_event"|"product_fit", text, significance}]`

const DOC_CLASSIFICATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    type: {
      type: 'string' as const,
      enum: ['MEETING_NOTES', 'ACCOUNT_PLAN', 'TECHNICAL_DOC', 'PROPOSAL', 'COMPANY_INTELLIGENCE', 'INDUSTRY_ANALYSIS', 'OTHER'],
    },
    action_items: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const },
          owner: { type: 'string' as const },
          deadline: { type: 'string' as const },
        },
        required: ['text'],
      },
    },
    decisions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const },
          participants: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['text'],
      },
    },
    stakeholders_mentioned: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          role: { type: 'string' as const },
          sentiment: { type: 'string' as const },
        },
        required: ['name'],
      },
    },
    technical_signals: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          technology: { type: 'string' as const },
          context: { type: 'string' as const, enum: ['using', 'evaluating', 'migrating_from'] },
        },
        required: ['technology', 'context'],
      },
    },
    competitive_mentions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          competitor: { type: 'string' as const },
          context: { type: 'string' as const },
        },
        required: ['competitor', 'context'],
      },
    },
    timelines: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          event: { type: 'string' as const },
          date: { type: 'string' as const },
        },
        required: ['event', 'date'],
      },
    },
    pain_points: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const },
          severity: { type: 'string' as const },
        },
        required: ['text'],
      },
    },
    strategic_signals: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          signal_type: { type: 'string' as const, enum: ['swot', 'trigger_event', 'product_fit'] },
          text: { type: 'string' as const },
          significance: { type: 'string' as const },
        },
        required: ['signal_type', 'text'],
      },
    },
  },
  required: [
    'type', 'action_items', 'decisions', 'stakeholders_mentioned',
    'technical_signals', 'competitive_mentions', 'timelines', 'pain_points',
    'strategic_signals',
  ],
}

// ── Empty classification (used for short docs and error fallback) ────────────

const EMPTY_CLASSIFICATION: DocClassification = {
  type: 'OTHER',
  action_items: [],
  decisions: [],
  stakeholders_mentioned: [],
  technical_signals: [],
  competitive_mentions: [],
  timelines: [],
  pain_points: [],
  strategic_signals: [],
}

// ── Gemini structured call (replicated from customer.ts — not exported there) ─

export async function callGeminiStructured(systemPrompt: string, userPrompt: string, responseSchema: object): Promise<any> {
  // BKL-AI-COST-01: doc classification is high-volume, use lite model
  const result = await callGemini(
    systemPrompt,
    userPrompt,
    {
      callType: 'doc-classify',
      customerName: 'unknown',
      temperature: 0.7,
      responseSchema,
    }
  )

  return JSON.parse(result.text)
}

// ── Single document classification ───────────────────────────────────────────

export async function classifyAndExtract(
  doc: { fileId?: string; name: string; modifiedTime?: string; content?: string },
): Promise<DocClassification> {
  if (!doc.content || doc.content.trim().length < 50) {
    return { ...EMPTY_CLASSIFICATION }
  }

  // BKL-AI-COST-02/04: skip classification for docs older than docClassifyMaxAgeDays (0 = unlimited)
  if (doc.modifiedTime) {
    const { getAiConfig } = await import('./ai-config.ts')
    const maxAgeDays = getAiConfig().docClassifyMaxAgeDays ?? 0
    if (maxAgeDays > 0) {
      const modifiedDate = new Date(doc.modifiedTime)
      const daysOld = Math.floor((Date.now() - modifiedDate.getTime()) / (1000 * 60 * 60 * 24))
      if (daysOld > maxAgeDays) {
        console.log(`[doc-extract] skipping "${doc.name}" — last modified ${daysOld}d ago (limit: ${maxAgeDays}d)`)
        return { ...EMPTY_CLASSIFICATION }
      }
    }
  }

  // ADR-013 Tier 3: content-addressed classification cache by (fileId, modifiedTime).
  // Short-circuits Gemini call for stable Drive docs — no TTL, fingerprint IS the invalidation key.
  if (doc.fileId && doc.modifiedTime) {
    const cached = readDocClassCache(doc.fileId, doc.modifiedTime)
    if (cached) return cached
  }

  const prompt = DOC_CLASSIFICATION_PROMPT
    .replace('{doc_name}', doc.name)
    .replace('{modified_time}', doc.modifiedTime ?? 'unknown')
    .replace('{content}', doc.content.slice(0, 2000))

  const result = await callGeminiStructured(SYSTEM_PROMPT, prompt, DOC_CLASSIFICATION_SCHEMA) as DocClassification
  if (doc.fileId && doc.modifiedTime) {
    writeDocClassCache(doc.fileId, doc.modifiedTime, result)
  }
  return result
}

// ── Batch classification ─────────────────────────────────────────────────────

// BKL-AI18a: Parallelize doc classification calls (was sequential)
// ADR-013 Tier 3: fileId is threaded through so classifyAndExtract can hit the content-addressed cache.
export async function classifyDocs(
  docs: { fileId?: string; name: string; modifiedTime?: string; content?: string }[],
): Promise<Map<string, DocClassification>> {
  const results = new Map<string, DocClassification>()

  const settled = await Promise.allSettled(
    docs.map(async (doc) => ({
      name: doc.name,
      classification: await classifyAndExtract(doc),
    })),
  )

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    const docName = docs[i].name
    if (result.status === 'fulfilled') {
      results.set(result.value.name, result.value.classification)
    } else {
      console.warn(`[doc-extraction] Failed to classify ${docName}:`, result.reason)
      results.set(docName, { ...EMPTY_CLASSIFICATION })
    }
  }

  return results
}
