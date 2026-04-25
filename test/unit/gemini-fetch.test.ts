/**
 * BKL-TEST-P0-04c — Unit tests for the shared fetchGeminiWithRetry helper.
 *
 * The helper consolidates the 429-retry logic previously duplicated across
 * callGeminiGrounded, callLLM, callLLMStructured, and callGeminiStructured.
 * These tests cover the contract directly against the helper (without the
 * existing wrapper functions) so regressions in retry/backoff/error-shape
 * behaviour fail loudly at unit level — complementing the end-to-end style
 * tests in vertex-429.test.ts that exercise each wrapper.
 *
 * Contract verified:
 *   1. Successful fetch (first attempt OK) returns the Response.
 *   2. 429 triggers exponential-backoff retry with setTimeout firing per attempt.
 *   3. Four consecutive 429s throw "Gemini 429 after 4 retries — rate limited".
 *   4. Non-429 error during retry throws with Bearer redaction and canonical prefix.
 */

import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test'

import { fetchGeminiWithRetry, parseRetryAfterMs } from '../../src/gemini-fetch.ts'

// Minimal context reused across tests.
const CTX = {
  callType:     'test-call',
  customerName: 'TestCustomer',
  model:        'gemini-2.5-flash-lite',
  project:      'test-project',
  location:     'us-central1',
} as const

function build429(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 429, message: 'Resource exhausted. Please try again later.', status: 'RESOURCE_EXHAUSTED' },
    }),
    { status: 429, statusText: 'Too Many Requests', headers: { 'Content-Type': 'application/json' } },
  )
}

function buildOk(payload: object = { ok: true }): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchGeminiWithRetry — BKL-TEST-P0-04c', () => {
  let fetchSpy: ReturnType<typeof spyOn>
  let setTimeoutSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    // Immediate-invoke setTimeout: drain the 4 exponential-backoff sleeps
    // (2s/4s/8s/16s + jitter ≈ 30s real wall time) inside a single tick.
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      // @ts-expect-error — test double, only (cb, delay) shape needed
      (cb: () => void, _delay: number) => {
        cb()
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
    )
  })

  afterEach(() => {
    fetchSpy?.mockRestore()
    setTimeoutSpy.mockRestore()
  })

  // ── Test 1: Happy path ─────────────────────────────────────────────────────
  test('successful fetch returns the response on first attempt', async () => {
    const expected = buildOk({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] })
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => expected)

    const getToken = async () => 'fake-token-1'
    const res = await fetchGeminiWithRetry(
      'https://vertex.example/test',
      getToken,
      JSON.stringify({ contents: [] }),
      CTX,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.candidates[0].content.parts[0].text).toBe('hello')

    // Exactly one fetch — no retry loop on success.
    expect(fetchSpy.mock.calls.length).toBe(1)
    // Never slept.
    expect(setTimeoutSpy.mock.calls.length).toBe(0)
  })

  // ── Test 2: 429 → retry → success ──────────────────────────────────────────
  test('429 triggers retry with exponential backoff, then returns success response', async () => {
    // Sequence: 429, 429, 200. Verifies retry loop runs and caller gets the
    // success Response (not an error).
    const responses = [build429(), build429(), buildOk({ candidates: [{ content: { parts: [{ text: 'recovered' }] } }] })]
    let callIdx = 0
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callIdx++])

    const tokens: string[] = []
    const getToken = async () => {
      const t = `token-${tokens.length}`
      tokens.push(t)
      return t
    }

    const res = await fetchGeminiWithRetry(
      'https://vertex.example/test',
      getToken,
      JSON.stringify({ contents: [] }),
      CTX,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.candidates[0].content.parts[0].text).toBe('recovered')

    // 1 initial + 2 retries = 3 fetch calls total.
    expect(fetchSpy.mock.calls.length).toBe(3)
    // setTimeout called once per retry attempt (2 retries).
    expect(setTimeoutSpy.mock.calls.length).toBe(2)

    // Token re-acquired per retry — 1 initial + 2 retries = 3 token fetches.
    expect(tokens.length).toBe(3)

    // Backoff math: attempt 1 delay ∈ [2000, 3000), attempt 2 ∈ [4000, 5000).
    const delay1 = setTimeoutSpy.mock.calls[0][1] as number
    const delay2 = setTimeoutSpy.mock.calls[1][1] as number
    expect(delay1).toBeGreaterThanOrEqual(2000)
    expect(delay1).toBeLessThan(3000)
    expect(delay2).toBeGreaterThanOrEqual(4000)
    expect(delay2).toBeLessThan(5000)
  })

  // ── Test 3: 4 retries exhausted ────────────────────────────────────────────
  test('four consecutive 429s after initial throw "Gemini 429 after 4 retries — rate limited"', async () => {
    // Initial + 4 retries = 5 calls, all 429.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => build429())

    const getToken = async () => 'fake-token'

    let captured: unknown = null
    try {
      await fetchGeminiWithRetry(
        'https://vertex.example/test',
        getToken,
        JSON.stringify({ contents: [] }),
        CTX,
      )
      expect.unreachable('fetchGeminiWithRetry returned on repeated 429 instead of throwing')
    } catch (e) {
      captured = e
    }

    expect(captured).toBeInstanceOf(Error)
    const msg = (captured as Error).message
    // Exact error message from the helper on exhaustion.
    expect(msg).toBe('Gemini 429 after 4 retries — rate limited')

    // 5 total fetch calls (1 initial + 4 retries).
    expect(fetchSpy.mock.calls.length).toBe(5)
    // 4 backoff sleeps.
    expect(setTimeoutSpy.mock.calls.length).toBe(4)

    // Exponential backoff progression: 2s, 4s, 8s, 16s base.
    const delays = setTimeoutSpy.mock.calls.map(c => c[1] as number)
    expect(delays[0]).toBeGreaterThanOrEqual(2000)
    expect(delays[0]).toBeLessThan(3000)
    expect(delays[1]).toBeGreaterThanOrEqual(4000)
    expect(delays[1]).toBeLessThan(5000)
    expect(delays[2]).toBeGreaterThanOrEqual(8000)
    expect(delays[2]).toBeLessThan(9000)
    expect(delays[3]).toBeGreaterThanOrEqual(16000)
    expect(delays[3]).toBeLessThan(17000)
  })

  // ── Test 4: Non-429 error during retry throws with Bearer redaction ────────
  test('non-429 error during retry throws with Bearer redaction and canonical prefix', async () => {
    // Initial 429 → retry returns 500 with a body that contains a Bearer token.
    // Helper must throw the canonical "Gemini API error NNN (project=..., ...)"
    // message, redact the Bearer, and cap the body slice at 300 chars.
    const leakyBody = 'Upstream returned: Authorization: Bearer sk-super-secret-token-should-not-leak; retry with different key'
    const errorRes = new Response(leakyBody, { status: 500, statusText: 'Internal Server Error' })

    const responses = [build429(), errorRes]
    let callIdx = 0
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callIdx++])

    const getToken = async () => 'fake-token'

    let captured: unknown = null
    try {
      await fetchGeminiWithRetry(
        'https://vertex.example/test',
        getToken,
        JSON.stringify({ contents: [] }),
        CTX,
      )
      expect.unreachable('fetchGeminiWithRetry returned on 500 instead of throwing')
    } catch (e) {
      captured = e
    }

    expect(captured).toBeInstanceOf(Error)
    const msg = (captured as Error).message

    // Canonical prefix includes status + project/location/model detail.
    expect(msg).toContain('Gemini API error 500')
    expect(msg).toContain('project=test-project')
    expect(msg).toContain('location=us-central1')
    expect(msg).toContain('model=gemini-2.5-flash-lite')

    // Critical: Bearer token must be redacted — no raw secret in the error.
    expect(msg).not.toContain('sk-super-secret-token-should-not-leak')
    expect(msg).toContain('Bearer [redacted]')

    // Anti-thin-doc: error is not the raw JSON body.
    expect(msg.startsWith('{')).toBe(false)
    expect(msg.startsWith('Gemini')).toBe(true)

    // Exactly 2 fetches (initial 429 + one retry that got 500).
    expect(fetchSpy.mock.calls.length).toBe(2)
  })

  // ── Test 5: Non-429 initial failure (bonus — spec says helper must throw
  //              canonical error on non-429 too, not only during retry) ────────
  test('non-429 initial failure throws canonical Gemini API error with redaction', async () => {
    const leaky = 'token=Bearer abc123xyz should be scrubbed'
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(leaky, { status: 403, statusText: 'Forbidden' }),
    )

    const getToken = async () => 'fake-token'

    let msg = ''
    try {
      await fetchGeminiWithRetry(
        'https://vertex.example/test',
        getToken,
        JSON.stringify({ contents: [] }),
        CTX,
      )
    } catch (e: any) { msg = e?.message ?? '' }

    expect(msg).toContain('Gemini API error 403')
    expect(msg).not.toContain('abc123xyz')
    expect(msg).toContain('Bearer [redacted]')
    // No retry loop runs for non-429 initial failure.
    expect(fetchSpy.mock.calls.length).toBe(1)
    expect(setTimeoutSpy.mock.calls.length).toBe(0)
  })
})

// ── Retry-After parsing ──────────────────────────────────────────────────────
// Council audit: 429 retries should honor the server's `Retry-After` response
// header when present (integer seconds), falling back to exponential backoff
// otherwise. These tests cover the helper in isolation plus the retry loop's
// use of it.

describe('parseRetryAfterMs — pure parser', () => {
  test('absent header returns null', () => {
    const h = new Headers()
    expect(parseRetryAfterMs(h)).toBeNull()
  })

  test('integer seconds header returns milliseconds', () => {
    const h = new Headers({ 'Retry-After': '30' })
    expect(parseRetryAfterMs(h)).toBe(30_000)
  })

  test('zero seconds is valid and returns 0', () => {
    const h = new Headers({ 'Retry-After': '0' })
    expect(parseRetryAfterMs(h)).toBe(0)
  })

  test('leading/trailing whitespace is tolerated', () => {
    const h = new Headers({ 'Retry-After': '  42  ' })
    expect(parseRetryAfterMs(h)).toBe(42_000)
  })

  test('HTTP-date form is not supported — returns null', () => {
    // Vertex/Gemini emit integer seconds when they send the header at all.
    // HTTP-date is valid per RFC 7231 but out of scope for this helper.
    const h = new Headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' })
    expect(parseRetryAfterMs(h)).toBeNull()
  })

  test('non-numeric garbage returns null', () => {
    const h = new Headers({ 'Retry-After': 'soon' })
    expect(parseRetryAfterMs(h)).toBeNull()
  })

  test('negative value returns null', () => {
    // `^\d+$` rejects the leading "-", so this is caught by the regex gate.
    const h = new Headers({ 'Retry-After': '-10' })
    expect(parseRetryAfterMs(h)).toBeNull()
  })

  test('fractional seconds return null — server violated the spec', () => {
    const h = new Headers({ 'Retry-After': '1.5' })
    expect(parseRetryAfterMs(h)).toBeNull()
  })
})

describe('fetchGeminiWithRetry — Retry-After header honored', () => {
  let fetchSpy: ReturnType<typeof spyOn>
  let setTimeoutSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      // @ts-expect-error — test double, only (cb, delay) shape needed
      (cb: () => void, _delay: number) => { cb(); return 0 as unknown as ReturnType<typeof setTimeout> },
    )
  })

  afterEach(() => {
    fetchSpy?.mockRestore()
    setTimeoutSpy.mockRestore()
  })

  test('429 with Retry-After: 7 uses 7000ms base instead of exponential 2000ms', async () => {
    const with429RetryAfter = new Response(
      JSON.stringify({ error: { code: 429 } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } },
    )
    const ok = new Response(JSON.stringify({ ok: true }), { status: 200 })

    const responses = [with429RetryAfter, ok]
    let callIdx = 0
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callIdx++])

    const getToken = async () => 'fake-token'
    const res = await fetchGeminiWithRetry(
      'https://vertex.example/test',
      getToken,
      JSON.stringify({ contents: [] }),
      CTX,
    )

    expect(res.status).toBe(200)
    // Exactly one retry — initial 429 + retry success = 2 fetches, 1 sleep.
    expect(fetchSpy.mock.calls.length).toBe(2)
    expect(setTimeoutSpy.mock.calls.length).toBe(1)

    // Retry-After=7s should put delay in [7000, 8000) (7000 base + 0..1000 jitter),
    // NOT in the exponential [2000, 3000) band that attempt=1 would otherwise use.
    const delay = setTimeoutSpy.mock.calls[0][1] as number
    expect(delay).toBeGreaterThanOrEqual(7000)
    expect(delay).toBeLessThan(8000)
  })

  test('missing Retry-After falls back to exponential backoff', async () => {
    // Regression guard: the new header-parsing code path must not regress the
    // original exponential schedule when the server omits Retry-After.
    const plain429 = new Response(
      JSON.stringify({ error: { code: 429 } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )
    const ok = new Response(JSON.stringify({ ok: true }), { status: 200 })

    const responses = [plain429, ok]
    let callIdx = 0
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callIdx++])

    const getToken = async () => 'fake-token'
    await fetchGeminiWithRetry(
      'https://vertex.example/test',
      getToken,
      JSON.stringify({ contents: [] }),
      CTX,
    )

    const delay = setTimeoutSpy.mock.calls[0][1] as number
    // attempt=1: base 2s + 0..1000ms jitter.
    expect(delay).toBeGreaterThanOrEqual(2000)
    expect(delay).toBeLessThan(3000)
  })

  test('Retry-After is re-parsed per 429 — second 429 with different value updates delay', async () => {
    // Server can shorten/lengthen the hint across attempts; the loop must pick
    // up the most recent value on each iteration rather than latch the first.
    const first429 = new Response(
      JSON.stringify({ error: { code: 429 } }),
      { status: 429, headers: { 'Retry-After': '3' } },
    )
    const second429 = new Response(
      JSON.stringify({ error: { code: 429 } }),
      { status: 429, headers: { 'Retry-After': '11' } },
    )
    const ok = new Response(JSON.stringify({ ok: true }), { status: 200 })

    const responses = [first429, second429, ok]
    let callIdx = 0
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callIdx++])

    const getToken = async () => 'fake-token'
    await fetchGeminiWithRetry(
      'https://vertex.example/test',
      getToken,
      JSON.stringify({ contents: [] }),
      CTX,
    )

    expect(setTimeoutSpy.mock.calls.length).toBe(2)
    const delay1 = setTimeoutSpy.mock.calls[0][1] as number
    const delay2 = setTimeoutSpy.mock.calls[1][1] as number

    // First retry honors Retry-After=3 (3000–4000ms window).
    expect(delay1).toBeGreaterThanOrEqual(3000)
    expect(delay1).toBeLessThan(4000)
    // Second retry honors the NEW Retry-After=11 (11000–12000ms), not the
    // exponential attempt=2 value of 4000–5000ms.
    expect(delay2).toBeGreaterThanOrEqual(11_000)
    expect(delay2).toBeLessThan(12_000)
  })

  test('Retry-After disappears mid-loop — falls back to exponential for that attempt', async () => {
    // First 429 sends Retry-After=5. Second 429 omits the header. The loop
    // should use 5000ms base for the first retry and exponential (attempt=2 → 4000ms)
    // for the second retry.
    const first429 = new Response(
      JSON.stringify({ error: { code: 429 } }),
      { status: 429, headers: { 'Retry-After': '5' } },
    )
    const second429 = new Response(
      JSON.stringify({ error: { code: 429 } }),
      { status: 429 }, // no Retry-After
    )
    const ok = new Response(JSON.stringify({ ok: true }), { status: 200 })

    const responses = [first429, second429, ok]
    let callIdx = 0
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callIdx++])

    const getToken = async () => 'fake-token'
    await fetchGeminiWithRetry(
      'https://vertex.example/test',
      getToken,
      JSON.stringify({ contents: [] }),
      CTX,
    )

    const delay1 = setTimeoutSpy.mock.calls[0][1] as number
    const delay2 = setTimeoutSpy.mock.calls[1][1] as number

    // attempt=1 used Retry-After=5 → 5000..6000ms.
    expect(delay1).toBeGreaterThanOrEqual(5000)
    expect(delay1).toBeLessThan(6000)
    // attempt=2 fell back to exponential Math.pow(2,2)*1000 = 4000ms base → 4000..5000ms.
    expect(delay2).toBeGreaterThanOrEqual(4000)
    expect(delay2).toBeLessThan(5000)
  })
})
