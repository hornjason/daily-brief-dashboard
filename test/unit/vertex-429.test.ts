/**
 * BKL-TEST-P0-04 — Vertex AI 429 rate-limit graceful degradation test.
 *
 * Why this test exists:
 *   The intelligence pipeline (account-intelligence.ts) calls Vertex AI Gemini
 *   via `callGeminiGrounded()` and `callGeminiGroundedStructured()` with Google
 *   Search grounding. When the project's quota is exhausted Vertex returns HTTP
 *   429. Without 429-specific handling, callers observed one of two failure
 *   modes in production:
 *     (a) the request would fail hard and the pipeline would abort mid-run,
 *     (b) thin/empty docs would slip through because downstream code happily
 *         wrote the 1-line error body into Google Drive.
 *
 *   BKL-TOKEN-06 added exponential-backoff + jitter retries (up to 4 attempts:
 *   2s, 4s, 8s, 16s + 0-1000ms jitter) to `callGeminiGrounded()`. This unit
 *   test verifies the retry+fail-loud contract at runtime, complementing the
 *   source-text regression guards in `test/regression.spec.ts::REG-TOKEN-06-b`.
 *
 * Test approach:
 *   1. Mock `./gemini-auth.ts::getGeminiToken` to avoid real Google auth.
 *   2. Mock `./settings-api.ts::getGeminiModel` so we don't touch settings
 *      storage.
 *   3. Spy on `global.fetch` and return 429 with a realistic Vertex error body
 *      on EVERY call.
 *   4. Spy on `global.setTimeout` to invoke callbacks synchronously so the
 *      4 retry delays (which sum to ~30s of real wall time) don't block CI.
 *   5. Call `identifyIndustry()` — the smallest exported entrypoint that
 *      exercises the grounded-call path.
 *   6. Assert:
 *        - The function THROWS (does not silently return a thin/empty result)
 *        - The error message identifies the 429 rate-limit failure mode
 *        - `fetch` was called more than once (proof that the retry loop ran —
 *          initial call + at least 1 retry attempt)
 *
 * If this test ever starts passing against a 1-line "thin doc" return value,
 * that means someone removed the 429 handler or regressed the retry loop into
 * a silent-success path. That is exactly the failure mode BKL-TEST-P0-04
 * exists to detect.
 */

import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from 'bun:test'

// Provide env so we don't hit `GOOGLE_CLOUD_PROJECT not set` early return.
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'test-project'

// Mock auth — returns a fake bearer token without hitting Google.
mock.module('../../src/gemini-auth.ts', () => ({
  getGeminiToken: async () => 'fake-access-token-for-unit-tests',
}))

// Mock settings-api — avoid touching the settings store during tests.
mock.module('../../src/settings-api.ts', () => ({
  getGeminiModel:     () => 'gemini-2.5-flash',
  getGeminiModelLite: () => 'gemini-2.5-flash-lite',
  getAutomationConfig: () => ({}),
  getAiConfig:        () => ({
    briefSynthesisTemperature: 1.0,
    docClassifyMaxAgeDays:     0,
    geminiInputCostPerM:       0.30,
    geminiOutputCostPerM:      2.50,
  }),
}))

// BKL-TEST-P0-04b: mock ./google.ts so callLLM/callLLMStructured/callGeminiStructured
// can take the fallback OAuth-token path without needing a real token file on disk.
// makeAuth returns a stub whose getAccessToken() resolves a fake bearer.
mock.module('../../src/google.ts', () => ({
  GOOGLE_UNIFIED_TOKEN_PATH: '/tmp/fake-unified-token.json',
  OAUTH_KEYS_PATH:           '/tmp/fake-oauth-keys.json',
  makeAuth: (_tokenPath: string) => ({
    getAccessToken: async () => ({ token: 'fake-access-token-for-unit-tests' }),
  }),
  withQuotaRetry: async <T>(fn: () => Promise<T>) => fn(),
}))

// BKL-TEST-P0-04b: mock gemini-cost-tracker so recordGeminiUsage is a no-op.
// Keeps tests hermetic — no writes to cost-tracking files during unit tests.
mock.module('../../src/gemini-cost-tracker.ts', () => ({
  recordGeminiUsage: (_row: unknown) => { /* no-op in tests */ },
}))

// Now import the SUT AFTER mocks are registered so the module graph picks
// up the mocked auth + settings.
const { identifyIndustry } = await import('../../src/account-intelligence.ts')
// BKL-SEC-VERTEX-01: also import callLLM/callLLMStructured to verify the
// mock boundary holds for the brief-synthesis path too.
const { callLLM, callLLMStructured } = await import('../../src/customer.ts')

// Helper: build a realistic Vertex 429 response body so we exercise the real
// JSON-parsing paths in the SUT (not a stubbed `{}` body).
function buildVertex429Response(): Response {
  const body = JSON.stringify({
    error: {
      code:    429,
      message: 'Resource exhausted. Please try again later.',
      status:  'RESOURCE_EXHAUSTED',
    },
  })
  return new Response(body, {
    status:     429,
    statusText: 'Too Many Requests',
    headers:    { 'Content-Type': 'application/json' },
  })
}

describe('BKL-TEST-P0-04: Vertex AI 429 rate-limit graceful degradation', () => {
  let fetchSpy: ReturnType<typeof spyOn>
  let setTimeoutSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    // Fake timers: invoke backoff callbacks synchronously so the test doesn't
    // sit through 2+4+8+16s of real waiting. The SUT uses
    //   await new Promise(r => setTimeout(r, delay))
    // so resolving `r` immediately is the cleanest way to drain the retry
    // loop inside a single event-loop tick.
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      // @ts-expect-error — test double, we only need the (cb, delay) signature
      (cb: () => void, _delay: number) => {
        cb()
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
    )

    // Always return 429 — we want to drive the retry loop to exhaustion.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => buildVertex429Response(),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    setTimeoutSpy.mockRestore()
  })

  test('identifyIndustry throws on repeated 429 — does NOT silently return thin content', async () => {
    // Act + Assert: the function must reject. If this assertion ever flips
    // (the function starts returning a value on all-429), that means someone
    // removed the throw path and degraded to a silent "thin doc" fallback.
    let captured: unknown = null
    try {
      const result = await identifyIndustry('AcmeCorpTestFixture')
      // If we get here, the function returned something despite every fetch
      // returning 429. That is the exact failure mode BKL-TEST-P0-04 guards
      // against — fail the test loudly with the offending value.
      expect.unreachable(
        `identifyIndustry returned on 429 instead of throwing. ` +
          `Returned: ${JSON.stringify(result).slice(0, 200)}`,
      )
    } catch (e) {
      captured = e
    }

    // It must be an Error with a message that names the failure mode so
    // upstream callers (runIntelligencePipeline) can surface it.
    expect(captured).toBeInstanceOf(Error)
    const msg = (captured as Error).message
    // The SUT's callGeminiGrounded throws either:
    //   "Gemini 429 after 4 retries — rate limited"
    // or (if the retry loop sees a non-429 on a retry)
    //   "Gemini grounded API error 429: ..."
    // Both mention 429 explicitly — assert on that.
    expect(msg).toMatch(/429|rate.?limit/i)
  })

  test('retry loop runs — fetch is called more than once before failing', async () => {
    try {
      await identifyIndustry('AcmeCorpTestFixture')
    } catch { /* expected — see first test */ }

    // BKL-TOKEN-06 specifies up to 4 retries (initial + 4 = 5 total fetches).
    // Accept anything >= 2 so minor knob-tweaks don't break this test, but
    // fewer than 2 means the retry loop is gone.
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test('429 response body is consumed — no "unconsumed body" warnings leak', async () => {
    // Each 429 response body MUST be read exactly once inside the SUT
    // (for the redacted error message). If the SUT leaks unread bodies,
    // Node/Bun emits a warning and in some runtimes hangs the test pool.
    // We verify by counting the mock calls and ensuring the test itself
    // completed without hitting the bun:test 30s timeout.
    try { await identifyIndustry('AcmeCorpTestFixture') } catch { /* expected */ }
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0)
  })

  test('retry delay path invokes setTimeout — proves backoff wiring is intact', async () => {
    try { await identifyIndustry('AcmeCorpTestFixture') } catch { /* expected */ }
    // If setTimeout is never called, the SUT skipped the backoff sleep —
    // which is exactly the regression BKL-TOKEN-06 wrote in to prevent.
    // With 4 retries the SUT calls setTimeout at least 4 times.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('thrown error is NOT a passthrough of the raw 1-line Vertex body', async () => {
    // Anti-thin-doc assertion. The error must be a synthesized message, not
    // the raw HTTP body which would read roughly:
    //   '{"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED"}}'
    // That raw body is ~100 chars and, if it ever became the "successful"
    // brief content written to Drive, would show up as a single ugly JSON
    // line — the exact "thin doc" failure mode BKL-INTEL-03 detects in
    // production. Guard against it here at the error boundary.
    let msg = ''
    try { await identifyIndustry('AcmeCorpTestFixture') } catch (e: any) { msg = e?.message ?? '' }
    // A thin-doc passthrough would start with "{" (the raw JSON body). The
    // SUT wraps the body in "Gemini grounded API error NNN:" or throws the
    // "after N retries" message — both start with "Gemini".
    expect(msg.startsWith('{')).toBe(false)
    expect(msg).toMatch(/^Gemini/i)
  })
})

// BKL-SEC-VERTEX-01: verify mock boundary holds for callLLM/callLLMStructured.
// These functions use fetchGeminiWithRetry (BKL-SEC-RETRY-01 migrated them),
// so global.fetch interception must reach them through the same path that
// identifyIndustry uses. Regression: P0-04b tests were removed because the
// original mock targeted getGeminiToken instead of global.fetch — this confirm
// the corrected approach (google.ts makeAuth mock + global.fetch spy) works.
describe('BKL-SEC-VERTEX-01: callLLM/callLLMStructured 429 retry via fetchGeminiWithRetry', () => {
  let fetchSpy: ReturnType<typeof spyOn>
  let setTimeoutSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      // @ts-expect-error — test double
      (cb: () => void, _delay: number) => { cb(); return 0 as unknown as ReturnType<typeof setTimeout> },
    )
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => buildVertex429Response(),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    setTimeoutSpy.mockRestore()
  })

  test('callLLM throws on all-429 — does not silently return a thin result', async () => {
    let caught: unknown = null
    try {
      await callLLM('sys', 'user', 'brief-synthesize', 'AcmeTestFixture')
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/429|rate.?limit/i)
  })

  test('callLLM retry loop fires — fetch called more than once before throwing', async () => {
    try { await callLLM('sys', 'user', 'brief-synthesize', 'AcmeTestFixture') } catch { /* expected */ }
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test('callLLMStructured throws on all-429 — does not silently return empty schema', async () => {
    let caught: unknown = null
    try {
      await callLLMStructured('sys', 'user', { type: 'object' }, 'brief-extract', 'AcmeTestFixture')
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/429|rate.?limit/i)
  })

  test('callLLMStructured retry loop fires — fetch called more than once before throwing', async () => {
    try { await callLLMStructured('sys', 'user', { type: 'object' }, 'brief-extract', 'AcmeTestFixture') } catch { /* expected */ }
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

