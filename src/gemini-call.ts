/**
 * callGemini() — Standardized Gemini API call wrapper (BKL-ARCH-06 Phase 1)
 *
 * Single entry point for all Gemini API calls. Composes existing primitives:
 *   - fetchGeminiWithRetry() — 429 retry with exponential backoff
 *   - getGeminiToken() — token acquisition (service account or OAuth)
 *   - recordGeminiUsage() — per-call cost tracking
 *   - getAiConfig() — model selection from config
 *
 * Adds delta detection: hashes input prompts and returns cached results when
 * inputs are unchanged. Cache files live under data/cache/gemini-delta/.
 *
 * See ADR-023 for design decisions and migration plan.
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { getGeminiToken } from './gemini-auth.ts'
import { fetchGeminiWithRetry } from './gemini-fetch.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { getAiConfig, getGeminiModel, getGeminiModelLite } from './ai-config.ts'

// ── Configuration ────────────────────────────────────────────────────────────

const CACHE_DIR = resolve(import.meta.dir, '../data/cache/gemini-delta')
const PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'jhorn-pai'
const LOCATION = process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-east1'

// Timeout tiers (ms) — see ADR-023
const TIMEOUT_STRUCTURED = 30_000  // responseSchema present
const TIMEOUT_GROUNDED = 120_000   // grounding enabled
const TIMEOUT_LONG_FORM = 180_000  // campaign-generation, account-plan
const TIMEOUT_STANDARD = 120_000   // default

const LONG_FORM_CALL_TYPES = new Set(['campaign-generation', 'account-plan'])

// ── Public API ───────────────────────────────────────────────────────────────

export interface GeminiCallOptions {
  callType: string              // 'brief-synthesis', 'campaign-generation', etc.
  customerName?: string         // for cost attribution (omit for portfolio-level calls)
  model?: 'full' | 'lite' | 'pro'  // maps to ai-config models; defaults to 'full'
  timeoutMs?: number            // override default timeout tier
  temperature?: number          // override model default
  grounding?: boolean           // enable Google Search grounding
  responseSchema?: object       // for structured JSON output
  deltaKey?: string             // cache key for input-hash delta detection
}

export interface GeminiResult {
  text: string                  // raw text response (or JSON string if responseSchema)
  cached: boolean               // true if returned from delta cache
  inputTokens: number           // 0 if cached
  outputTokens: number          // 0 if cached
  model: string                 // actual model used
}

export async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  options: GeminiCallOptions
): Promise<GeminiResult> {
  const { callType, customerName, deltaKey } = options

  // ── Step 1: Delta check ───────────────────────────────────────────────────
  if (deltaKey) {
    const inputHash = hashInputs(systemPrompt, userPrompt, options.responseSchema)
    const cached = readDeltaCache(deltaKey)

    if (cached && cached.hash === inputHash) {
      return {
        text: cached.result.text,
        cached: true,
        inputTokens: 0,
        outputTokens: 0,
        model: cached.result.model,
      }
    }
  }

  // ── Step 2: Resolve model ──────────────────────────────────────────────────
  const modelName = resolveModel(options.model ?? 'full')

  // ── Step 3: Resolve timeout ────────────────────────────────────────────────
  const timeoutMs = resolveTimeout(options)

  // ── Step 4: Build request body ─────────────────────────────────────────────
  const requestBody = buildRequestBody(systemPrompt, userPrompt, options, modelName)

  // ── Step 5: Call Gemini ────────────────────────────────────────────────────
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelName}:generateContent`

  const response = await fetchGeminiWithRetry(
    url,
    getGeminiToken,
    JSON.stringify(requestBody),
    {
      callType,
      customerName,
      model: modelName,
      project: PROJECT_ID,
      location: LOCATION,
      timeoutMs,
      logPrefix: `[callGemini:${callType}]`,
    }
  )

  // ── Step 6: Extract response ───────────────────────────────────────────────
  const responseBody = await response.json()
  const text = extractText(responseBody)
  const { inputTokens, outputTokens } = extractTokens(responseBody)

  // ── Step 7: Cost tracking ──────────────────────────────────────────────────
  recordGeminiUsage({
    timestamp: new Date().toISOString(),
    callType,
    customerName: customerName ?? 'unknown',
    inputTokens,
    outputTokens,
    model: modelName,
  })

  // ── Step 8: Delta store ────────────────────────────────────────────────────
  if (deltaKey) {
    const inputHash = hashInputs(systemPrompt, userPrompt, options.responseSchema)
    writeDeltaCache(deltaKey, inputHash, { text, model: modelName })
  }

  return {
    text,
    cached: false,
    inputTokens,
    outputTokens,
    model: modelName,
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function resolveModel(model: 'full' | 'lite' | 'pro'): string {
  if (model === 'pro') return 'gemini-2.5-pro'
  if (model === 'lite') return getGeminiModelLite()
  return getGeminiModel()
}

function resolveTimeout(options: GeminiCallOptions): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs

  // Tier selection based on call characteristics
  if (options.responseSchema) return TIMEOUT_STRUCTURED
  if (LONG_FORM_CALL_TYPES.has(options.callType)) return TIMEOUT_LONG_FORM
  if (options.grounding) return TIMEOUT_GROUNDED
  return TIMEOUT_STANDARD
}

function buildRequestBody(
  systemPrompt: string,
  userPrompt: string,
  options: GeminiCallOptions,
  modelName: string
): object {
  const body: any = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {},
  }

  // Temperature
  if (options.temperature !== undefined) {
    body.generationConfig.temperature = options.temperature
  }

  // Structured output
  if (options.responseSchema) {
    body.generationConfig.responseMimeType = 'application/json'
    body.generationConfig.responseSchema = options.responseSchema
  }

  // Thinking budget — disable for Flash models only (Pro rejects thinkingBudget: 0)
  if (modelName.includes('flash') && !modelName.includes('lite')) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  // Grounding
  if (options.grounding) {
    body.tools = [
      {
        google_search: {},
      },
    ]
  }

  return body
}

function extractText(responseBody: any): string {
  const candidates = responseBody.candidates
  if (!candidates || candidates.length === 0) {
    throw new Error('Gemini response has no candidates')
  }

  const content = candidates[0].content
  if (!content || !content.parts || content.parts.length === 0) {
    throw new Error('Gemini response has no content parts')
  }

  return content.parts[0].text ?? ''
}

function extractTokens(responseBody: any): { inputTokens: number; outputTokens: number } {
  const usage = responseBody.usageMetadata
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0 }
  }

  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  }
}

// ── Delta cache helpers ──────────────────────────────────────────────────────

function hashInputs(systemPrompt: string, userPrompt: string, schema?: object): string {
  const combined = systemPrompt + userPrompt + JSON.stringify(schema ?? '')
  return 'sha256:' + createHash('sha256').update(combined, 'utf-8').digest('hex')
}

interface DeltaCacheEntry {
  hash: string
  result: {
    text: string
    model: string
  }
  timestamp: string
}

function readDeltaCache(key: string): DeltaCacheEntry | null {
  const filePath = resolve(CACHE_DIR, `${key}.json`)
  if (!existsSync(filePath)) return null

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function writeDeltaCache(key: string, hash: string, result: { text: string; model: string }): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true })
  }

  const entry: DeltaCacheEntry = {
    hash,
    result,
    timestamp: new Date().toISOString(),
  }

  const filePath = resolve(CACHE_DIR, `${key}.json`)
  writeJsonAtomic(filePath, entry)
}
