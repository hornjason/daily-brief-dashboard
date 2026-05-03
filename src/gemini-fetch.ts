/**
 * BKL-TEST-P0-04c — Shared Gemini fetch + 429 retry helper.
 *
 * Extracts the duplicated rate-limit retry loop that previously lived in four
 * places:
 *   - src/account-intelligence.ts :: callGeminiGrounded
 *   - src/account-intelligence.ts :: callGeminiGroundedStructured (Strategy 4 fallback — previously had no retry)
 *   - src/customer.ts              :: callLLM
 *   - src/customer.ts              :: callLLMStructured
 *   - src/doc-extraction.ts        :: callGeminiStructured
 *
 * Contract:
 *   1. POST `body` to `url` with Authorization + Content-Type headers.
 *   2. On HTTP 429, retry up to 4 times with exponential backoff:
 *        delay = 2^attempt * 1000 + rand(0..1000) ms    (2s/4s/8s/16s + jitter)
 *      Re-acquire the token on every retry via `getAccessToken()` (tokens can
 *      expire mid-loop under sustained backoff).
 *   3. On a successful retry response, return it — callers parse the JSON and
 *      record token usage.
 *   4. On a non-429 error during a retry, throw with Bearer redaction and the
 *      canonical `Gemini API error NNN (project=..., location=..., model=...)` prefix.
 *   5. After 4 consecutive 429s, throw `Gemini 429 after 4 retries — rate limited`.
 *   6. Non-429 initial failure: throw the same canonical error format.
 *
 * Callers remain responsible for:
 *   - Supplying getAccessToken() (local to each call site, respects service-account
 *     vs OAuth fallback per module).
 *   - Parsing the JSON body on the returned Response.
 *   - Calling recordGeminiUsage after a successful parse (so usage tracking
 *     stays out of the low-level fetch helper).
 *
 * Optional `timeoutMs` in context preserves callGeminiGrounded's 120s
 * AbortSignal.timeout behavior — a fresh signal is created per attempt so
 * retries aren't cancelled by the first attempt's timer.
 */

export interface GeminiFetchContext {
  callType?: string
  customerName?: string
  model: string
  project: string
  location: string
  /**
   * Per-attempt AbortSignal timeout in milliseconds. When set, each fetch
   * attempt uses a fresh `AbortSignal.timeout(timeoutMs)`. Omitted = no timeout.
   */
  timeoutMs?: number
  /**
   * Optional log prefix for retry-delay diagnostic lines. Defaults to `[gemini-fetch]`.
   */
  logPrefix?: string
}

function redactBearer(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[redacted]"')
    .replace(/access_token=[^&\s"]+/g, 'access_token=[redacted]')
    .slice(0, 300)
}

function formatGeminiError(status: number, body: string, ctx: GeminiFetchContext): string {
  return `Gemini API error ${status} (project=${ctx.project} location=${ctx.location} model=${ctx.model}): ${redactBearer(body)}`
}

function buildInit(token: string, body: string, ctx: GeminiFetchContext): RequestInit {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  }
  if (typeof ctx.timeoutMs === 'number' && ctx.timeoutMs > 0) {
    init.signal = AbortSignal.timeout(ctx.timeoutMs)
  }
  return init
}

/**
 * Parse a `Retry-After` response header and return the delay in milliseconds.
 * Returns `null` when the header is absent or not a valid non-negative integer
 * number of seconds. HTTP-date form is intentionally not supported here —
 * Vertex/Gemini emit integer seconds when they send the header at all.
 */
export function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get('Retry-After')
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const seconds = parseInt(trimmed, 10)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return seconds * 1000
}

export async function fetchGeminiWithRetry(
  url: string,
  getAccessToken: () => Promise<string>,
  body: string,
  context: GeminiFetchContext,
): Promise<Response> {
  const logPrefix = context.logPrefix ?? '[gemini-fetch]'

  // ── Initial attempt (with up to 2 retries on TimeoutError / AbortError) ────
  // BKL-INTEL-DRIVE-TIMEOUT: Vertex grounded calls (industry analysis) can
  // legitimately exceed the 120s per-attempt AbortSignal — when that happens
  // the original implementation propagated the DOMException straight out and
  // killed the whole pipeline. Retry up to 2 times with a fresh timeout signal
  // per attempt; non-timeout errors still propagate immediately.
  function isTimeoutError(e: unknown): boolean {
    const name = (e as { name?: string })?.name
    return name === 'TimeoutError' || name === 'AbortError'
  }

  let token: string
  try { token = await getAccessToken() }
  catch (e) { throw new Error(`Gemini auth failure (project=${context.project}): ${redactBearer(String((e as Error).message ?? e))}`) }

  let res: Response
  let timeoutAttempt = 0
  while (true) {
    try {
      res = await fetch(url, buildInit(token, body, context))
      break
    } catch (e) {
      if (isTimeoutError(e) && timeoutAttempt < 1) {
        timeoutAttempt++
        console.log(`${logPrefix} timeout on attempt ${timeoutAttempt} — retrying`)
        // Re-acquire the token in case the long stall outlived it.
        try { token = await getAccessToken() }
        catch (ae) { throw new Error(`Gemini auth failure on timeout retry (project=${context.project}): ${redactBearer(String((ae as Error).message ?? ae))}`) }
        continue
      }
      throw e
    }
  }

  if (res.ok) return res

  if (res.status !== 429) {
    const err = await res.text()
    throw new Error(formatGeminiError(res.status, err, context))
  }

  // ── 429 retry loop: 4 attempts with exponential backoff + jitter ───────────
  // Honors the `Retry-After` response header (integer seconds) when the server
  // supplies one — otherwise falls back to the original exponential schedule
  // (2s/4s/8s/16s base + jitter) that matches callGeminiGrounded's prior behavior.
  let retryAfterMs: number | null = parseRetryAfterMs(res.headers)
  for (let attempt = 1; attempt <= 4; attempt++) {
    const jitter = Math.floor(Math.random() * 1000)
    const baseDelay = retryAfterMs ?? Math.pow(2, attempt) * 1000
    const delay = baseDelay + jitter
    const source = retryAfterMs != null ? 'Retry-After' : 'exponential'
    console.log(`${logPrefix} 429 rate limit — retrying in ${delay}ms (attempt ${attempt}/4, source=${source}, callType=${context.callType ?? 'unknown'}, customer=${context.customerName ?? 'unknown'})`)
    await new Promise(r => setTimeout(r, delay))

    // Re-acquire token per retry — long backoffs can outlive short-lived tokens.
    let retryToken: string
    try { retryToken = await getAccessToken() }
    catch (e) { throw new Error(`Gemini auth failure on retry (project=${context.project}): ${redactBearer(String((e as Error).message ?? e))}`) }
    let retryRes: Response
    try {
      retryRes = await fetch(url, buildInit(retryToken, body, context))
    } catch (retryFetchErr) {
      if (isTimeoutError(retryFetchErr)) throw new Error(`Gemini timeout on 429 retry attempt ${attempt} (project=${context.project})`)
      throw retryFetchErr
    }

    if (retryRes.ok) return retryRes

    if (retryRes.status !== 429) {
      const retryErr = await retryRes.text()
      throw new Error(formatGeminiError(retryRes.status, retryErr, context))
    }
    // Another 429 — capture any Retry-After for the next iteration, consume the
    // body so runtimes don't leak "unread body" warnings, then loop.
    retryAfterMs = parseRetryAfterMs(retryRes.headers)
    try { await retryRes.text() } catch { /* ignore */ }
  }

  throw new Error('Gemini 429 after 4 retries — rate limited')
}
