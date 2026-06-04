/**
 * src/lib/gemini-tactic-recommender.ts
 * Gemini-powered tactic recommendation — Phase 1 (blind eval only).
 *
 * GitHub Issue #599 — Gemini inference layer
 *
 * Takes a customer's graph summary and the solution portfolio,
 * sends it to Gemini, and returns ranked tactic recommendations
 * with reasoning.
 *
 * This module does NOT replace the deterministic path in tactic-scorer.ts.
 * It exists solely for blind evaluation against the deterministic path.
 *
 * Dependencies:
 *   - gemini-call.ts — callGemini() wrapper (ADR-023)
 *   - graph-summary.ts — summarizeGraph()
 */

import { callGemini } from '../gemini-call.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface GeminiRecommendation {
  tacticName: string
  parentTdp: string
  reasoning: string
  confidence: 'high' | 'medium' | 'low'
  signalsUsed: string[]
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Red Hat sales intelligence assistant. Given a customer's signal profile and a list of available sales tactics, recommend the top 5 most relevant tactics.

For each tactic you recommend, provide:
1. The exact tactic name (must match one from the available tactics list)
2. The parent TDP name
3. Specific reasoning — WHY this tactic matters for THIS customer based on their signals
4. Confidence level (high/medium/low)
5. Which customer signals drove this recommendation

Respond with ONLY a JSON array. No markdown, no explanation outside the array.

Example format:
[
  {
    "tacticName": "Exact Tactic Name",
    "parentTdp": "TDP Domain Name",
    "reasoning": "Customer has 3 active OpenShift subscriptions and 2 critical cases on container orchestration, suggesting they need advanced container management capabilities.",
    "confidence": "high",
    "signalsUsed": ["OpenShift subscription", "Critical container case #12345"]
  }
]

Rules:
- Recommend exactly 5 tactics (or fewer if fewer than 5 are available)
- Only recommend tactics from the provided list — never invent tactics
- Reasoning must cite specific facts from the customer profile, not generic statements
- High confidence = multiple corroborating signals; Medium = 1-2 signals; Low = indirect inference
- Order by relevance (most relevant first)`

function buildUserPrompt(
  graphSummary: string,
  availableTactics: Array<{ name: string; parentTdp: string; description?: string }>,
  customerName: string,
): string {
  const tacticList = availableTactics
    .map(t => `- ${t.name} (TDP: ${t.parentTdp})${t.description ? ` — ${t.description}` : ''}`)
    .join('\n')

  return `## Customer Profile
${graphSummary}

## Available Tactics (${availableTactics.length} total)
${tacticList}

Recommend the top 5 most relevant tactics for ${customerName} based on their signal profile above.`
}

// ── Response Schema ──────────────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      tacticName: { type: 'STRING' },
      parentTdp: { type: 'STRING' },
      reasoning: { type: 'STRING' },
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
      signalsUsed: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['tacticName', 'parentTdp', 'reasoning', 'confidence', 'signalsUsed'],
  },
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Call Gemini to recommend the top 5 most relevant tactics for a customer.
 *
 * Uses structured JSON output (responseSchema) for reliable parsing.
 * Falls back to text parsing if structured output fails.
 */
export async function recommendTactics(
  graphSummary: string,
  availableTactics: Array<{ name: string; parentTdp: string; description?: string }>,
  customerName: string,
): Promise<GeminiRecommendation[]> {
  const userPrompt = buildUserPrompt(graphSummary, availableTactics, customerName)

  const result = await callGemini(SYSTEM_PROMPT, userPrompt, {
    callType: 'tactic-recommendation',
    customerName,
    responseSchema: RESPONSE_SCHEMA,
    model: 'full',
  })

  return parseResponse(result.text, availableTactics)
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse Gemini response into GeminiRecommendation[].
 * Handles both structured JSON and freeform text responses.
 * Validates that recommended tactics exist in the available set.
 */
function parseResponse(
  text: string,
  availableTactics: Array<{ name: string; parentTdp: string }>,
): GeminiRecommendation[] {
  const availableNames = new Set(availableTactics.map(t => t.name.toLowerCase()))

  try {
    // Try parsing as JSON array directly
    const parsed = JSON.parse(text)
    const items = Array.isArray(parsed) ? parsed : [parsed]

    return items
      .filter((item: any) => {
        // Validate the tactic exists in available set
        if (!item.tacticName) return false
        return availableNames.has(item.tacticName.toLowerCase())
      })
      .map((item: any): GeminiRecommendation => ({
        tacticName: String(item.tacticName),
        parentTdp: String(item.parentTdp ?? ''),
        reasoning: String(item.reasoning ?? ''),
        confidence: validateConfidence(item.confidence),
        signalsUsed: Array.isArray(item.signalsUsed)
          ? item.signalsUsed.map(String)
          : [],
      }))
      .slice(0, 5)
  } catch {
    // If JSON parsing fails, try to extract JSON from markdown code blocks
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        return parseResponse(JSON.stringify(parsed), availableTactics)
      } catch {
        // Fall through to empty result
      }
    }

    console.warn('[gemini-tactic-recommender] Failed to parse Gemini response as JSON')
    return []
  }
}

function validateConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const str = String(value).toLowerCase()
  if (str === 'high' || str === 'medium' || str === 'low') return str
  return 'low'
}

// ── Enhanced Types (#613) ───────────────────────────────────────────────────

export interface EnhancedGeminiRecommendation extends GeminiRecommendation {
  /** true if NOT in deterministic top N */
  isNovel: boolean
  /** why this is novel — what signal pattern led to it */
  discoveryReason?: string
}

// ── Enhanced Prompt (#613) ──────────────────────────────────────────────────

const ENHANCED_SYSTEM_PROMPT = `You are a Red Hat sales intelligence assistant performing DEEP tactic inference.

You are given:
1. A summary of the customer's signal profile
2. The FULL intelligence graph (all nodes, edges, relationships, and properties)
3. A list of available sales tactics
4. Which tactics the DETERMINISTIC scorer already ranked highest

Your job is to find recommendations the deterministic scorer MISSED. Look for:
- Non-obvious multi-signal patterns (e.g., "mainframe modernization initiative + RHEL subscription + automation cases = platform migration play")
- Cross-domain connections that single-signal scoring misses
- Temporal patterns (recent engagement + upcoming EOL + competitive pressure)
- Weak signals that become strong when correlated with other signals

For each tactic you recommend, provide:
1. The exact tactic name (must match one from the available tactics list)
2. The parent TDP name
3. Specific reasoning citing MULTIPLE correlated signals from the graph
4. Confidence level (high/medium/low)
5. Which customer signals drove this recommendation
6. Whether this is novel (not in the deterministic top list)
7. A discovery reason explaining the multi-signal pattern you found

Respond with ONLY a JSON array. No markdown, no explanation outside the array.

Example format:
[
  {
    "tacticName": "Exact Tactic Name",
    "parentTdp": "TDP Domain Name",
    "reasoning": "Customer has mainframe modernization initiative combined with 3 RHEL subscriptions and 2 automation cases, suggesting a platform migration play that the deterministic scorer missed because it only scored individual signals.",
    "confidence": "high",
    "signalsUsed": ["mainframe initiative", "RHEL subscriptions", "automation cases"],
    "isNovel": true,
    "discoveryReason": "Mainframe modernization + RHEL + automation cases = platform migration pattern"
  }
]

Rules:
- Recommend up to 5 tactics, focusing on ones the deterministic scorer MISSED
- Only recommend tactics from the provided list — never invent tactics
- Reasoning MUST cite specific multi-signal patterns from the graph, not generic statements
- Prioritize novel discoveries over confirming what the deterministic scorer already found
- High confidence = 3+ corroborating signals; Medium = 2 signals; Low = indirect inference
- Order by novelty and relevance (most novel and relevant first)`

function buildEnhancedUserPrompt(
  graphSummary: string,
  fullGraphContext: string,
  availableTactics: Array<{ name: string; parentTdp: string; description?: string }>,
  deterministicTop: string[],
  customerName: string,
): string {
  const tacticList = availableTactics
    .map(t => `- ${t.name} (TDP: ${t.parentTdp})${t.description ? ` — ${t.description}` : ''}`)
    .join('\n')

  const deterministicList = deterministicTop.length > 0
    ? deterministicTop.map(t => `- ${t}`).join('\n')
    : '(none)'

  return `## Customer Summary
${graphSummary}

## Full Intelligence Graph
${fullGraphContext}

## Deterministic Top Tactics (already scored high — focus on what they MISSED)
${deterministicList}

## Available Tactics (${availableTactics.length} total)
${tacticList}

Find the top recommendations for ${customerName} that the deterministic scorer MISSED. Look for non-obvious multi-signal patterns in the full graph.`
}

// ── Enhanced Response Schema (#613) ─────────────────────────────────────────

const ENHANCED_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      tacticName: { type: 'STRING' },
      parentTdp: { type: 'STRING' },
      reasoning: { type: 'STRING' },
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
      signalsUsed: { type: 'ARRAY', items: { type: 'STRING' } },
      isNovel: { type: 'BOOLEAN' },
      discoveryReason: { type: 'STRING' },
    },
    required: ['tacticName', 'parentTdp', 'reasoning', 'confidence', 'signalsUsed', 'isNovel', 'discoveryReason'],
  },
}

// ── Enhanced Public API (#613) ──────────────────────────────────────────────

/**
 * Enhanced Gemini tactic recommendation using full graph context.
 *
 * Unlike recommendTactics(), this function:
 * - Receives the full graph context (all nodes, edges, properties)
 * - Knows which tactics the deterministic scorer already ranked high
 * - Focuses on finding non-obvious multi-signal connections
 * - Flags results as novel when they're NOT in the deterministicTop list
 *
 * GitHub Issue #613 — Deeper Gemini inference
 */
export async function enhancedRecommendTactics(
  graphSummary: string,
  fullGraphContext: string,
  availableTactics: Array<{ name: string; parentTdp: string; description?: string }>,
  deterministicTop: string[],
  customerName: string,
): Promise<EnhancedGeminiRecommendation[]> {
  const userPrompt = buildEnhancedUserPrompt(
    graphSummary,
    fullGraphContext,
    availableTactics,
    deterministicTop,
    customerName,
  )

  const result = await callGemini(ENHANCED_SYSTEM_PROMPT, userPrompt, {
    callType: 'enhanced-tactic-recommendation',
    customerName,
    responseSchema: ENHANCED_RESPONSE_SCHEMA,
    model: 'full',
  })

  return parseEnhancedResponse(result.text, availableTactics, deterministicTop)
}

/**
 * Parse enhanced Gemini response, setting isNovel based on deterministicTop.
 */
function parseEnhancedResponse(
  text: string,
  availableTactics: Array<{ name: string; parentTdp: string }>,
  deterministicTop: string[],
): EnhancedGeminiRecommendation[] {
  const availableNames = new Set(availableTactics.map(t => t.name.toLowerCase()))
  const deterministicSet = new Set(deterministicTop.map(t => t.toLowerCase()))

  try {
    const parsed = JSON.parse(text)
    const items = Array.isArray(parsed) ? parsed : [parsed]

    return items
      .filter((item: any) => {
        if (!item.tacticName) return false
        return availableNames.has(item.tacticName.toLowerCase())
      })
      .map((item: any): EnhancedGeminiRecommendation => {
        const tacticName = String(item.tacticName)
        const isNovel = !deterministicSet.has(tacticName.toLowerCase())
        return {
          tacticName,
          parentTdp: String(item.parentTdp ?? ''),
          reasoning: String(item.reasoning ?? ''),
          confidence: validateConfidence(item.confidence),
          signalsUsed: Array.isArray(item.signalsUsed)
            ? item.signalsUsed.map(String)
            : [],
          isNovel,
          discoveryReason: isNovel ? String(item.discoveryReason ?? '') : undefined,
        }
      })
      .slice(0, 5)
  } catch {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        return parseEnhancedResponse(JSON.stringify(parsed), availableTactics, deterministicTop)
      } catch {
        // Fall through
      }
    }

    console.warn('[gemini-tactic-recommender] Failed to parse enhanced Gemini response as JSON')
    return []
  }
}

// ── Merge Logic (#613) ──────────────────────────────────────────────────────

export interface MergedRecommendation {
  name: string
  parentTdp: string
  compositeScore?: number
  reasoning?: string
  confidence?: 'high' | 'medium' | 'low'
  signalsUsed?: string[]
  isNovel: boolean
  discoveryReason?: string
}

/**
 * Merge deterministic scored tactics with Gemini novel recommendations.
 *
 * - Deduplicates by tactic name (case-insensitive)
 * - Keeps deterministic ranking for overlapping tactics
 * - Appends novel Gemini recommendations after deterministic ones
 * - Caps total at 8 recommendations (5 deterministic + up to 3 novel)
 *
 * GitHub Issue #613
 */
export function mergeRecommendations(
  deterministicTactics: Array<{ name: string; parentTdp: string; compositeScore: number }>,
  geminiNovel: EnhancedGeminiRecommendation[],
): MergedRecommendation[] {
  const result: MergedRecommendation[] = []
  const seenNames = new Set<string>()

  // Add deterministic tactics first (preserve order)
  for (const dt of deterministicTactics) {
    const key = dt.name.toLowerCase()
    if (seenNames.has(key)) continue
    seenNames.add(key)
    result.push({
      name: dt.name,
      parentTdp: dt.parentTdp,
      compositeScore: dt.compositeScore,
      isNovel: false,
    })
  }

  // Append novel Gemini recommendations (up to 3)
  const MAX_NOVEL = 3
  let novelCount = 0

  for (const gr of geminiNovel) {
    if (novelCount >= MAX_NOVEL) break
    const key = gr.tacticName.toLowerCase()
    if (seenNames.has(key)) continue
    if (!gr.isNovel) continue

    seenNames.add(key)
    result.push({
      name: gr.tacticName,
      parentTdp: gr.parentTdp,
      reasoning: gr.reasoning,
      confidence: gr.confidence,
      signalsUsed: gr.signalsUsed,
      isNovel: true,
      discoveryReason: gr.discoveryReason,
    })
    novelCount++
  }

  // Cap at 8 total
  return result.slice(0, 8)
}
