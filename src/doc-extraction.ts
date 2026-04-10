// ── Document Extraction Sub-Pipeline (R19) ──────────────────────────────────
// Classifies Google Drive docs and extracts structured intelligence fields
// before feeding into the main brief pipeline.
// See: docs/GEMINI-BRIEF-ARCHITECTURE.md §Document Extraction Sub-Pipeline

import { google } from 'googleapis'
import { existsSync } from 'node:fs'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { getGeminiModelLite } from './settings-api.ts'

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

async function callGeminiStructured(systemPrompt: string, userPrompt: string, responseSchema: object): Promise<any> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModelLite()  // BKL-AI-COST-01: doc classification is high-volume, use lite model
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set in .env — required for Gemini via Vertex AI')

  let token: string | null | undefined
  const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
  if (saKeyB64) {
    const keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
    const jwtAuth = new google.auth.JWT({
      email: keyData.client_email,
      key:   keyData.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    token = (await jwtAuth.getAccessToken()).token
  } else {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    token = (await auth.getAccessToken()).token
  }
  if (!token) throw new Error('Failed to get access token for Gemini — set GEMINI_SERVICE_ACCOUNT_KEY in .env')

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema,
      },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status} (doc-extraction, project=${project} location=${location} model=${model}): ${err.slice(0, 300)}`)
  }
  const json = await res.json() as any
  // BKL-M52: record token usage for cost tracking
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType: 'doc-classify',
      customerName: 'unknown',
      inputTokens:  usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
  }
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return JSON.parse(text)
}

// ── Single document classification ───────────────────────────────────────────

export async function classifyAndExtract(
  doc: { name: string; modifiedTime?: string; content?: string },
): Promise<DocClassification> {
  if (!doc.content || doc.content.trim().length < 50) {
    return { ...EMPTY_CLASSIFICATION }
  }

  // BKL-AI-COST-02/04: skip classification for docs older than docClassifyMaxAgeDays (0 = unlimited)
  if (doc.modifiedTime) {
    const { getAiConfig } = await import('./settings-api.ts')
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

  const prompt = DOC_CLASSIFICATION_PROMPT
    .replace('{doc_name}', doc.name)
    .replace('{modified_time}', doc.modifiedTime ?? 'unknown')
    .replace('{content}', doc.content.slice(0, 2000))

  const result = await callGeminiStructured(SYSTEM_PROMPT, prompt, DOC_CLASSIFICATION_SCHEMA)
  return result as DocClassification
}

// ── Batch classification ─────────────────────────────────────────────────────

// BKL-AI18a: Parallelize doc classification calls (was sequential)
export async function classifyDocs(
  docs: { name: string; modifiedTime?: string; content?: string }[],
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
