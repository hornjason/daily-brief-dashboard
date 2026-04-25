// BKL-AI-FP-06: DISALLOW_GEMINI flag behavior (FP-01) — unit tests
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { callLLM, callLLMStructured } from '../../src/customer.ts'

describe('DISALLOW_GEMINI (FP-01)', () => {
  beforeEach(() => { process.env.DISALLOW_GEMINI = 'true' })
  afterEach(() => { delete process.env.DISALLOW_GEMINI })

  it('callLLM returns non-empty fixture string', async () => {
    const result = await callLLM('sys', 'user', 'test', 'test-customer')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('callLLMStructured returns items:[] and GEMINI_DISABLED data_gap', async () => {
    const result = await callLLMStructured('sys', 'user', {}, 'test', 'test-customer')
    expect(result).toMatchObject({ items: [], data_gaps: ['GEMINI_DISABLED'] })
  })

})
