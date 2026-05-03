// ── BKL-ARCH-14: SSE route module ──────────────────────────────────────────
// Extracted from server.ts — three Server-Sent Events endpoints.
// No logic changes; only relocation.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { customers } from './server-state.ts'
import { fetchEmail, fetchDrive, fetchCalendar } from './google.ts'
import { fetchCases } from './redhat.ts'
import { onCacheLevel, offCacheLevel, type IngestCacheEvent } from './ingest-events.js'
import { onAIEvent, offAIEvent, type AIIntelEvent } from './ai-events.js'
import { sanitizeErr } from './utils.ts'

export function createEventsRouter(): Hono {
  const app = new Hono()

  // SSE data stream — each section fires as its promise resolves
  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const sections: Array<[string, () => Promise<any>]> = [
        ['calendar', () => fetchCalendar(customers)],
        ['email',    () => fetchEmail(customers)],
        ['cases',    fetchCases],
        ['drive',    () => fetchDrive(customers)],
      ]

      await Promise.all(
        sections.map(async ([name, fetcher]) => {
          try {
            const data = await fetcher()
            await stream.writeSSE({
              event: 'section',
              data: JSON.stringify({ section: name, data }),
            })
          } catch (err: any) {
            await stream.writeSSE({
              event: 'section',
              data: JSON.stringify({ section: name, error: sanitizeErr(err) }),
            })
          }
        })
      )

      await stream.writeSSE({
        event: 'complete',
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      })
    })
  })

  app.get('/api/ingest/events', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      })

      const handler = async (event: IngestCacheEvent) => {
        try {
          await stream.writeSSE({ event: 'cache-level', data: JSON.stringify(event) })
        } catch {
          // write failed — client gone; remove listener so it doesn't accumulate
          offCacheLevel(handler)
        }
      }

      onCacheLevel(handler)

      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => {
          offCacheLevel(handler)
          resolve()
        }, { once: true })
      })
    })
  })

  // BKL-AI-FP-04: AI intelligence pipeline events SSE stream
  // Mirrors /api/ingest/events pattern — long-lived SSE stream for cache/generation lifecycle events.
  app.get('/api/ai/events', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      })

      const handler = async (event: AIIntelEvent) => {
        try {
          await stream.writeSSE({ event: 'ai-intel', data: JSON.stringify(event) })
        } catch {
          // write failed — client gone; remove listener so it doesn't accumulate
          offAIEvent(handler)
        }
      }

      onAIEvent(handler)

      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => {
          offAIEvent(handler)
          resolve()
        }, { once: true })
      })
    })
  })

  return app
}
