import { readFileSync } from 'fs'

// ── Module state ─────────────────────────────────────────────────────────────
let _dataSourcesPath = ''

export function initAiConfig(path: string): void {
  _dataSourcesPath = path
}

// ── AI & Intelligence config ─────────────────────────────────────────────────

export interface AiConfig {
  geminiModel: string                // 'gemini-2.5-flash' | 'gemini-2.5-pro'
  geminiModelLite: string            // 'gemini-2.5-flash-lite' — cheap model for high-volume brief/extract calls
  briefSynthesisTemperature: number  // 0.0–1.0
  customerIntelTemperature: number   // 0.0–1.0
  featureExtractionMaxFeatures: number
  geminiInputCostPerM: number        // USD per 1M input tokens
  geminiOutputCostPerM: number       // USD per 1M output tokens
  intelligenceEnabled: boolean       // false = disable all Gemini intelligence generation globally
  docClassifyMaxAgeDays: number      // 0 = unlimited; >0 = skip docs older than N days (BKL-AI-COST-04)
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  geminiModel: 'gemini-3.5-flash',
  geminiModelLite: 'gemini-3.5-flash',
  briefSynthesisTemperature: 0.7,
  customerIntelTemperature: 0.3,
  featureExtractionMaxFeatures: 30,
  geminiInputCostPerM: 0.30,
  geminiOutputCostPerM: 2.50,
  intelligenceEnabled: true,
  docClassifyMaxAgeDays: 0,          // 0 = unlimited (classify all docs regardless of age)
}

export function getAiConfig(): AiConfig {
  try {
    const ds = JSON.parse(readFileSync(_dataSourcesPath, 'utf-8'))
    return { ...DEFAULT_AI_CONFIG, ...(ds.aiConfig ?? {}) }
  } catch { return { ...DEFAULT_AI_CONFIG } }
}

/** Gemini model selection: env var takes precedence over persisted config. */
export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL ?? getAiConfig().geminiModel
}

/** Lite model for high-volume cheap calls (brief-extract, brief-synthesize, product-qa, doc-classify). */
export function getGeminiModelLite(): string {
  return process.env.GEMINI_MODEL_LITE ?? getAiConfig().geminiModelLite
}

// ── Automation config ────────────────────────────────────────────────────────

export interface AutomationConfig {
  defaultScrapeTimeoutMs: number    // default 5 * 60 * 1000 (5 min)
  rhScrapeTimeoutMs: number         // default 10 * 60 * 1000 (10 min)
  circuitBreakerThreshold: number   // default 3
  circuitBreakerCooldownMs: number  // default 5 * 60 * 1000 (5 min)
  driveDocTextCap: number           // chars per doc, default 15000
  briefEmailsInPrompt: number       // emails included in brief, default 20
  briefHistoryDays: number          // days of brief history in prompt, default 7
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  defaultScrapeTimeoutMs: 5 * 60 * 1000,
  rhScrapeTimeoutMs: 10 * 60 * 1000,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 5 * 60 * 1000,
  driveDocTextCap: 15_000,
  briefEmailsInPrompt: 20,
  briefHistoryDays: 7,
}

export function getAutomationConfig(): AutomationConfig {
  try {
    const ds = JSON.parse(readFileSync(_dataSourcesPath, 'utf-8'))
    return { ...DEFAULT_AUTOMATION_CONFIG, ...(ds.automationConfig ?? {}) }
  } catch { return { ...DEFAULT_AUTOMATION_CONFIG } }
}
