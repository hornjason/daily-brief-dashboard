// BKL-AI-FP-04: AI intelligence pipeline event emitter
// Advisory SSE event bus — never throws, never crashes the intelligence pipeline.

import { EventEmitter } from 'events'

export type AIIntelEvent = {
  type: 'cache:cold' | 'cache:hit' | 'cache:miss' | 'cache:bypass'
       | 'cache:stale' | 'generation:start' | 'generation:complete' | 'generation:error'
  accountId: string
  flow: 'brief' | 'account-intel' | 'product-intel'
  source: 'l1' | 'l2' | 'l3' | 'l4'
  fingerprintHash?: string
  tokensUsed?: number
  durationMs?: number
  // BKL-AI-FP-09: corpus-delta telemetry on generation:complete
  deltaMode?: boolean
  unchangedDocCount?: number
  timestamp: string
}

const aiEventEmitter = new EventEmitter()
aiEventEmitter.setMaxListeners(50)

export const onAIEvent = (fn: (e: AIIntelEvent) => void): void => { aiEventEmitter.on('ai-intel', fn) }
export const offAIEvent = (fn: (e: AIIntelEvent) => void): void => { aiEventEmitter.off('ai-intel', fn) }

export function emitAIEvent(params: Omit<AIIntelEvent, 'timestamp'>): void {
  try {
    const event: AIIntelEvent = { timestamp: new Date().toISOString(), ...params }
    aiEventEmitter.emit('ai-intel', event)
  } catch {
    // swallow — advisory only, must never crash the intelligence pipeline
  }
}
