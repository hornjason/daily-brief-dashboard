// BKL-AI-FP-06: AI event bus (FP-04) — unit tests
import { describe, it, expect } from 'bun:test'
import { emitAIEvent, onAIEvent, offAIEvent, type AIIntelEvent } from '../../src/ai-events.ts'

describe('ai-events bus (FP-04)', () => {
  it('registered listener fires with correct event shape', () => {
    const received: AIIntelEvent[] = []
    const handler = (e: AIIntelEvent) => received.push(e)
    onAIEvent(handler)
    emitAIEvent({ type: 'cache:hit', accountId: 'test-co', flow: 'brief', source: 'l1' })
    offAIEvent(handler)
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('cache:hit')
    expect(received[0].accountId).toBe('test-co')
  })

  it('removed listener does not fire after offAIEvent', () => {
    const received: AIIntelEvent[] = []
    const handler = (e: AIIntelEvent) => received.push(e)
    onAIEvent(handler)
    offAIEvent(handler)
    emitAIEvent({ type: 'generation:start', accountId: 'test-co', flow: 'brief', source: 'l1' })
    expect(received).toHaveLength(0)
  })

  it('multiple listeners all fire on single emit', () => {
    const r1: AIIntelEvent[] = []
    const r2: AIIntelEvent[] = []
    const h1 = (e: AIIntelEvent) => r1.push(e)
    const h2 = (e: AIIntelEvent) => r2.push(e)
    onAIEvent(h1)
    onAIEvent(h2)
    emitAIEvent({ type: 'cache:miss', accountId: 'x', flow: 'brief', source: 'l1' })
    offAIEvent(h1)
    offAIEvent(h2)
    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)
  })
})
