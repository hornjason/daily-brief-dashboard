/**
 * Regression Tests — security domain (split from test/regression.spec.ts).
 * Surgical refactor: test text preserved verbatim; readFileSync/resolve paths
 * adjusted for the new test/regression/ directory depth.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { BASE_URL } from './helpers'



// ── REG-SEC-28: BKL-SEC-28 — /api/status/scrapes lastError must not leak raw paths or JWT tokens ──
test.describe('REG-SEC-28: /api/status/scrapes lastError does not expose raw paths or JWT tokens (BKL-SEC-28)', () => {
  test('(source) scraper-manager.ts uses sanitizeErr() for supportable and ccsp lastError', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scraper-manager.ts'), 'utf-8')
    // Inline .slice(0,200).replace(...) must be gone — both fields must use sanitizeErr()
    expect(src, 'lastSupportableError must use sanitizeErr(), not inline slice/replace').not.toMatch(
      /lastSupportableError\s*\?\s*lastSupportableError\.slice/
    )
    expect(src, 'lastCcspError must use sanitizeErr(), not inline slice/replace').not.toMatch(
      /lastCcspError\s*\?\s*lastCcspError\.slice/
    )
    expect(src, 'lastSupportableError must call sanitizeErr()').toMatch(
      /lastSupportableError\s*\?\s*sanitizeErr\(lastSupportableError\)/
    )
    // BKL-ARCH-SCRAPER-03: ccsp lastError now flows through getUnifiedStatus('ccsp').lastError
    // which is sanitized at write time by recordOutcome() in scraper-status-store.ts.
    // The /api/status/scrapes ccsp.lastError field must read from ccspUnified.lastError.
    expect(src, 'ccsp lastError must source from ccspUnified.lastError (store-sanitized)').toMatch(
      /lastError:\s*ccspUnified\.lastError/
    )
    // And scraper-status-store.ts must apply sanitizeErr() inside recordOutcome.
    const storeSrc = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scraper-status-store.ts'), 'utf-8')
    expect(storeSrc, 'recordOutcome must call sanitizeErr() on error path').toMatch(
      /sanitizeErr\(\{\s*message:\s*result\.error\s*\}\)/
    )
  })

  test('GET /api/status/scrapes lastError fields do not contain raw file paths or JWT tokens', async () => {
    const res = await fetch(`${BASE_URL}/api/status/scrapes`)
    expect(res.ok, '/api/status/scrapes must return 200').toBe(true)
    const body = await res.json() as Record<string, any>

    const services = ['supportable', 'ccsp', 'rh', 'salesforce'] as const
    for (const svc of services) {
      const lastError: string | null = body[svc]?.lastError ?? null
      if (!lastError) continue
      // Must not contain raw Unix/container file paths
      expect(lastError, `${svc}.lastError must not contain /Users/ path`).not.toMatch(/\/Users\//)
      expect(lastError, `${svc}.lastError must not contain /data/ path`).not.toMatch(/\/data\//)
      // Must not contain JWT-shaped tokens (header.payload.signature base64url)
      expect(lastError, `${svc}.lastError must not contain JWT token`).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
    }
  })
})

// ── REG-SEC-09: BKL-SEC-09 — parseTerritoryParts allowlist guard ──
test('REG-SEC-09: parseTerritoryParts rejects territory strings not matching [A-Z0-9_] (BKL-SEC-09)', async () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'ccsp-scraper.ts'), 'utf-8')
  expect(src).toMatch(/parseTerritoryParts[\s\S]{0,200}\/\^\[A-Z0-9_\]/)
})

// ── REG-SEC-11: BKL-SEC-11 — sfExpired uses structured sessionExpired boolean ──
test.describe('REG-SEC-11', () => {
  test('GET /api/auth/salesforce/status returns sessionExpired boolean field', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/salesforce/status`)
    expect(res.ok, '/api/auth/salesforce/status must return 200').toBe(true)
    const body = await res.json()
    expect(typeof body.sessionExpired, 'sessionExpired must be a boolean field').toBe('boolean')
  })

  test('sessionExpired is true when syncError contains "session expired"', async () => {
    // Source-level assertion: scraper-manager.ts derives sessionExpired from _sfSyncLastError
    // When the server has no sync error, sessionExpired must be false (not undefined/null)
    const res = await fetch(`${BASE_URL}/api/auth/salesforce/status`)
    expect(res.ok).toBe(true)
    const body = await res.json()
    // If syncError is null/absent, sessionExpired must be false
    if (!body.syncError || !body.syncError.toLowerCase().includes('session expired')) {
      expect(body.sessionExpired, 'sessionExpired must be false when syncError does not indicate expiry').toBe(false)
    } else {
      // If syncError says session expired, sessionExpired must be true
      expect(body.sessionExpired, 'sessionExpired must be true when syncError contains "session expired"').toBe(true)
    }
  })
})

// ── REG-SEC-14: BKL-SEC-14 — intelligenceContext fields wrapped in <untrusted> tags ──
test.describe('REG-SEC-14: buildSynthesisPrompt wraps intelligence fields in untrusted tags (BKL-SEC-14)', () => {
  test('(source) company and industry values are wrapped in <untrusted> tags in brief-pipeline.ts', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '../../src/brief-pipeline.ts'), 'utf8')

    // Both insertion lines must include the <untrusted> wrapper — not raw string concatenation
    // Source uses template literals, so \n is stored as literal backslash-n in the source text.
    // Use \\\\n (four backslashes) in regex literal to match the two-char sequence backslash + n.
    expect(
      src,
      '[Company Intelligence] block must open with <untrusted> immediately after the label',
    ).toMatch(/\[Company Intelligence\]\\n<untrusted>/)

    expect(
      src,
      '[Company Intelligence] block must close with </untrusted>',
    ).toMatch(/intelligenceContext\.company\.slice\(0, 6000\)}<\/untrusted>/)

    expect(
      src,
      '[Industry Analysis] block must open with <untrusted> immediately after the label',
    ).toMatch(/\[Industry Analysis\]\\n<untrusted>/)

    expect(
      src,
      '[Industry Analysis] block must close with </untrusted>',
    ).toMatch(/intelligenceContext\.industry\.slice\(0, 4000\)}<\/untrusted>/)
  })
})

// ── REG-079: BKL-SR03-F2 — Supportable discover wallTimeout uses configurable timeout ──
// Regression: hardcoded `10 * 60 * 1000` wallTimeout in scrape-api.ts bypassed the
// "Default Scrape Timeout" UI control in getAutomationConfig(). The setting had no
// effect on Supportable discover scrapes. Both call sites must read from config.
test.describe('REG-079: scrape-api.ts Supportable discover honors configurable timeout (BKL-SR03-F2)', () => {
  test('(source) REG-079-A: scrape-api.ts has no hardcoded 10 * 60 * 1000 wallTimeout literal', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scrape-api.ts'), 'utf8')
    // The wallTimeout call sites must NOT use the literal `10 * 60 * 1000`.
    // (The 15 * 60 * 1000 stale-mutex check is unrelated and is allowed.)
    expect(
      src,
      'scrape-api.ts must not contain hardcoded 10 * 60 * 1000 (use getAutomationConfig().defaultScrapeTimeoutMs instead)'
    ).not.toMatch(/wallTimeout\(\s*10\s*\*\s*60\s*\*\s*1000/)
  })

  test('(source) REG-079-B: scrape-api.ts imports getAutomationConfig from settings-api', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scrape-api.ts'), 'utf8')
    expect(src, 'getAutomationConfig must be imported from settings-api.ts').toMatch(
      /import\s*\{[^}]*\bgetAutomationConfig\b[^}]*\}\s*from\s*['"]\.\/settings-api\.ts['"]/
    )
  })

  test('(source) REG-079-C: both Supportable discover wallTimeout calls reference defaultScrapeTimeoutMs', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scrape-api.ts'), 'utf8')
    const matches = src.match(/wallTimeout\(\s*getAutomationConfig\(\)\.defaultScrapeTimeoutMs/g) ?? []
    expect(
      matches.length,
      'expected 2 wallTimeout(getAutomationConfig().defaultScrapeTimeoutMs, …) call sites (Supportable discover all-AEs + single-AE)'
    ).toBe(2)
  })
})

// ── REG-080: BKL-W5-RK-F1 — CACHE_DIR / DATA_DIR startup confinement check ──
// Regression: CACHE_DIR and DATA_DIR were taken raw from process.env with only a
// per-request `startsWith('/data')` literal check. A startup assertion must fire at
// module load and refuse to start the container when CACHE_DIR resolves outside DATA_DIR.
test.describe('REG-080: product-intel-routes.ts startup CACHE_DIR confinement check (BKL-W5-RK-F1)', () => {
  test('(source) REG-080-A: module-load assertion resolves both env vars and compares', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'product-intel-routes.ts'), 'utf8')
    // Confinement assertion must reference both env vars and use path.resolve()
    // comparison rather than a literal `/data` startsWith check.
    // Implementation resolves each env var to a variable first, then compares the variables.
    expect(src, 'startup block must reference DATA_DIR env var').toMatch(/process\.env\.DATA_DIR/)
    expect(src, 'startup block must reference CACHE_DIR env var').toMatch(/process\.env\.CACHE_DIR/)
    expect(src, 'startup assertion must call resolve() on DATA_DIR').toMatch(/resolve\(process\.env\.DATA_DIR\)/)
    expect(src, 'startup assertion must call resolve() on CACHE_DIR').toMatch(/resolve\(process\.env\.CACHE_DIR\)/)
    // The resolved vars must be compared with startsWith
    expect(src, 'startup assertion must use startsWith to compare resolved paths').toMatch(/_resolvedCache\.startsWith\(/)
  })

  test('(source) REG-080-B: misconfiguration throws a descriptive error at startup', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'product-intel-routes.ts'), 'utf8')
    // The startup assertion must throw (not warn) so the container fails fast.
    expect(src, 'startup confinement check must throw on misconfig').toMatch(
      /throw new Error\([\s\S]*?CACHE_DIR[\s\S]*?DATA_DIR/
    )
  })

  test('(source) REG-080-C: assertion sits at module top level, before route registration', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'product-intel-routes.ts'), 'utf8')
    // Find the top-level startup confinement block — identified by resolve(process.env.CACHE_DIR)
    const assertionIdx = src.indexOf('resolve(process.env.CACHE_DIR)')
    const registerIdx  = src.indexOf('export function createProductIntelRouter(')
    expect(assertionIdx, 'startup confinement assertion (resolve(process.env.CACHE_DIR)) must exist').toBeGreaterThan(0)
    expect(registerIdx, 'createProductIntelRouter must exist').toBeGreaterThan(0)
    expect(
      assertionIdx,
      'confinement check must run at module load (before createProductIntelRouter definition)'
    ).toBeLessThan(registerIdx)
  })
})

// ── REG-081: BKL-W5-RK-F2 — Defense-in-depth filename sanitization for intel.customer fallback ──
// Regression: when intel.customer is null, the cache filename was returned verbatim.
// Filenames are server-written but defense-in-depth says strip non-printable/special
// chars (anything that isn't word chars, whitespace, or hyphens) from any fallback.
test.describe('REG-081: territory-summary intel.customer fallback sanitizes filename (BKL-W5-RK-F2)', () => {
  test('(source) REG-081-A: fallback strips non-word/non-hyphen/non-whitespace chars', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'product-intel-routes.ts'), 'utf8')
    // Fallback must run a sanitization regex stripping anything outside [\w\s-].
    expect(src, 'fallback must apply [^\\w\\s-] strip regex on filename').toMatch(
      /intel\.customer\s*\?\?[^,\n]*\.replace\(\s*\/\[\^\\w\\s-\]\/g\s*,\s*['"]{2}\s*\)/
    )
  })

  test('(source) REG-081-B: sanitization regex behaves as documented', () => {
    // Sanity check that the documented regex actually strips dangerous chars.
    const sanitize = (s: string) => s.replace(/[^\w\s-]/g, '')
    expect(sanitize('acme-corp')).toBe('acme-corp')
    expect(sanitize('acme corp 2025')).toBe('acme corp 2025')
    expect(sanitize('acme/../etc/passwd')).toBe('acmeetcpasswd')
    expect(sanitize('<script>alert(1)</script>')).toBe('scriptalert1script')
    expect(sanitize('weird\u0000\u001Fchars')).toBe('weirdchars')
  })
})
