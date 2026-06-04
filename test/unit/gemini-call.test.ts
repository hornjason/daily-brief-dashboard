/**
 * Unit tests for callGemini() — BKL-ARCH-06 Phase 1
 *
 * Tests the standardized Gemini call wrapper:
 *   - Delta detection (input hash caching)
 *   - Timeout tier selection
 *   - Model resolution
 *   - Type exports
 *
 * These are true unit tests — they mock the Gemini API and test the wrapper logic.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { resolve } from 'path'

// ── Test environment setup ──────────────────────────────────────────────────
const TEST_CACHE_DIR = resolve(import.meta.dir, '../../data/cache/gemini-delta')

beforeEach(() => {
  // Ensure cache directory exists
  if (!existsSync(TEST_CACHE_DIR)) {
    mkdirSync(TEST_CACHE_DIR, { recursive: true })
  }
})

afterEach(() => {
  // Clean up test cache files
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
  }
})

// ── Mock helpers ─────────────────────────────────────────────────────────────

function mockGeminiResponse(text: string, inputTokens = 10, outputTokens = 20) {
  return {
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
      },
    }),
  }
}

async function mockFetchGeminiWithRetry() {
  return mockGeminiResponse('Test response')
}

async function mockGetGeminiToken() {
  return 'mock-token-12345'
}

function mockRecordGeminiUsage() {
  // No-op for unit tests
}

// ── Delta detection tests ────────────────────────────────────────────────────

describe('callGemini() — delta detection', () => {
  test('returns cached result when input hash matches', async () => {
    // Mock the fetch layer
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(mockFetchGeminiWithRetry)
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    // First call — should hit the API
    const result1 = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-delta',
        deltaKey: 'test-key-1',
        model: 'lite',
      }
    )

    expect(result1.cached).toBe(false)
    expect(result1.text).toBe('Test response')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Second call with identical inputs — should return cached
    const result2 = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-delta',
        deltaKey: 'test-key-1',
        model: 'lite',
      }
    )

    expect(result2.cached).toBe(true)
    expect(result2.text).toBe(result1.text)
    expect(result2.inputTokens).toBe(0)
    expect(result2.outputTokens).toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // No additional call

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })

  test('makes new call when input content changes', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    let callCount = 0
    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(async () => {
      callCount++
      return mockGeminiResponse(`Response ${callCount}`)
    })
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    // First call
    const result1 = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-delta',
        deltaKey: 'test-key-2',
        model: 'lite',
      }
    )

    expect(result1.cached).toBe(false)

    // Second call with different user prompt — different hash
    const result2 = await callGemini(
      'You are a test assistant',
      'Say goodbye',
      {
        callType: 'test-delta',
        deltaKey: 'test-key-2',
        model: 'lite',
      }
    )

    expect(result2.cached).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })

  test('makes new call when response schema changes', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(mockFetchGeminiWithRetry)
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    const schema1 = {
      type: 'object',
      properties: { greeting: { type: 'string' } },
    }

    const result1 = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-delta',
        deltaKey: 'test-key-3',
        responseSchema: schema1,
        model: 'lite',
      }
    )

    expect(result1.cached).toBe(false)

    // Different schema — different hash
    const schema2 = {
      type: 'object',
      properties: { message: { type: 'string' } },
    }

    const result2 = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-delta',
        deltaKey: 'test-key-3',
        responseSchema: schema2,
        model: 'lite',
      }
    )

    expect(result2.cached).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })

  test('omitting deltaKey always makes fresh calls', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(mockFetchGeminiWithRetry)
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    const result1 = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-no-delta',
        model: 'lite',
      }
    )

    const result2 = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-no-delta',
        model: 'lite',
      }
    )

    expect(result1.cached).toBe(false)
    expect(result2.cached).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })
})

// ── Timeout tier selection tests ────────────────────────────────────────────
// These tests verify timeout logic by inspecting what's passed to fetchGeminiWithRetry

describe('callGemini() — timeout tier selection', () => {
  test('passes 30s timeout for structured output (responseSchema)', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    let capturedTimeout: number | undefined
    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(async (url, getToken, body, context) => {
      capturedTimeout = context.timeoutMs
      return mockGeminiResponse('Test')
    })
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    await callGemini(
      'You are a test assistant',
      'Return a structured greeting',
      {
        callType: 'test-structured',
        responseSchema: {
          type: 'object',
          properties: { greeting: { type: 'string' } },
        },
        model: 'lite',
      }
    )

    expect(capturedTimeout).toBe(30_000)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })

  test('passes 180s timeout for campaign generation', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    let capturedTimeout: number | undefined
    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(async (url, getToken, body, context) => {
      capturedTimeout = context.timeoutMs
      return mockGeminiResponse('Test')
    })
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    await callGemini(
      'You are a campaign writer',
      'Write a brief email',
      {
        callType: 'campaign-generation',
        model: 'lite',
      }
    )

    expect(capturedTimeout).toBe(180_000)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })

  test('respects explicit timeoutMs override', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    let capturedTimeout: number | undefined
    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(async (url, getToken, body, context) => {
      capturedTimeout = context.timeoutMs
      return mockGeminiResponse('Test')
    })
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-timeout',
        timeoutMs: 10_000,
        model: 'lite',
      }
    )

    expect(capturedTimeout).toBe(10_000)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })
})

// ── Model resolution tests ──────────────────────────────────────────────────

describe('callGemini() — model resolution', () => {
  test('resolves "lite" to configured lite model', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(() =>
      mockGeminiResponse('Test')
    )
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    const result = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-model-lite',
        model: 'lite',
      }
    )

    expect(result.model).toContain('flash')

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })

  test('resolves "pro" to gemini-2.5-pro', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(() =>
      mockGeminiResponse('Test')
    )
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    const result = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-model-pro',
        model: 'pro',
      }
    )

    expect(result.model).toBe('gemini-2.5-pro')

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })
})

// ── Integration tests ────────────────────────────────────────────────────────

describe('callGemini() — integration with primitives', () => {
  test('returns token counts on fresh calls', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(() =>
      mockGeminiResponse('Test', 15, 25)
    )
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)

    const { callGemini } = await import('../../src/gemini-call.ts')

    const result = await callGemini(
      'You are a test assistant',
      'Say hello in one word',
      {
        callType: 'test-tokens',
        model: 'lite',
      }
    )

    expect(result.inputTokens).toBe(15)
    expect(result.outputTokens).toBe(25)
    expect(result.cached).toBe(false)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })

  test('calls recordGeminiUsage with correct attribution', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(() =>
      mockGeminiResponse('Test', 15, 25)
    )
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)

    let capturedUsage: any
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation((entry) => {
      capturedUsage = entry
    })

    const { callGemini } = await import('../../src/gemini-call.ts')

    await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'test-customer-attribution',
        customerName: 'ACME Corp',
        model: 'lite',
      }
    )

    expect(capturedUsage.callType).toBe('test-customer-attribution')
    expect(capturedUsage.customerName).toBe('ACME Corp')
    expect(capturedUsage.inputTokens).toBe(15)
    expect(capturedUsage.outputTokens).toBe(25)

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
  })
})

// ── Model override from config tests ────────────────────────────────────────

describe('callGemini() — per-callType model overrides', () => {
  test('uses config override when callType has an override set', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')
    const aiConfigModule = await import('../../src/ai-config.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(() =>
      mockGeminiResponse('Test')
    )
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)
    const configSpy = spyOn(aiConfigModule, 'getAiConfig').mockReturnValue({
      ...aiConfigModule.DEFAULT_AI_CONFIG,
      modelOverrides: { 'brief-synthesis': 'pro' },
    })

    const { callGemini } = await import('../../src/gemini-call.ts')

    const result = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'brief-synthesis',
        model: 'lite',
      }
    )

    expect(result.model).toBe('gemini-2.5-pro')

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
    configSpy.mockRestore()
  })

  test('falls back to caller-specified model when no override exists', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')
    const aiConfigModule = await import('../../src/ai-config.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(() =>
      mockGeminiResponse('Test')
    )
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)
    const configSpy = spyOn(aiConfigModule, 'getAiConfig').mockReturnValue({
      ...aiConfigModule.DEFAULT_AI_CONFIG,
      modelOverrides: {},
    })

    const { callGemini } = await import('../../src/gemini-call.ts')

    const result = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'news-scoring',
        model: 'lite',
      }
    )

    expect(result.model).toContain('flash')

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
    configSpy.mockRestore()
  })

  test('falls back to caller model when modelOverrides is undefined in config', async () => {
    const fetchModule = await import('../../src/gemini-fetch.ts')
    const authModule = await import('../../src/gemini-auth.ts')
    const costModule = await import('../../src/gemini-cost-tracker.ts')
    const aiConfigModule = await import('../../src/ai-config.ts')

    const fetchSpy = spyOn(fetchModule, 'fetchGeminiWithRetry').mockImplementation(() =>
      mockGeminiResponse('Test')
    )
    const authSpy = spyOn(authModule, 'getGeminiToken').mockImplementation(mockGetGeminiToken)
    const costSpy = spyOn(costModule, 'recordGeminiUsage').mockImplementation(mockRecordGeminiUsage)
    const configWithoutOverrides = { ...aiConfigModule.DEFAULT_AI_CONFIG }
    delete (configWithoutOverrides as any).modelOverrides
    const configSpy = spyOn(aiConfigModule, 'getAiConfig').mockReturnValue(configWithoutOverrides)

    const { callGemini } = await import('../../src/gemini-call.ts')

    const result = await callGemini(
      'You are a test assistant',
      'Say hello',
      {
        callType: 'doc-classify',
        model: 'pro',
      }
    )

    expect(result.model).toBe('gemini-2.5-pro')

    fetchSpy.mockRestore()
    authSpy.mockRestore()
    costSpy.mockRestore()
    configSpy.mockRestore()
  })
})

// ── Grounding + responseSchema guard (issue #425) ──────────────────────────

describe('buildRequestBody() — grounding vs responseSchema guard', () => {
  test('drops responseSchema and responseMimeType when grounding is also set', () => {
    const { buildRequestBody } = require('../../src/gemini-call.ts')

    const schema = { type: 'object', properties: { name: { type: 'string' } } }
    const body: any = buildRequestBody(
      'system prompt',
      'user prompt',
      { callType: 'test', grounding: true, responseSchema: schema },
      'gemini-2.5-flash'
    )

    // Grounding should be present
    expect(body.tools).toBeDefined()
    expect(body.tools[0].google_search).toBeDefined()

    // responseSchema and responseMimeType must be stripped
    expect(body.generationConfig.responseSchema).toBeUndefined()
    expect(body.generationConfig.responseMimeType).toBeUndefined()
  })

  test('keeps responseSchema when grounding is NOT set', () => {
    const { buildRequestBody } = require('../../src/gemini-call.ts')

    const schema = { type: 'object', properties: { name: { type: 'string' } } }
    const body: any = buildRequestBody(
      'system prompt',
      'user prompt',
      { callType: 'test', responseSchema: schema },
      'gemini-2.5-flash'
    )

    expect(body.tools).toBeUndefined()
    expect(body.generationConfig.responseSchema).toEqual(schema)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
  })

  test('keeps grounding when responseSchema is NOT set', () => {
    const { buildRequestBody } = require('../../src/gemini-call.ts')

    const body: any = buildRequestBody(
      'system prompt',
      'user prompt',
      { callType: 'test', grounding: true },
      'gemini-2.5-flash'
    )

    expect(body.tools).toBeDefined()
    expect(body.tools[0].google_search).toBeDefined()
    expect(body.generationConfig.responseSchema).toBeUndefined()
    expect(body.generationConfig.responseMimeType).toBeUndefined()
  })
})

// ── Type exports test ────────────────────────────────────────────────────────

describe('callGemini() — type exports', () => {
  test('exports GeminiCallOptions type', () => {
    // TypeScript compilation test
    const options: import('../../src/gemini-call.ts').GeminiCallOptions = {
      callType: 'test',
      model: 'lite',
    }
    expect(options.callType).toBe('test')
  })

  test('exports GeminiResult type', () => {
    // TypeScript compilation test
    const result: import('../../src/gemini-call.ts').GeminiResult = {
      text: 'test',
      cached: false,
      inputTokens: 10,
      outputTokens: 5,
      model: 'gemini-2.5-flash',
    }
    expect(result.text).toBe('test')
  })
})
