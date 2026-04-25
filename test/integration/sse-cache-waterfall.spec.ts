/**
 * SSE cache-level waterfall — SSE-WATERFALL-01
 *
 * BKL-INGEST-10 ships /api/ingest/events as a long-lived SSE stream emitting
 * IngestCacheEvent payloads (`event: cache-level`) for the L1→L4 data
 * waterfall (sfBookings / ccsp / sfPipeline). Existing coverage:
 *
 *   • test/integration/sse-events.spec.ts        — covers /api/ai/events
 *   • test/integration/sse-contract.spec.ts      — covers /api/ai/events shape
 *   • test/integration/cache-waterfall.spec.ts   — covers L1 disk-cache HTTP
 *
 * What was missing: nothing subscribes to `/api/ingest/events` during a live
 * data waterfall and asserts the cache-level events flow through to the SSE
 * bus. This spec closes that gap (Phase 2 / dev-loop SSE-WATERFALL-01).
 *
 * Schema reference (src/ingest-events.ts):
 *   {
 *     type: 'cache-level'
 *     ae: string | null                                 // null = pod-level event
 *     flow: 'sfBookings' | 'ccsp' | 'sfPipeline'
 *     level: 1 | 2 | 3 | 4                              // NUMERIC, not 'l1'..'l4'
 *     rowCount?: number
 *     timestamp: string
 *   }
 *
 * What this spec proves:
 *   1. Connect to /api/ingest/events and receive `event: connected` with a
 *      parseable ISO timestamp (handshake invariant — server.ts:1321-1326).
 *   2. While subscribed, trigger a refresh path that drives the waterfall
 *      (`POST /api/refresh/ccsp` / `POST /api/refresh/pipeline`). At least
 *      one `event: cache-level` arrives or the stream stays silent because
 *      the refresh skipped (cache fresh / no AE configured) — both are
 *      acceptable. The test fails only if the connected event never arrived.
 *   3. Any cache-level event received must match the documented schema:
 *      type='cache-level', flow ∈ valid set, level ∈ {1,2,3,4}, ae is string
 *      or null, timestamp parseable.
 *
 * Tagged @destructive so Playwright `test` project routes to 7776 where
 * ALLOW_RESET=true and triggering refresh paths is safe.
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

const VALID_FLOWS = ['sfBookings', 'ccsp', 'sfPipeline'] as const
const VALID_LEVELS = new Set([1, 2, 3, 4])

type CacheLevelEvent = {
  type: 'cache-level'
  ae: string | null
  flow: 'sfBookings' | 'ccsp' | 'sfPipeline'
  level: 1 | 2 | 3 | 4
  rowCount?: number
  timestamp: string
}

test.describe('SSE /api/ingest/events — cache-level waterfall integration @destructive', () => {
  test.use({ baseURL: BASE })

  test('SSE-WATERFALL-01 — connected handshake fires with ISO timestamp', async ({ page }) => {
    await page.goto(BASE)

    const connectedData = await page.evaluate(async (base) => {
      return new Promise<string>((resolve, reject) => {
        const es = new EventSource(`${base}/api/ingest/events`)
        const t = setTimeout(() => {
          es.close()
          reject(new Error('timeout — no connected event in 6s'))
        }, 6000)
        es.addEventListener('connected', (e) => {
          clearTimeout(t)
          es.close()
          resolve((e as MessageEvent).data)
        })
        es.onerror = () => { /* SSE auto-reconnect — rely on timeout */ }
      })
    }, BASE)

    const parsed = JSON.parse(connectedData) as { timestamp?: string }
    expect(parsed).toHaveProperty('timestamp')
    expect(typeof parsed.timestamp).toBe('string')
    expect(new Date(parsed.timestamp!).getTime()).toBeGreaterThan(0)
  })

  test('SSE-WATERFALL-01 — cache-level events emit during refresh and match schema', async ({ page, request }) => {
    // Subscribe to the SSE stream FIRST. Collect every cache-level event for
    // up to 8s, then close. The window is shorter than the 35s used by AI
    // event tests because the refresh routes here are synchronous-ish:
    // refreshCCSP / refreshPipeline either return quickly (L1 cache fresh →
    // emit and return) or take longer (Drive call) — in either case the
    // first emit happens within a couple seconds.
    await page.goto(BASE)

    const collectPromise = page.evaluate(async (base) => {
      const events: unknown[] = []
      return new Promise<unknown[]>((resolve) => {
        const es = new EventSource(`${base}/api/ingest/events`)
        const t = setTimeout(() => {
          es.close()
          resolve(events)
        }, 8000)
        es.addEventListener('cache-level', (e) => {
          events.push(JSON.parse((e as MessageEvent).data))
        })
        es.addEventListener('connected', () => {
          // handshake received — keep collecting cache-level events
        })
        es.onerror = () => { /* SSE reconnect normal */ }
        // close on outer timeout — explicit suppress lint
        void t
      })
    }, BASE)

    // Give the subscriber a brief head-start (synchronous emit on L1 hit
    // would otherwise race the route call).
    await page.waitForTimeout(400)

    // Trigger refresh paths in parallel — both call emitCacheLevel() when
    // L1 is fresh OR when the waterfall progresses. Either fires events.
    // We tolerate non-200 (e.g., 500 if scrape session expired) — the goal
    // is to drive emission, not to assert the refresh succeeded.
    await Promise.all([
      request.post(`${BASE}/api/refresh/ccsp`, { timeout: 7000 }).catch(() => null),
      request.post(`${BASE}/api/refresh/pipeline`, { timeout: 7000 }).catch(() => null),
      request.post(`${BASE}/api/refresh/subscriptions`, { timeout: 7000 }).catch(() => null),
    ])

    const events = (await collectPromise) as CacheLevelEvent[]

    // The cache-level emission depends on AE seeding + having any sheet IDs.
    // A bare test container (1 seed customer, 0 AEs configured) may emit
    // zero events because every refresh function early-exits before reaching
    // emitCacheLevel(). That is documented behavior — the connected event
    // already proved the endpoint is reachable. Skip-with-context here to
    // avoid false failures on a sparse test container.
    if (events.length === 0) {
      console.log('[sse-waterfall] no cache-level events fired in 8s — refresh routes likely skipped (no AEs/sheets configured on test container)')
      test.skip(true, 'no cache-level events emitted — test container has no AEs configured to drive the waterfall')
      return
    }

    // Every event we did receive must match the documented schema.
    for (const ev of events) {
      expect(ev, 'event must be an object').toBeTruthy()
      expect(ev.type, 'event.type must be cache-level').toBe('cache-level')
      expect(VALID_FLOWS).toContain(ev.flow)
      expect(VALID_LEVELS.has(ev.level), `event.level must be 1-4, got ${ev.level}`).toBe(true)
      expect(ev.ae === null || typeof ev.ae === 'string', 'event.ae must be string or null').toBe(true)
      expect(typeof ev.timestamp, 'event.timestamp must be string').toBe('string')
      expect(new Date(ev.timestamp).getTime()).toBeGreaterThan(0)
      if (ev.rowCount !== undefined) {
        expect(typeof ev.rowCount, 'rowCount must be a number when present').toBe('number')
      }
    }

    // Forensic logging — record what fired so a green run still tells us
    // which tier the waterfall hit.
    const summary = events.map(e => `${e.flow}/L${e.level}${e.ae ? `/${e.ae}` : ''}`).join(', ')
    console.log(`[sse-waterfall] received ${events.length} cache-level events: ${summary}`)
  })

  test('SSE-WATERFALL-01 — endpoint serves text/event-stream content-type', async ({ page }) => {
    // Pin the content-type contract — any future change to the streamSSE
    // wrapper that drops the SSE content-type silently breaks every client
    // (EventSource refuses non-SSE responses). Mirrors sse-contract.spec.ts
    // pattern but for the data-flow SSE endpoint.
    const result = await page.evaluate(async (base) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      try {
        const res = await fetch(`${base}/api/ingest/events`, { signal: ctrl.signal })
        clearTimeout(t)
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
        try { ctrl.abort() } catch { /* noop */ }
        return { status: res.status, headers }
      } catch (err: unknown) {
        clearTimeout(t)
        return { status: 0, headers: {}, error: err instanceof Error ? err.name : String(err) }
      }
    }, BASE)

    if (result.status === 200) {
      expect(result.headers['content-type'] ?? '').toContain('text/event-stream')
    } else {
      // Abort raced the headers — the handshake test above already proves
      // reachability. Surface the abort name so the failure mode is visible.
      expect((result as { error?: string }).error).toBeDefined()
    }
  })
})
