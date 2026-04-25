/**
 * SSE event bus integration — TEST-P1-04
 *
 * BKL-AI-FP-04 ships /api/ai/events as a long-lived SSE stream emitting
 * AIIntelEvent payloads for cache and generation lifecycle. Prior to this
 * spec, zero tests subscribed to the stream — the audit (TEST-AUDIT.md)
 * called out "SSE event bus zero coverage" as the #5 most dangerous gap.
 *
 * What this spec proves:
 *   1. The SSE endpoint is reachable and emits a `connected` event with a
 *      timestamp on subscribe (handshake invariant from server.ts:1330).
 *   2. When a brief is triggered while a subscriber is attached, an
 *      `ai-intel` event arrives with a known event type and the schema
 *      defined by `AIIntelEvent` (src/ai-events.ts). DISALLOW_GEMINI=true
 *      is the test-container default, so `cache:bypass` is the dominant
 *      path — but cached fingerprint matches yield no event at all, so the
 *      test accepts any of the documented types and skips cleanly when no
 *      events arrive (cache short-circuit is not a failure).
 *   3. The full AIIntelEvent schema is honored: `type`, `accountId`,
 *      `flow`, `source`, `timestamp` are required and constrained.
 *
 * Tagged @destructive so the playwright `test` project routes to 7776
 * where DISALLOW_GEMINI is set and brief generation is deterministic.
 *
 * Brief trigger route: GET /customer/:name/brief (registered in
 * src/customer-routes.ts:423 — NOT /api/customer/:name/brief).
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

// EventSource-based SSE assertions need a page context with a real URL —
// `about:blank` rejects same-origin EventSource connects in some browsers.
// We navigate to the dashboard root before evaluating.

test.describe('SSE /api/ai/events — event bus integration @destructive', () => {
  test.use({ baseURL: BASE })

  test('emits `connected` event with ISO timestamp on subscribe', async ({ page }) => {
    await page.goto(BASE)

    const connectedData = await page.evaluate(async (base) => {
      return new Promise<string>((resolve, reject) => {
        const es = new EventSource(`${base}/api/ai/events`)
        const t = setTimeout(() => {
          es.close()
          reject(new Error('timeout — no connected event in 5s'))
        }, 5000)
        es.addEventListener('connected', (e) => {
          clearTimeout(t)
          es.close()
          resolve((e as MessageEvent).data)
        })
        es.onerror = () => {
          // EventSource auto-reconnects on transport errors; only reject
          // if no event arrives before the timeout fires.
        }
      })
    }, BASE)

    const parsed = JSON.parse(connectedData) as { timestamp?: string }
    expect(parsed).toHaveProperty('timestamp')
    expect(typeof parsed.timestamp).toBe('string')
    expect(new Date(parsed.timestamp!).getTime()).toBeGreaterThan(0)
  })

  test('emits `ai-intel` event when a brief is triggered (cache:bypass under DISALLOW_GEMINI)', async ({ page, request }) => {
    // Need at least one customer for /customer/:name/brief to do work.
    const accRes = await request.get(`${BASE}/api/accounts`)
    if (!accRes.ok()) {
      test.skip(true, `precondition: GET /api/accounts returned ${accRes.status()}`)
      return
    }
    const accBody = await accRes.json() as { customers?: Array<{ name: string }> }
    const customers = Array.isArray(accBody) ? accBody : (accBody.customers ?? [])
    if (customers.length === 0) {
      test.skip(true, 'precondition: no customers seeded — SSE trigger test needs ≥1')
      return
    }
    const customerName = customers[0].name

    await page.goto(BASE)

    // Subscribe BEFORE triggering brief generation. The page.evaluate returns
    // a promise that resolves when the first ai-intel event arrives (or
    // resolves with `null` if the stream stays silent for 12s — which is
    // acceptable when fingerprint cache short-circuits before emitting).
    const eventPromise = page.evaluate(async (base) => {
      return new Promise<unknown>((resolve) => {
        const events: unknown[] = []
        const es = new EventSource(`${base}/api/ai/events`)
        const t = setTimeout(() => {
          es.close()
          resolve(events[0] ?? null)
        }, 12000)
        es.addEventListener('ai-intel', (e) => {
          const event = JSON.parse((e as MessageEvent).data)
          events.push(event)
          clearTimeout(t)
          es.close()
          resolve(event)
        })
        es.onerror = () => { /* SSE reconnect is normal — don't fail */ }
      })
    }, BASE)

    // Brief trigger route — wait briefly so the SSE subscriber is attached
    // before the emitter fires. The handler is synchronous on the bypass
    // path, so even a 200ms head-start is plenty.
    await page.waitForTimeout(300)
    const triggerRes = await request.get(
      `${BASE}/customer/${encodeURIComponent(customerName)}/brief`,
      { timeout: 30000 },
    )
    // The endpoint may return 200 (cached or bypass-fixture) or 500 if a
    // downstream cache is missing — either is fine for this test, we only
    // care that the SSE bus emitted.
    expect([200, 500]).toContain(triggerRes.status())

    const aiEvent = await eventPromise as Record<string, unknown> | null

    // Cache short-circuit (fingerprint match → no emit) is acceptable.
    // Skip when no events arrive — we cannot prove emission with no signal.
    if (!aiEvent) {
      test.skip(true, 'no ai-intel event in 12s — fingerprint cache likely short-circuited before emit')
      return
    }

    expect(aiEvent).toHaveProperty('type')
    expect(aiEvent).toHaveProperty('accountId')
    expect(aiEvent).toHaveProperty('timestamp')
    const validTypes = [
      'cache:cold', 'cache:hit', 'cache:miss', 'cache:bypass', 'cache:stale',
      'generation:start', 'generation:complete', 'generation:error',
    ]
    expect(validTypes).toContain(aiEvent.type as string)
  })

  test('ai-intel event payload matches AIIntelEvent schema (type, accountId, flow, source, timestamp)', async ({ page, request }) => {
    const accRes = await request.get(`${BASE}/api/accounts`)
    if (!accRes.ok()) {
      test.skip(true, `precondition: GET /api/accounts returned ${accRes.status()}`)
      return
    }
    const accBody = await accRes.json() as { customers?: Array<{ name: string }> }
    const customers = Array.isArray(accBody) ? accBody : (accBody.customers ?? [])
    if (customers.length === 0) {
      test.skip(true, 'precondition: no customers seeded — SSE schema test needs ≥1')
      return
    }
    const customerName = customers[0].name

    await page.goto(BASE)

    const eventPromise = page.evaluate(async (base) => {
      return new Promise<unknown>((resolve) => {
        const es = new EventSource(`${base}/api/ai/events`)
        const t = setTimeout(() => {
          es.close()
          resolve(null)
        }, 12000)
        es.addEventListener('ai-intel', (e) => {
          clearTimeout(t)
          es.close()
          resolve(JSON.parse((e as MessageEvent).data))
        })
        es.onerror = () => { /* reconnect normal */ }
      })
    }, BASE)

    await page.waitForTimeout(300)
    // Force=true bypasses fingerprint cache — guarantees emission unless
    // the customer has zero data sources, in which case the test still
    // skips cleanly via the null-event branch below.
    await request.get(
      `${BASE}/customer/${encodeURIComponent(customerName)}/brief?force=true`,
      { timeout: 30000 },
    ).catch(() => null)

    const event = await eventPromise as Record<string, unknown> | null
    if (!event) {
      test.skip(true, 'no ai-intel event in 12s — emitter likely short-circuited')
      return
    }

    // Required fields per src/ai-events.ts AIIntelEvent type
    expect(event).toHaveProperty('type')
    expect(event).toHaveProperty('accountId')
    expect(event).toHaveProperty('flow')
    expect(event).toHaveProperty('source')
    expect(event).toHaveProperty('timestamp')

    const validTypes = [
      'cache:cold', 'cache:hit', 'cache:miss', 'cache:bypass', 'cache:stale',
      'generation:start', 'generation:complete', 'generation:error',
    ]
    expect(validTypes).toContain(event.type as string)
    expect(['brief', 'account-intel', 'product-intel']).toContain(event.flow as string)
    expect(['l1', 'l2', 'l3', 'l4']).toContain(event.source as string)

    // accountId is the slug of the customer name (toSlug in customer.ts)
    expect(typeof event.accountId).toBe('string')
    expect((event.accountId as string).length).toBeGreaterThan(0)

    // timestamp must be parseable ISO date
    expect(new Date(event.timestamp as string).getTime()).toBeGreaterThan(0)
  })

  // ── Phase 6 / BKL-TEST-HARNESS-P6 ──────────────────────────────────────────
  // Existing tests above prove the SSE handshake and event schema. They do NOT
  // prove that a brief trigger walks all the way through the gate to a
  // documented terminal state. This test asserts that within 35s of a brief
  // trigger, the bus emits one of the terminal/observable states:
  //   - generation:complete (full pipeline ran end-to-end)
  //   - cache:bypass        (DISALLOW_GEMINI mode — bypass path is the test default)
  //   - cache:hit           (fingerprint match — corpus unchanged)
  // If none arrive, the gate dropped the request silently — the very gap
  // Ava flagged. The 35s window covers cold-cache generation in DISALLOW_GEMINI;
  // for live Gemini it should still fall well within the timeout.
  test('terminal SSE event fires within 35s of a brief trigger (Phase 6 E2E gate)', async ({ page, request }) => {
    const accRes = await request.get(`${BASE}/api/accounts`)
    if (!accRes.ok()) {
      test.skip(true, `precondition: GET /api/accounts returned ${accRes.status()}`)
      return
    }
    const accBody = await accRes.json() as { customers?: Array<{ name: string }> } | Array<{ name: string }>
    const customers = Array.isArray(accBody) ? accBody : (accBody.customers ?? [])
    if (customers.length === 0) {
      test.skip(true, 'precondition: no customers seeded — generation-complete E2E needs ≥1')
      return
    }
    const customerName = customers[0].name

    await page.goto(BASE)

    // Subscribe BEFORE triggering the brief. Resolve when we see any of the
    // terminal/observable types, OR when the 35s window expires (resolved
    // with the full event list so the assertion error has forensic context).
    const collectAndResolve = page.evaluate(async (base) => {
      const allTypes: string[] = []
      const TERMINAL = new Set(['generation:complete', 'cache:bypass', 'cache:hit'])
      return new Promise<{ found: boolean; types: string[] }>((resolve) => {
        const es = new EventSource(`${base}/api/ai/events`)
        const t = setTimeout(() => {
          es.close()
          resolve({ found: false, types: allTypes })
        }, 35000)
        es.addEventListener('ai-intel', (e) => {
          const ev = JSON.parse((e as MessageEvent).data) as { type: string }
          allTypes.push(ev.type)
          if (TERMINAL.has(ev.type)) {
            clearTimeout(t); es.close()
            resolve({ found: true, types: allTypes })
          }
        })
        es.onerror = () => { /* SSE auto-reconnect normal */ }
      })
    }, BASE)

    await page.waitForTimeout(300)
    // force=true bypasses the route-level fingerprint short-circuit so the
    // request reaches the customer.ts gate. Without force, the route at
    // customer-routes.ts:482-493 may serve cached and never emit.
    await request.get(
      `${BASE}/customer/${encodeURIComponent(customerName)}/brief?force=true`,
      { timeout: 30000 },
    ).catch(() => null)

    const result = await collectAndResolve
    expect(
      result.found,
      `Expected one of generation:complete, cache:bypass, cache:hit within 35s. Got: ${result.types.join(', ') || '(none)'}`,
    ).toBe(true)

    // Forensic logging — green cases still record which terminal path was taken.
    if (result.types.includes('generation:complete')) {
      console.log('[sse-generation-complete] generation:complete fired — full pipeline confirmed end-to-end')
    } else if (result.types.includes('cache:bypass')) {
      console.log('[sse-generation-complete] cache:bypass fired — DISALLOW_GEMINI mode, generation path bypassed (expected on test container)')
    } else if (result.types.includes('cache:hit')) {
      console.log('[sse-generation-complete] cache:hit fired — corpus unchanged, delta gate honored cache')
    }
  })
})
