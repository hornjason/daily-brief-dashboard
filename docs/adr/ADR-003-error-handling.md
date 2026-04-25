# ADR-003: Error Handling — No Silent Failures

**Date:** 2026-03-29
**Status:** Accepted
**Context:** Post-audit: 12+ silent `.catch(() => {})` swallowed errors in server.ts

---

## Context

During the March 2026 code review, 12+ locations in `server.ts` used `.catch(() => {})` — empty error handlers that discard exceptions without logging. Real failures (scraper crashes, sync errors, discovery failures) produced no output. The only symptom was that the dashboard showed stale data with no indication of why.

Example of what NOT to do:
```typescript
runRhScrapeWithState().catch(() => {})   // WRONG — crash is invisible
refreshCCSP().catch(() => {})            // WRONG — error silently dropped
```

---

## Decision

**All fire-and-forget async operations must log on error.** There are no exceptions.

### Rule 1: Background work functions must always log

```typescript
// CORRECT — error is visible in container logs
runRhScrapeWithState().catch((e: any) =>
  console.error('[rh-scraper] unhandled error:', e?.message ?? e)
)

refreshCCSP().catch((e: any) =>
  console.error('[refresh] CCSP failed:', e?.message ?? e)
)
```

Tag format: `[module-name] description: error message`

### Rule 2: Cleanup operations MAY be silenced

These are intentionally swallowed — a failure here doesn't change the outcome:
```typescript
await page.close().catch(() => {})                // cleanup — fine
getLivePage()?.goto('about:blank').catch(() => {}) // hide VNC — fine
```

### Rule 3: Request body parsing uses explicit fallback

```typescript
const body = await c.req.json().catch(() => ({}))  // fallback value — fine
```

### Rule 4: Errors inside try/catch blocks that would escape the outer handler

If an IIFE `(async () => { ... })()` has internal try/catch, the outer `.catch()` handles errors that escape the inner block. These should still log:

```typescript
;(async () => {
  for (const ae of aes) {
    try {
      await doWork(ae)  // inner catch handles per-item errors
    } catch (e: any) {
      console.warn(`[tag] ${ae.name} failed:`, e.message)
    }
  }
})().catch((e: any) => console.error('[tag] unexpected block error:', e?.message ?? e))
```

---

## Enforcement

Add these ESLint rules to `package.json` → `eslint` config:

```json
{
  "@typescript-eslint/no-empty-function": ["error", { "allow": [] }],
  "@typescript-eslint/no-floating-promises": "error"
}
```

`no-floating-promises` will catch any new `.catch(() => {})` that discards the error value. This turns the pattern into a compile-time failure rather than a runtime surprise.

---

## Category Reference

| Pattern | Action | Why |
|---|---|---|
| `runXxx().catch(() => {})` | CHANGE to log | Real work — failure is meaningful |
| `page.close().catch(() => {})` | KEEP silent | Cleanup — failure is irrelevant |
| `waitForLoadState().catch(() => {})` | KEEP silent | Best-effort wait — timeout is expected |
| `page.goto('about:blank').catch(() => {})` | KEEP silent | UI cleanup — not critical |
| `.catch(() => ({ default: 'value' }))` | KEEP — has fallback | Returns a meaningful value |

---

## Consequences

- All errors surface in `podman logs <container>` immediately
- Stale dashboard data now has an observable cause in logs
- Container health monitoring (Grafana/Alertmanager) can alert on error log patterns

---

## Related

- Silent failures fixed in commit `431a465` (T06, 12+ locations)
- ESLint setup pending (T-future: add `.eslintrc.json` + CI step)
