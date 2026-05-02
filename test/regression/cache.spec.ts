/**
 * Regression Tests — cache domain (split from test/regression.spec.ts).
 * Surgical refactor: test text preserved verbatim; readFileSync/resolve paths
 * adjusted for the new test/regression/ directory depth.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'



// ── REG-TOKEN-03: BKL-TOKEN-08 — Vertex grounded timeout raised from 60s to 120s ──
// Root cause: callGeminiGrounded used AbortSignal.timeout(60_000) in both the initial
// request and the 429 retry. Large grounded calls (company + industry briefs with many
// tools/search hits) occasionally exceeded 60s, aborting mid-stream and wasting tokens.
// Fix: timeout is now passed as timeoutMs: 120_000 via fetchGeminiWithRetry (gemini-fetch.ts),
// which creates a fresh AbortSignal.timeout per attempt. The structured-only fallback
// at timeoutMs: 30_000 is intentionally left alone — it's a smaller non-grounded call.

test('REG-TOKEN-03-a: callGeminiGrounded uses 120s timeout for initial + retry (BKL-TOKEN-08)', () => {
  const SRC = resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts')
  const src = readFileSync(SRC, 'utf-8')
  // BKL-TEST-P0-04c: timeout is now passed via fetchGeminiWithRetry's timeoutMs param.
  // callGeminiGrounded must call fetchGeminiWithRetry with timeoutMs: 120_000.
  // The grounded-structured fallback uses timeoutMs: 30_000 (intentionally smaller).
  expect(src, 'callGeminiGrounded must use fetchGeminiWithRetry for retry-aware calls').toContain('fetchGeminiWithRetry')
  expect(src, 'grounded call must pass timeoutMs: 120_000 to fetchGeminiWithRetry').toContain('timeoutMs: 120_000')
  // No raw 60_000 timeout should remain in account-intelligence.ts
  const sixtyCount = [...src.matchAll(/AbortSignal\.timeout\(\s*60_?000\s*\)/g)].length
  expect(sixtyCount, '60s AbortSignal.timeout still present in account-intelligence.ts — BKL-TOKEN-08 requires 120s').toBe(0)
})

// ── REG-TOKEN-04: BKL-TOKEN-09 — identifyIndustry result persisted to customers.json ──
// Root cause: cacheIndustryResult did its own direct read/write bypassing saveCustomers'
// merge logic. Separately, there was no idempotency guard — every batch run re-wrote the
// same industry, and the "customers.json missing industry despite fresh cache" warning
// fired when any concurrent customers.json writer stripped the field.
// Fix: (a) cacheIndustryResult now early-returns when on-disk industry already matches,
// (b) uses canonical patchCustomer() so merge-not-replace logic in customer-merge.ts
// preserves industry/segment across writes. A full end-to-end unit test would require
// mocking the Gemini API — this is a source-level structural check.

test('REG-TOKEN-04-a: cacheIndustryResult uses patchCustomer for canonical write-back (BKL-TOKEN-09)', () => {
  const SRC = resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts')
  const src = readFileSync(SRC, 'utf-8')
  // patchCustomer must be imported from server-state
  expect(src, 'patchCustomer must be imported from server-state').toMatch(/import\s*\{[^}]*\bpatchCustomer\b[^}]*\}\s*from\s*'\.\/server-state\.ts'/)
  // cacheIndustryResult must call patchCustomer with industry + segment fields
  const fnMatch = src.match(/export function cacheIndustryResult\([\s\S]+?^\}/m)
  expect(fnMatch, 'cacheIndustryResult function body not found').toBeTruthy()
  const body = fnMatch![0]
  expect(body, 'cacheIndustryResult must call patchCustomer').toMatch(/patchCustomer\(\s*customerName\s*,/)
  expect(body, 'patchCustomer payload must include industry').toMatch(/industry:\s*result\.industry/)
  expect(body, 'patchCustomer payload must include segment').toMatch(/segment:\s*result\.segment/)
})

test('REG-TOKEN-04-b: cacheIndustryResult skips write when industry already matches (BKL-TOKEN-09)', () => {
  const SRC = resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts')
  const src = readFileSync(SRC, 'utf-8')
  // cacheIndustryResult must compare existing.industry === result.industry and return early
  const fnMatch = src.match(/export function cacheIndustryResult\([\s\S]+?^\}/m)
  expect(fnMatch, 'cacheIndustryResult function body not found').toBeTruthy()
  const body = fnMatch![0]
  expect(body, 'cacheIndustryResult must have idempotency guard comparing existing.industry to result.industry').toMatch(/existing\.industry\s*===\s*result\.industry/)
  expect(body, 'cacheIndustryResult must return early when industry matches').toMatch(/skipping write/i)
})

// ── REG-TOKEN-07 / REG-TOKEN-08: BKL-TOKEN-05 — shared industry analysis cache ──
// Root cause: generateIndustryAnalysis() made a grounded Gemini call per customer,
// so N customers sharing "Healthcare / IT Services" each paid for their own industry
// brief. Fix: cache-layer.ts exports readIndustryAnalysisCache/writeIndustryAnalysisCache
// keyed by {industry, region} slug with 30-day TTL. generateIndustryAnalysis() now
// reads that cache before the Gemini call and writes back on miss. Source-level
// structural checks — full end-to-end requires Gemini mocking.

test('REG-TOKEN-07: cache-layer.ts exports readIndustryAnalysisCache and writeIndustryAnalysisCache (BKL-TOKEN-05)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  expect(src, 'readIndustryAnalysisCache must be exported from cache-layer.ts').toMatch(/export function readIndustryAnalysisCache\s*\(/)
  expect(src, 'writeIndustryAnalysisCache must be exported from cache-layer.ts').toMatch(/export function writeIndustryAnalysisCache\s*\(/)
})

test('REG-TOKEN-08: generateIndustryAnalysis calls readIndustryAnalysisCache before the Gemini call (BKL-TOKEN-05)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts'), 'utf-8')
  // readIndustryAnalysisCache + writeIndustryAnalysisCache must be imported from cache-layer
  expect(src, 'readIndustryAnalysisCache must be imported from cache-layer.ts').toMatch(/import\s*\{[^}]*\breadIndustryAnalysisCache\b[^}]*\}\s*from\s*'\.\/cache-layer\.ts'/)
  expect(src, 'writeIndustryAnalysisCache must be imported from cache-layer.ts').toMatch(/import\s*\{[^}]*\bwriteIndustryAnalysisCache\b[^}]*\}\s*from\s*'\.\/cache-layer\.ts'/)
  // Locate generateIndustryAnalysis function body — end at the next section comment marker
  const fnStart = src.indexOf('export async function generateIndustryAnalysis')
  expect(fnStart, 'generateIndustryAnalysis must be present in account-intelligence.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('// ── BKL-AI04', fnStart)
  expect(fnEnd, 'BKL-AI04 section marker not found after generateIndustryAnalysis').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  const cacheReadIdx = body.indexOf('readIndustryAnalysisCache')
  const geminiCallIdx = body.indexOf('callGeminiGrounded')
  const cacheWriteIdx = body.indexOf('writeIndustryAnalysisCache')
  expect(cacheReadIdx, 'generateIndustryAnalysis must call readIndustryAnalysisCache').toBeGreaterThan(-1)
  expect(geminiCallIdx, 'generateIndustryAnalysis must still call callGeminiGrounded').toBeGreaterThan(-1)
  expect(cacheWriteIdx, 'generateIndustryAnalysis must call writeIndustryAnalysisCache').toBeGreaterThan(-1)
  expect(cacheReadIdx, 'readIndustryAnalysisCache must be called BEFORE callGeminiGrounded in generateIndustryAnalysis').toBeLessThan(geminiCallIdx)
  expect(geminiCallIdx, 'writeIndustryAnalysisCache must be called AFTER callGeminiGrounded in generateIndustryAnalysis').toBeLessThan(cacheWriteIdx)
})

// ── REG-ADR013: ADR-013 Tier 3 content-addressed cache for Drive docs + doc classifications ──
// Eliminates repeated drive.files.export(), PDF multimodal extraction, and Gemini classification
// calls for docs that haven't changed between briefs (invalidation by fileId + modifiedTime).
// Source-level structural checks — full end-to-end would require live Drive + Gemini mocking.

test('REG-ADR013-01: cache-layer.ts exports readDocContentCache and writeDocContentCache (ADR-013)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  expect(src, 'readDocContentCache must be exported from cache-layer.ts').toMatch(/export function readDocContentCache\s*\(/)
  expect(src, 'writeDocContentCache must be exported from cache-layer.ts').toMatch(/export function writeDocContentCache\s*\(/)
})

test('REG-ADR013-02: cache-layer.ts exports readDocClassCache and writeDocClassCache (ADR-013)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  expect(src, 'readDocClassCache must be exported from cache-layer.ts').toMatch(/export function readDocClassCache\s*\(/)
  expect(src, 'writeDocClassCache must be exported from cache-layer.ts').toMatch(/export function writeDocClassCache\s*\(/)
})

test('REG-ADR013-03: classifyAndExtract checks the classification cache before calling Gemini (ADR-013)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'doc-extraction.ts'), 'utf-8')
  // readDocClassCache must be imported from cache-layer
  expect(src, 'readDocClassCache must be imported from cache-layer.ts').toMatch(/import\s*\{[^}]*\breadDocClassCache\b[^}]*\}\s*from\s*'\.\/cache-layer\.ts'/)
  // Locate classifyAndExtract function body (function declaration up to its closing brace column 0)
  const fnStart = src.indexOf('export async function classifyAndExtract')
  expect(fnStart, 'classifyAndExtract must be present in doc-extraction.ts').toBeGreaterThan(-1)
  // Next top-level declaration or batch comment marks the end of classifyAndExtract — use batch comment as a stable anchor
  const fnEnd = src.indexOf('// ── Batch classification', fnStart)
  expect(fnEnd, 'batch-classification section marker not found after classifyAndExtract').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  const cacheReadIdx = body.indexOf('readDocClassCache')
  const geminiCallIdx = body.indexOf('callGeminiStructured')
  expect(cacheReadIdx, 'classifyAndExtract must call readDocClassCache').toBeGreaterThan(-1)
  expect(geminiCallIdx, 'classifyAndExtract must still call callGeminiStructured').toBeGreaterThan(-1)
  expect(cacheReadIdx, 'readDocClassCache must be called BEFORE callGeminiStructured in classifyAndExtract').toBeLessThan(geminiCallIdx)
})

test('REG-ADR013-04: exportFileContent checks readDocContentCache before drive.files.export (ADR-013)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer.ts'), 'utf-8')
  // readDocContentCache must be imported from cache-layer
  expect(src, 'readDocContentCache must be imported from cache-layer.ts').toMatch(/import\s*\{[^}]*\breadDocContentCache\b[^}]*\}\s*from\s*'\.\/cache-layer\.ts'/)
  // Locate exportFileContent helper body (from declaration to Phase 1 comment marker)
  const fnStart = src.indexOf('async function exportFileContent')
  expect(fnStart, 'exportFileContent must be present in customer.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('// Phase 1:', fnStart)
  expect(fnEnd, 'Phase 1 marker not found after exportFileContent').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  const cacheReadIdx = body.indexOf('readDocContentCache')
  const driveExportIdx = body.indexOf('drive.files.export')
  expect(cacheReadIdx, 'exportFileContent must call readDocContentCache').toBeGreaterThan(-1)
  expect(driveExportIdx, 'exportFileContent must still call drive.files.export').toBeGreaterThan(-1)
  expect(cacheReadIdx, 'readDocContentCache must be called BEFORE drive.files.export in exportFileContent').toBeLessThan(driveExportIdx)
})

// ── REG-ADR013-P1: Tier 2 time-boxed cache for Gmail emails + Calendar meetings ──
// 2h TTL wall-clock cache eliminates live Gmail/Calendar API calls per brief.
// Source-level structural checks — runtime TTL behaviour covered by cache-layer unit tests.

test('REG-ADR013-05: cache-layer.ts exports readEmailCache and writeEmailCache (ADR-013 Tier 2)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  expect(src, 'readEmailCache must be exported from cache-layer.ts').toMatch(/export function readEmailCache\s*\(/)
  expect(src, 'writeEmailCache must be exported from cache-layer.ts').toMatch(/export function writeEmailCache\s*\(/)
})

test('REG-ADR013-06: cache-layer.ts exports readMeetingCache and writeMeetingCache (ADR-013 Tier 2)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  expect(src, 'readMeetingCache must be exported from cache-layer.ts').toMatch(/export function readMeetingCache\s*\(/)
  expect(src, 'writeMeetingCache must be exported from cache-layer.ts').toMatch(/export function writeMeetingCache\s*\(/)
})

test('REG-ADR013-07: fetchCustomerEmails checks readEmailCache before Gmail API call (ADR-013 Tier 2)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer.ts'), 'utf-8')
  // readEmailCache must be imported from cache-layer
  expect(src, 'readEmailCache must be imported from cache-layer.ts').toMatch(/import\s*\{[^}]*\breadEmailCache\b[^}]*\}\s*from\s*'\.\/cache-layer\.ts'/)
  // Locate fetchCustomerEmails body — ends at next top-level comment section
  const fnStart = src.indexOf('export async function fetchCustomerEmails')
  expect(fnStart, 'fetchCustomerEmails must be present in customer.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('// ── Drive:', fnStart)
  expect(fnEnd, 'Drive section marker not found after fetchCustomerEmails').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  const cacheReadIdx = body.indexOf('readEmailCache')
  const gmailCallIdx = body.indexOf('gmail.users.messages.list')
  expect(cacheReadIdx, 'fetchCustomerEmails must call readEmailCache').toBeGreaterThan(-1)
  expect(gmailCallIdx, 'fetchCustomerEmails must still call Gmail API').toBeGreaterThan(-1)
  expect(cacheReadIdx, 'readEmailCache must be called BEFORE Gmail API in fetchCustomerEmails').toBeLessThan(gmailCallIdx)
})

test('REG-ADR013-08: fetchCustomerMeetings checks readMeetingCache before Calendar API call (ADR-013 Tier 2)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer.ts'), 'utf-8')
  // readMeetingCache must be imported from cache-layer
  expect(src, 'readMeetingCache must be imported from cache-layer.ts').toMatch(/import\s*\{[^}]*\breadMeetingCache\b[^}]*\}\s*from\s*'\.\/cache-layer\.ts'/)
  // Locate fetchCustomerMeetings body — ends at the Gmail section marker
  const fnStart = src.indexOf('export async function fetchCustomerMeetings')
  expect(fnStart, 'fetchCustomerMeetings must be present in customer.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('// ── Gmail:', fnStart)
  expect(fnEnd, 'Gmail section marker not found after fetchCustomerMeetings').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  const cacheReadIdx = body.indexOf('readMeetingCache')
  const calendarCallIdx = body.indexOf('calendar.events.list')
  expect(cacheReadIdx, 'fetchCustomerMeetings must call readMeetingCache').toBeGreaterThan(-1)
  expect(calendarCallIdx, 'fetchCustomerMeetings must still call Calendar API').toBeGreaterThan(-1)
  expect(cacheReadIdx, 'readMeetingCache must be called BEFORE Calendar API in fetchCustomerMeetings').toBeLessThan(calendarCallIdx)
})

// ── REG-ADR013-P2: Tier 3 input-fingerprint cache for brief synthesis ──
// Replaces wall-clock TTL with SHA256 fingerprint of all brief inputs.
// Cached briefs are served directly when inputs match (zero Gemini calls).
// 7-day TTL retained as a safety-net fallback, not the primary invalidation mechanism.

test('REG-ADR013-09: writeBriefCache accepts inputFingerprint and stores it (ADR-013 P2)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  // Signature must accept inputFingerprint as a 4th optional parameter
  expect(src, 'writeBriefCache signature must declare inputFingerprint parameter').toMatch(/export function writeBriefCache\s*\([\s\S]*?inputFingerprint\??\s*:\s*string[\s\S]*?\)/)
  // Function body must write inputFingerprint to the serialised payload
  const fnStart = src.indexOf('export function writeBriefCache')
  expect(fnStart, 'writeBriefCache must be defined in cache-layer.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('\n}', fnStart)
  expect(fnEnd, 'closing brace not found for writeBriefCache').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  expect(body, 'writeBriefCache body must persist inputFingerprint in the JSON payload').toMatch(/inputFingerprint/)
  expect(body, 'writeBriefCache must call writeFileSync to persist the payload').toMatch(/writeFileSync/)
})

test('REG-ADR013-10: readBriefCache returns inputFingerprint field (ADR-013 P2)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  // Return type must include inputFingerprint
  expect(src, 'readBriefCache return type must declare inputFingerprint').toMatch(/export function readBriefCache\s*\([^)]*\)\s*:\s*\{[^}]*inputFingerprint\??\s*:\s*string[^}]*\}\s*\|\s*null/)
  // Function body must read inputFingerprint from the stored data and include it in the returned object
  const fnStart = src.indexOf('export function readBriefCache')
  expect(fnStart, 'readBriefCache must be defined in cache-layer.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('\n}', fnStart)
  expect(fnEnd, 'closing brace not found for readBriefCache').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  expect(body, 'readBriefCache must surface inputFingerprint to callers').toMatch(/inputFingerprint/)
})

test('REG-ADR013-11: brief handler computes inputFingerprint BEFORE generateBrief (ADR-013 P2)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')
  // createHash must be imported from crypto (no new dependency)
  expect(src, 'createHash must be imported from node:crypto').toMatch(/import\s*\{[^}]*\bcreateHash\b[^}]*\}\s*from\s*'crypto'/)
  // Locate the GET /customer/:name/brief handler body. It starts at the app.get call
  // and ends at the next app.get registration (for /customer/:name/ccsp).
  const handlerStart = src.indexOf("app.get('/customer/:name/brief'")
  expect(handlerStart, 'GET /customer/:name/brief handler must exist in customer-routes.ts').toBeGreaterThan(-1)
  const handlerEnd = src.indexOf("app.get('/customer/:name/ccsp'", handlerStart)
  expect(handlerEnd, 'ccsp handler marker not found after brief handler').toBeGreaterThan(handlerStart)
  const body = src.slice(handlerStart, handlerEnd)
  // Fingerprint must be computed with createHash + sha256 + digest hex
  const fingerprintIdx = body.indexOf('inputFingerprint')
  const createHashIdx = body.indexOf("createHash('sha256')")
  // Use `await generateBrief(` to locate the actual Gemini call — indexOf('generateBrief(')
  // would match inline comments that reference `generateBrief()` as prose.
  const generateBriefIdx = body.indexOf('await generateBrief(')
  expect(fingerprintIdx, 'brief handler must compute inputFingerprint').toBeGreaterThan(-1)
  expect(createHashIdx, "brief handler must call createHash('sha256') to build the fingerprint").toBeGreaterThan(-1)
  expect(generateBriefIdx, 'brief handler must still call generateBrief').toBeGreaterThan(-1)
  // The fingerprint must be computed BEFORE the Gemini-bound generateBrief call
  expect(createHashIdx, 'inputFingerprint must be computed BEFORE generateBrief() is called').toBeLessThan(generateBriefIdx)
  // The cached fingerprint must be compared against the newly computed one
  expect(body, 'brief handler must compare cached inputFingerprint against new fingerprint').toMatch(/cached\.inputFingerprint\s*===\s*inputFingerprint/)
  // writeBriefCache call must pass inputFingerprint (4th argument) on cache miss
  expect(body, 'writeBriefCache must receive inputFingerprint as the 4th argument').toMatch(/writeBriefCache\s*\([^)]*inputFingerprint[^)]*\)/)
})

test('REG-ADR013-12: BRIEF_CACHE_TTL_MS is 7 days (ADR-013 P2 safety-net TTL)', async () => {
  const { BRIEF_CACHE_TTL_MS } = await import('../../src/cache-layer.ts')
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  expect(BRIEF_CACHE_TTL_MS, 'BRIEF_CACHE_TTL_MS must be 7 days (604800000ms) — fingerprint is primary invalidation, TTL is safety-net fallback').toBe(SEVEN_DAYS_MS)
  expect(SEVEN_DAYS_MS).toBe(604_800_000)
})

// ── REG-TOKEN-05 / REG-TOKEN-06: BKL-TOKEN-04 — SHA256 hash guards on CCSP + pipeline caches ──
// Root cause: writeCCSPCache() and writePipelineCache() unconditionally overwrote their cache
// files with a new `cachedAt` timestamp every scrape, even when the underlying records were
// identical. That cadence bumped the brief input fingerprint (ADR-013 P2), invalidating cached
// briefs and triggering needless Gemini regenerations. Mirrors the hash-guard pattern already
// used by writeSheetCache(): compute SHA256 of content, compare against existing hash, skip
// the write when they match to preserve cachedAt.

test('REG-TOKEN-05: writeCCSPCache has SHA256 hash guard with early return (BKL-TOKEN-04)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  const fnStart = src.indexOf('export function writeCCSPCache')
  expect(fnStart, 'writeCCSPCache must be defined in cache-layer.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('\n}', fnStart)
  expect(fnEnd, 'closing brace not found for writeCCSPCache').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  // Must compute a SHA256 hash over the records
  expect(body, "writeCCSPCache must call createHash('sha256') on incoming records").toMatch(/createHash\(\s*['"]sha256['"]\s*\)/)
  // Must read the existing cache to pull the prior hash
  expect(body, 'writeCCSPCache must call readCCSPCache() to fetch the prior hash').toMatch(/readCCSPCache\s*\(\s*\)/)
  // Must early-return when hashes match (content unchanged → preserve cachedAt)
  expect(body, 'writeCCSPCache must early-return when the new hash matches the existing hash').toMatch(/===\s*newHash[\s\S]*?return|newHash\s*===[\s\S]*?return/)
  // Must persist the computed hash so future reads can compare without rehashing
  expect(body, 'writeCCSPCache must persist the hash in the serialised payload').toMatch(/hash:\s*newHash/)
})

test('REG-TOKEN-06: writePipelineCache has SHA256 hash guard with early return (BKL-TOKEN-04)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'cache-layer.ts'), 'utf-8')
  const fnStart = src.indexOf('export function writePipelineCache')
  expect(fnStart, 'writePipelineCache must be defined in cache-layer.ts').toBeGreaterThan(-1)
  const fnEnd = src.indexOf('\n}', fnStart)
  expect(fnEnd, 'closing brace not found for writePipelineCache').toBeGreaterThan(fnStart)
  const body = src.slice(fnStart, fnEnd)
  // Must compute a SHA256 hash over records + fileIds (fileIds are part of the tracked state)
  expect(body, "writePipelineCache must call createHash('sha256') on incoming data").toMatch(/createHash\(\s*['"]sha256['"]\s*\)/)
  // Must read the existing cache to pull the prior hash
  expect(body, 'writePipelineCache must call readPipelineCache() to fetch the prior hash').toMatch(/readPipelineCache\s*\(\s*\)/)
  // Must early-return when hashes match (content unchanged → preserve cachedAt)
  expect(body, 'writePipelineCache must early-return when the new hash matches the existing hash').toMatch(/===\s*newHash[\s\S]*?return|newHash\s*===[\s\S]*?return/)
  // Must persist the computed hash so future reads can compare without rehashing
  expect(body, 'writePipelineCache must persist the hash in the serialised payload').toMatch(/hash:\s*newHash/)
})

// ── REG-TOKEN-09: BKL-TOKEN-02 — tiered intelligence TTL (company + industry) ──
// Root cause: a single INTELLIGENCE_CACHE_TTL_DAYS (default 7) gated both company
// intelligence and industry analysis regeneration. Industry analysis is macro-level
// and rarely changes — burning grounded Gemini tokens on a weekly cadence was waste.
// Fix: split into INTELLIGENCE_COMPANY_TTL_DAYS (default 14) and
// INTELLIGENCE_INDUSTRY_TTL_DAYS (default 30), both env-configurable.

test('REG-TOKEN-09: account-intelligence.ts declares tiered company + industry TTLs (BKL-TOKEN-02)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts'), 'utf-8')
  // Company TTL constant must exist with env override and a 14-day default
  expect(src, 'INTELLIGENCE_COMPANY_TTL_DAYS must be declared in account-intelligence.ts')
    .toMatch(/const\s+INTELLIGENCE_COMPANY_TTL_DAYS\s*=\s*Number\(\s*process\.env\.INTELLIGENCE_COMPANY_TTL_DAYS\s*\)\s*\|\|\s*14\b/)
  // Industry TTL constant must exist with env override and a 30-day default
  expect(src, 'INTELLIGENCE_INDUSTRY_TTL_DAYS must be declared in account-intelligence.ts')
    .toMatch(/const\s+INTELLIGENCE_INDUSTRY_TTL_DAYS\s*=\s*Number\(\s*process\.env\.INTELLIGENCE_INDUSTRY_TTL_DAYS\s*\)\s*\|\|\s*30\b/)
  // Both TTLs must be converted to ms form for comparison against cache age
  expect(src, 'INTELLIGENCE_COMPANY_TTL_MS must be derived from the days constant')
    .toMatch(/INTELLIGENCE_COMPANY_TTL_MS\s*=\s*INTELLIGENCE_COMPANY_TTL_DAYS/)
  expect(src, 'INTELLIGENCE_INDUSTRY_TTL_MS must be derived from the days constant')
    .toMatch(/INTELLIGENCE_INDUSTRY_TTL_MS\s*=\s*INTELLIGENCE_INDUSTRY_TTL_DAYS/)
  // Cache-skip gate must reference BOTH ms constants — company for company freshness, industry for industry
  expect(src, 'cache-skip gate must compare age against INTELLIGENCE_COMPANY_TTL_MS')
    .toMatch(/INTELLIGENCE_COMPANY_TTL_MS/)
  expect(src, 'cache-skip gate must compare age against INTELLIGENCE_INDUSTRY_TTL_MS')
    .toMatch(/INTELLIGENCE_INDUSTRY_TTL_MS/)
  // The old single TTL constants must be gone (no silent fall-back to 7d)
  expect(src, 'INTELLIGENCE_CACHE_TTL_DAYS must no longer be declared — replaced by tiered TTLs')
    .not.toMatch(/const\s+INTELLIGENCE_CACHE_TTL_DAYS\s*=/)
  expect(src, 'INTELLIGENCE_CACHE_TTL_MS must no longer be declared — replaced by tiered TTLs')
    .not.toMatch(/const\s+INTELLIGENCE_CACHE_TTL_MS\s*=/)
})

// ── REG-TOKEN-10: BKL-TOKEN-03 — pregen-all fires ONCE per POD, not per AE ──
// Root cause: /api/intelligence/generate-all and /api/briefs/pregen-all were fetched
// from inside the per-AE /api/bootstrap/auto handler. POD bootstrap calls that handler
// once per AE in a for-loop, so a POD with N AEs triggered N pregen batches, each
// rescanning every customer in the system. Fix: move both fetches out of the per-AE
// handler and into bootstrapPOD, after the AE for-loop completes. Source-level check:
// the two fetches must not appear inside the per-AE handler, and must appear once
// inside bootstrapPOD at post-loop scope.

test('REG-TOKEN-10: pregen-all fetches are OUT of per-AE /api/bootstrap/auto handler (BKL-TOKEN-03)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'bootstrap-orchestrator.ts'), 'utf-8')
  // Find the per-AE handler body — it starts at app.post('/api/bootstrap/auto'... and ends
  // at the next app.post or app.get route declaration.
  const handlerStart = src.indexOf("app.post('/api/bootstrap/auto'")
  expect(handlerStart, "'/api/bootstrap/auto' route handler not found").toBeGreaterThan(-1)
  // Next route declaration marks the end of this handler block
  const nextRoute = src.indexOf('app.', handlerStart + 1)
  expect(nextRoute, 'next route after /api/bootstrap/auto not found').toBeGreaterThan(handlerStart)
  const handlerBody = src.slice(handlerStart, nextRoute)

  // Neither fetch may live inside the per-AE handler — those would fire once per AE in a POD
  expect(handlerBody, 'intelligence/generate-all fetch must NOT be inside the per-AE bootstrap/auto handler')
    .not.toMatch(/\/api\/intelligence\/generate-all/)
  expect(handlerBody, 'briefs/pregen-all fetch must NOT be inside the per-AE bootstrap/auto handler')
    .not.toMatch(/\/api\/briefs\/pregen-all/)

  // And both fetches must live inside bootstrapPOD so they fire once per POD run
  const podStart = src.indexOf('async function bootstrapPOD')
  expect(podStart, 'bootstrapPOD function not found').toBeGreaterThan(-1)
  // bootstrapPOD returns the handler registration block — scan until createBootstrapRouter
  const podEnd = src.indexOf('export function createBootstrapRouter', podStart)
  expect(podEnd, 'createBootstrapRouter not found after bootstrapPOD').toBeGreaterThan(podStart)
  const podBody = src.slice(podStart, podEnd)
  expect(podBody, 'intelligence/generate-all must be fetched from bootstrapPOD (post-loop)')
    .toMatch(/\/api\/intelligence\/generate-all/)
  expect(podBody, 'briefs/pregen-all must be fetched from bootstrapPOD (post-loop)')
    .toMatch(/\/api\/briefs\/pregen-all/)
})

test('REG-TOKEN-10-b: bootstrapPOD pregen fetches sit AFTER the per-AE for-loop (BKL-TOKEN-03)', () => {
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'bootstrap-orchestrator.ts'), 'utf-8')
  const podStart = src.indexOf('async function bootstrapPOD')
  expect(podStart, 'bootstrapPOD function not found').toBeGreaterThan(-1)
  const podEnd = src.indexOf('export function createBootstrapRouter', podStart)
  expect(podEnd, 'createBootstrapRouter not found after bootstrapPOD').toBeGreaterThan(podStart)
  const podBody = src.slice(podStart, podEnd)

  // The canonical POD AE loop header — "for (let i = 0; i < aeEntries.length; i++)"
  const loopHeader = podBody.indexOf('for (let i = 0; i < aeEntries.length')
  expect(loopHeader, 'canonical per-AE for-loop header not found inside bootstrapPOD').toBeGreaterThan(-1)
  const intelFetch = podBody.indexOf('/api/intelligence/generate-all')
  const briefFetch = podBody.indexOf('/api/briefs/pregen-all')

  // Both pregen fetches must come AFTER the loop header — i.e. post-loop position in source
  expect(intelFetch, 'intelligence/generate-all fetch must be located after the per-AE for-loop').toBeGreaterThan(loopHeader)
  expect(briefFetch, 'briefs/pregen-all fetch must be located after the per-AE for-loop').toBeGreaterThan(loopHeader)
})

// ── BKL-TOKEN-07: POD bootstrap reuses disk pipeline cache when fresh ────────
// Before the live SF pre-scrape in POD bootstrap, check readPipelineCache().
// If records exist and cachedAt is within 4h, synthesize an SfReportRow from
// those records and skip the browser-driven SF scrape. Saves one expensive SF
// browser session per POD bootstrap run when recent pipeline data is on disk.
test('REG-TOKEN-07: pipeline cache TTL constant is defined and bootstrap-orchestrator imports readPipelineCache', () => {
  const bootstrapSrc = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'bootstrap-orchestrator.ts'), 'utf-8')
  expect(bootstrapSrc).toMatch(/readPipelineCache/)
  expect(bootstrapSrc).toMatch(/disk pipeline cache|Reusing disk pipeline/)
  expect(bootstrapSrc).toMatch(/PIPELINE_DISK_TTL/)
})

// ── REG-TOKEN-06: BKL-TOKEN-06 — Vertex 429 rate-limit guards ────────────────
// Phase 1 fixed 429 rate-limit errors in the intelligence pipeline by:
//   (a) dropping MAX_CONCURRENT from 5 to 2 in /api/intelligence/generate-all
//       (lives in src/customer-routes.ts, not src/account-intelligence.ts — the
//        batch orchestrator lives with the route handler), and
//   (b) adding exponential backoff with jitter (2s/4s/8s/16s + 0-1000ms jitter,
//       up to 4 retries) on 429 responses inside callGeminiGrounded().
// Without regression guards, a later "tune the concurrency" or "simplify the
// retry" edit could silently re-introduce the rate-limit storms.

test('REG-TOKEN-06-a: intelligence batch MAX_CONCURRENT is <= 2 (429 rate-limit guard)', () => {
  // NOTE: MAX_CONCURRENT for the generate-all batch lives in customer-routes.ts
  // (inside the /api/intelligence/generate-all handler), not account-intelligence.ts.
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')
  const match = src.match(/MAX_CONCURRENT\s*=\s*(\d+)/)
  expect(match, 'MAX_CONCURRENT constant not found in customer-routes.ts').toBeTruthy()
  const val = parseInt(match![1], 10)
  expect(val, `MAX_CONCURRENT is ${val} — must be <= 2 to prevent Vertex 429s`).toBeLessThanOrEqual(2)
})

test('REG-TOKEN-06-b: callGeminiGrounded retries 429s with exponential backoff + jitter (BKL-TOKEN-06)', () => {
  // BKL-TEST-P0-04c: 429 retry logic was extracted from callGeminiGrounded into
  // fetchGeminiWithRetry (gemini-fetch.ts). Verify the retry contract there.
  const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'gemini-fetch.ts'), 'utf-8')

  // (1) Must branch on HTTP 429 — the rate-limit signal
  expect(src, 'fetchGeminiWithRetry must detect res.status === 429').toMatch(/res\.status\s*!==?\s*429|status\s*===\s*429/)

  // (2) Must configure at least 2 retry attempts — current fix uses 4 (2s/4s/8s/16s)
  const retryLoop = src.match(/attempt\s*<=\s*(\d+)/)
  expect(retryLoop, 'retry loop with `attempt <= N` guard not found in 429 branch').toBeTruthy()
  const maxAttempts = parseInt(retryLoop![1], 10)
  expect(maxAttempts, `retry loop caps at ${maxAttempts} attempts — must be >= 2 to survive transient 429s`).toBeGreaterThanOrEqual(2)

  // (3) Must use exponential backoff (Math.pow(2, attempt) scaled to ms)
  expect(src, 'exponential backoff via Math.pow(2, attempt) missing from 429 retry').toMatch(/Math\.pow\(\s*2\s*,\s*attempt\s*\)/)

  // (4) Must add jitter so N concurrent 429s don't retry in lockstep
  expect(src, 'jitter via Math.random() missing from 429 retry delay').toMatch(/Math\.random\(\s*\)/)

  // (5) Must actually sleep in the retry path — setTimeout wrapped in a Promise
  expect(src, 'setTimeout-based sleep missing from 429 retry loop').toMatch(/setTimeout\(\s*r\s*,\s*delay\s*\)|new\s+Promise\([^)]*setTimeout/)

  // (6) Must throw a descriptive error when all retries are exhausted (not fall through silently)
  expect(src, 'no "429 after N retries" exhaustion error thrown — retries would fail silently').toMatch(/429\s+after\s+\d+\s+retries/i)
})

test('REG-TOKEN-06-c: 429 retry block uses AbortSignal.timeout >= 90s (BKL-TOKEN-08 interlock)', () => {
  // BKL-TEST-P0-04c: 429 retry logic was extracted into fetchGeminiWithRetry (gemini-fetch.ts).
  // The retry path uses buildInit() which creates AbortSignal.timeout(ctx.timeoutMs).
  // account-intelligence.ts passes timeoutMs: 120_000 which satisfies the >= 90s requirement.
  const aiSrc = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts'), 'utf-8')
  const fetchSrc = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'gemini-fetch.ts'), 'utf-8')

  // account-intelligence must pass timeoutMs >= 90_000 to fetchGeminiWithRetry
  const timeoutMatches = [...aiSrc.matchAll(/timeoutMs:\s*([\d_]+)/g)].map(m => parseInt(m[1].replace(/_/g, ''), 10))
  const grounded = timeoutMatches.filter(ms => ms >= 90_000)
  expect(grounded.length, 'account-intelligence.ts must pass timeoutMs >= 90_000 to fetchGeminiWithRetry').toBeGreaterThan(0)

  // gemini-fetch.ts must use timeoutMs to create AbortSignal.timeout per attempt (including retries)
  expect(fetchSrc, 'gemini-fetch.ts must use AbortSignal.timeout(ctx.timeoutMs) for each attempt').toContain('AbortSignal.timeout(ctx.timeoutMs)')
})
