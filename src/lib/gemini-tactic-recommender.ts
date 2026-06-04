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
