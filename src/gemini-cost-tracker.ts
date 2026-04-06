// BKL-M52: In-memory Gemini API cost tracker.
// Captures per-call token usage from Vertex AI usageMetadata.
// Pricing defaults: Gemini 2.5 Flash — $0.15/1M input tokens, $0.60/1M output tokens.
// Configurable via /api/settings/ai (BKL-SR02).

import { getAiConfig } from './settings-api.ts'

export interface GeminiUsageEntry {
  timestamp: string    // ISO-8601
  callType: string     // e.g. 'brief-synthesize', 'brief-extract', 'intelligence-industry', 'doc-classify'
  customerName: string
  inputTokens: number
  outputTokens: number
  model: string
}

interface UsageSummary {
  todayInputTokens: number
  todayOutputTokens: number
  todayCostUsd: number
  monthInputTokens: number
  monthOutputTokens: number
  monthCostUsd: number
  totalCalls: number
  byCallType: Record<string, { inputTokens: number; outputTokens: number; calls: number; costUsd: number }>
}

function computeCost(inputTokens: number, outputTokens: number): number {
  const { geminiInputCostPerM, geminiOutputCostPerM } = getAiConfig()
  return (inputTokens / 1_000_000) * geminiInputCostPerM + (outputTokens / 1_000_000) * geminiOutputCostPerM
}

// Rolling in-memory log — entries accumulate for the lifetime of the process
const usageLog: GeminiUsageEntry[] = []

export function recordGeminiUsage(entry: GeminiUsageEntry): void {
  usageLog.push(entry)
}

export function getGeminiUsageSummary(): UsageSummary {
  const now = new Date()
  const todayPrefix = now.toISOString().slice(0, 10)  // YYYY-MM-DD
  const monthPrefix = now.toISOString().slice(0, 7)   // YYYY-MM

  let todayIn = 0, todayOut = 0
  let monthIn = 0, monthOut = 0
  const byCallType: UsageSummary['byCallType'] = {}

  for (const e of usageLog) {
    const isToday = e.timestamp.startsWith(todayPrefix)
    const isMonth = e.timestamp.startsWith(monthPrefix)

    if (isToday) { todayIn += e.inputTokens; todayOut += e.outputTokens }
    if (isMonth) { monthIn += e.inputTokens; monthOut += e.outputTokens }

    if (!byCallType[e.callType]) {
      byCallType[e.callType] = { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 }
    }
    byCallType[e.callType].inputTokens  += e.inputTokens
    byCallType[e.callType].outputTokens += e.outputTokens
    byCallType[e.callType].calls        += 1
    byCallType[e.callType].costUsd      += computeCost(e.inputTokens, e.outputTokens)
  }

  return {
    todayInputTokens:  todayIn,
    todayOutputTokens: todayOut,
    todayCostUsd:      computeCost(todayIn, todayOut),
    monthInputTokens:  monthIn,
    monthOutputTokens: monthOut,
    monthCostUsd:      computeCost(monthIn, monthOut),
    totalCalls:        usageLog.length,
    byCallType,
  }
}
