import { EventEmitter } from 'events'

export type IngestCacheEvent = {
  type: 'cache-level'
  ae: string | null
  flow: 'sfBookings' | 'ccsp' | 'sfPipeline'
  level: 1 | 2 | 3 | 4
  rowCount?: number
  timestamp: string
}

const ingestEventEmitter = new EventEmitter()
ingestEventEmitter.setMaxListeners(50)

export const onCacheLevel = (fn: (e: IngestCacheEvent) => void): void => { ingestEventEmitter.on('cache-level', fn) }
export const offCacheLevel = (fn: (e: IngestCacheEvent) => void): void => { ingestEventEmitter.off('cache-level', fn) }

export function emitCacheLevel(params: Omit<IngestCacheEvent, 'type' | 'timestamp'>): void {
  try {
    const event: IngestCacheEvent = {
      type: 'cache-level',
      timestamp: new Date().toISOString(),
      ...params,
    }
    ingestEventEmitter.emit('cache-level', event)
  } catch {
    // swallow — emitting is advisory; a broken listener must never crash the ingest path
  }
}
