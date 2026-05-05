import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  initAiConfig,
  getAiConfig,
  getGeminiModel,
  getGeminiModelLite,
  getAutomationConfig,
  DEFAULT_AI_CONFIG,
  DEFAULT_AUTOMATION_CONFIG,
} from '../../src/ai-config.ts'

describe('ai-config (BKL-ARCH-01)', () => {
  beforeEach(() => {
    // Point at a non-existent path so getters fall back to defaults.
    initAiConfig('/dev/null/does-not-exist')
    delete process.env.GEMINI_MODEL
    delete process.env.GEMINI_MODEL_LITE
  })

  afterEach(() => {
    delete process.env.GEMINI_MODEL
    delete process.env.GEMINI_MODEL_LITE
  })

  test('getAiConfig returns DEFAULT_AI_CONFIG when file missing', () => {
    const cfg = getAiConfig()
    expect(cfg.geminiModel).toBe(DEFAULT_AI_CONFIG.geminiModel)
    expect(cfg.geminiModelLite).toBe(DEFAULT_AI_CONFIG.geminiModelLite)
    expect(cfg.intelligenceEnabled).toBe(DEFAULT_AI_CONFIG.intelligenceEnabled)
    expect(cfg.featureExtractionMaxFeatures).toBe(DEFAULT_AI_CONFIG.featureExtractionMaxFeatures)
  })

  test('getGeminiModel returns DEFAULT_AI_CONFIG.geminiModel when no env override', () => {
    expect(getGeminiModel()).toBe(DEFAULT_AI_CONFIG.geminiModel)
  })

  test('getGeminiModelLite returns DEFAULT_AI_CONFIG.geminiModelLite when no env override', () => {
    expect(getGeminiModelLite()).toBe(DEFAULT_AI_CONFIG.geminiModelLite)
  })

  test('GEMINI_MODEL env var overrides getGeminiModel', () => {
    process.env.GEMINI_MODEL = 'gemini-2.5-pro'
    expect(getGeminiModel()).toBe('gemini-2.5-pro')
  })

  test('GEMINI_MODEL_LITE env var overrides getGeminiModelLite', () => {
    process.env.GEMINI_MODEL_LITE = 'gemini-test-lite'
    expect(getGeminiModelLite()).toBe('gemini-test-lite')
  })

  test('getAutomationConfig returns DEFAULT_AUTOMATION_CONFIG when file missing', () => {
    const cfg = getAutomationConfig()
    expect(cfg.circuitBreakerThreshold).toBe(DEFAULT_AUTOMATION_CONFIG.circuitBreakerThreshold)
    expect(cfg.driveDocTextCap).toBe(DEFAULT_AUTOMATION_CONFIG.driveDocTextCap)
    expect(cfg.briefEmailsInPrompt).toBe(DEFAULT_AUTOMATION_CONFIG.briefEmailsInPrompt)
    expect(cfg.briefHistoryDays).toBe(DEFAULT_AUTOMATION_CONFIG.briefHistoryDays)
  })
})
