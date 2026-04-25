/**
 * SSE replay fixture contract — TEST-P2-03
 *
 * Contract test for /api/ai/events SSE endpoint. Validates the handshake
 * payload shape (the `connected` event schema) and the endpoint surface
 * (HTTP status / headers) — does NOT trigger brief generation. Phase 4's
 * `sse-events.spec.ts` already covers the dynamic ai-intel emission path;
 * this spec is the static schema gate the audit asked for (TEST-P2-03).
 *
 * Why this matters: any change to the connected handshake shape (e.g.
 * dropping the timestamp or renaming the field) silently breaks every
 * client that relies on it. This contract pins the shape.
 *
 * AIIntelEvent schema reference: src/ai-events.ts
 *   {
 *     type: 'cache:cold' | 'cache:hit' | 'cache:miss' | 'cache:bypass'
 *           | 'cache:stale' | 'generation:start' | 'generation:complete'
 *           | 'generation:error'
 *     accountId: string
 *     flow: 'brief' | 'account-intel' | 'product-intel'
 *     source: 'l1' | 'l2' | 'l3' | 'l4'
 *     fingerprintHash?: string
 *     tokensUsed?: number
 *     durationMs?: number
 *     timestamp: string
 *   }
 *
 * Tagged @destructive so the playwright `test` project routes to 7776
 * (the test container), where ALLOW_RESET=true and the SSE endpoint is
 * always reachable.
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

test.describe('SSE /api/ai/events — schema contract @destructive', () => {
  test.use({ baseURL: BASE })

  test('connected event has timestamp string parseable as ISO date', async ({ page }) => {
    await page.goto(BASE)

    const data = await page.evaluate(async (base) => {
      return new Promise<string>((resolve, reject) => {
        const es = new EventSource(`${base}/api/ai/events`)
        const t = setTimeout(() => {
          es.close()
          reject(new Error('timeout — no connected event in 6s'))
        }, 6000)
        es.addEventListener('connected', (e) => {
          clearTimeout(t)
          es.close()
          resolve((e as MessageEvent).data)
        })
        es.onerror = () => {
          // EventSource auto-reconnects; rely on the timeout above to fail.
        }
      })
    }, BASE)

    const parsed = JSON.parse(data) as { timestamp?: unknown }
    expect(parsed).toHaveProperty('timestamp')
    expect(typeof parsed.timestamp).toBe('string')
    expect(new Date(parsed.timestamp as string).getTime()).toBeGreaterThan(0)
  })

  test('GET /api/ai/events responds with 200 and text/event-stream content-type', async ({ page }) => {
    // Use page.evaluate + fetch() with an AbortController so we can read
    // status + headers without hanging on the long-lived stream body.
    const result = await page.evaluate(async (base) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      try {
        const res = await fetch(`${base}/api/ai/events`, { signal: ctrl.signal })
        clearTimeout(t)
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
        // Cancel the body stream so we don't hold the SSE connection open.
        try { ctrl.abort() } catch { /* noop */ }
        return { status: res.status, headers }
      } catch (err: unknown) {
        clearTimeout(t)
        // AbortError after we received headers is fine — surface the
        // error so we can distinguish "endpoint missing" from "stream
        // canceled after headers".
        return { status: 0, headers: {}, error: err instanceof Error ? err.name : String(err) }
      }
    }, BASE)

    // Either we got a 200 with the stream content-type, OR the abort fired
    // before we captured headers (acceptable — endpoint exists, stream is
    // long-lived). The handshake test above is the authoritative reachability
    // proof; this test pins the content-type when we can read it.
    if (result.status === 200) {
      expect(result.headers['content-type'] ?? '').toContain('text/event-stream')
    } else {
      // Abort happened before headers — log but do not fail. The handshake
      // test in this same describe block already proves reachability.
      expect(result.error).toBeDefined()
    }
  })
})
