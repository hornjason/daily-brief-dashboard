import { describe, test, expect } from 'bun:test'
import { buildRequestBody } from '../../src/gemini-call.ts'

describe('Gemini thinking budget per model tier', () => {
  const sys = 'You are helpful.'
  const usr = 'Hello'
  const baseOpts = { callType: 'test', customer: 'test' }

  test('Flash model gets thinkingBudget: 0', () => {
    const body: any = buildRequestBody(sys, usr, baseOpts, 'gemini-2.0-flash')
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  test('Flash-thinking model gets thinkingBudget: 0', () => {
    const body: any = buildRequestBody(sys, usr, baseOpts, 'gemini-2.5-flash')
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  test('Pro model does NOT get thinkingBudget', () => {
    const body: any = buildRequestBody(sys, usr, baseOpts, 'gemini-2.5-pro')
    expect(body.generationConfig.thinkingConfig).toBeUndefined()
  })

  test('Lite model does NOT get thinkingBudget', () => {
    const body: any = buildRequestBody(sys, usr, baseOpts, 'gemini-2.0-flash-lite')
    expect(body.generationConfig.thinkingConfig).toBeUndefined()
  })

  test('Unknown model does NOT get thinkingBudget', () => {
    const body: any = buildRequestBody(sys, usr, baseOpts, 'gemini-3.0-ultra')
    expect(body.generationConfig.thinkingConfig).toBeUndefined()
  })
})
