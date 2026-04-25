// TEST-P3-02 Phase 7 mutation-killing tests for SSE event emitter.
// Runtime: bun:test (project uses Bun's native test runner; no vitest).

import { describe, it, expect, mock } from 'bun:test'
import { emitAIEvent, onAIEvent, offAIEvent, type AIIntelEvent } from '../../src/ai-events.ts'

describe('ai-events SSE emitter', () => {
  it('emitAIEvent calls registered onAIEvent handler', () => {
    const handler = mock(() => {})
    onAIEvent(handler)
    emitAIEvent({ type: 'cache:hit', accountId: 'acme', flow: 'brief', source: 'l1' })
    expect(handler).toHaveBeenCalledTimes(1)
    offAIEvent(handler)
  })

  it('emitted event has timestamp added automatically', () => {
    let received: AIIntelEvent | null = null
    const handler = (e: AIIntelEvent) => { received = e }
    onAIEvent(handler)
    emitAIEvent({ type: 'cache:miss', accountId: 'acme', flow: 'brief', source: 'l1' })
    expect(received).not.toBeNull()
    expect(received!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/)
    offAIEvent(handler)
  })

  it('offAIEvent removes handler — no more calls', () => {
    const handler = mock(() => {})
    onAIEvent(handler)
    offAIEvent(handler)
    emitAIEvent({ type: 'cache:bypass', accountId: 'acme', flow: 'brief', source: 'l1' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('emitAIEvent does not throw when handler throws', () => {
    const throwing = () => { throw new Error('handler error') }
    onAIEvent(throwing)
    expect(() => emitAIEvent({ type: 'generation:start', accountId: 'x', flow: 'brief', source: 'l1' })).not.toThrow()
    offAIEvent(throwing)
  })

  it('multiple handlers all receive the event', () => {
    const h1 = mock(() => {})
    const h2 = mock(() => {})
    onAIEvent(h1)
    onAIEvent(h2)
    emitAIEvent({ type: 'generation:complete', accountId: 'x', flow: 'brief', source: 'l1', durationMs: 1200 })
    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
    offAIEvent(h1)
    offAIEvent(h2)
  })

  it('event type is preserved on the emitted event', () => {
    let received: AIIntelEvent | null = null
    const handler = (e: AIIntelEvent) => { received = e }
    onAIEvent(handler)
    emitAIEvent({ type: 'cache:stale', accountId: 'x', flow: 'account-intel', source: 'l4' })
    expect(received?.type).toBe('cache:stale')
    expect(received?.flow).toBe('account-intel')
    expect(received?.source).toBe('l4')
    offAIEvent(handler)
  })

  it('optional fields are preserved when provided', () => {
    let received: AIIntelEvent | null = null
    const handler = (e: AIIntelEvent) => { received = e }
    onAIEvent(handler)
    emitAIEvent({ type: 'generation:complete', accountId: 'x', flow: 'brief', source: 'l1', tokensUsed: 5000, durationMs: 3200, fingerprintHash: 'abc123' })
    expect(received?.tokensUsed).toBe(5000)
    expect(received?.durationMs).toBe(3200)
    expect(received?.fingerprintHash).toBe('abc123')
    offAIEvent(handler)
  })
})
