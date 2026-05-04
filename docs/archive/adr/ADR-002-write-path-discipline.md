# ADR-002: Write-Path Discipline for Shared State

**Date:** 2026-03-29
**Status:** Accepted
**Context:** Post-incident review after tableauTerritories stripping bug (March 2026)

---

## Context

`server.ts` maintains two in-memory arrays loaded at startup: `aes[]` and `customers[]`. These are the source of truth while the server is running and are persisted to `data/config/aes.json` / `data/config/customers.json`.

Multiple async request handlers modify these arrays. Bun/Node.js is single-threaded but async operations yield to the event loop between `await` calls. The following race pattern caused real bugs:

```typescript
// UNSAFE — classic async race
const updated = aes.map(a => a.name === aeName ? { ...a, field: value } : a)
//                                ↑ snapshot of stale aes at time T
await someAsyncOperation()       // ← yields; another handler may call saveAes()
saveAes(updated)                 // ← writes T snapshot, clobbering other handler's changes
```

This caused `tableauTerritories` and other server-managed fields to be silently stripped when the Edit/View wizard saved AE config — the wizard snapshot didn't include fields added by background processes.

---

## Decision

**All write paths that modify a single AE field after an `await` must use `patchAe(name, fields)`**, not `saveAes(aes.map(...))`.

```typescript
// SAFE — reads fresh from disk before writing
patchAe(aeName, { supportableSheetId: sheetId })
```

`patchAe()` (defined in `server.ts`):
1. Reads `aes.json` fresh from disk (not from in-memory `aes`)
2. Merges the patch fields using spread (`{ ...existing, ...fields }`)
3. Writes atomically via `.tmp` + `renameSync`
4. Updates the in-memory `aes` array

**Use `saveAes(updated)` only when:**
- Building the full AE array explicitly (e.g., `POST /api/aes` wizard save)
- The operation is synchronous with no `await` between reading `aes` and writing

**The `customers` array** follows the same rule. High-risk writes (bootstrap discovery callback, import) use the tmp-file atomic write pattern already in place. If a `patchCustomer()` equivalent is needed, follow the same pattern as `patchAe()`.

---

## Write-Path Checklist

Before adding any code that writes to `aes` or `customers`:

- [ ] Is there an `await` between reading the array and writing back?
  → **Yes**: Use `patchAe()` / load-fresh-merge-write pattern
  → **No**: `saveAes(aes.map(...))` is fine
- [ ] Does the write path have a `.tmp` intermediate file + atomic rename?
  → **Yes**: Good — crash-safe
  → **No**: Add it
- [ ] Does the write path update the in-memory array after the disk write?
  → **Yes**: Good
  → **No**: Add `aes = updated` / `customers = updated` after the rename

---

## Consequences

- Concurrent bootstrap runs or simultaneous saves cannot clobber each other's field updates
- The `patchAe` call is slightly slower (disk read) but this code only runs during async bootstrapping where the extra millisecond is irrelevant
- Single-field patches are more expressive than full-array rebuilds — intent is clearer

---

## Related

- `tableauTerritories` stripping: fixed in commit `2f7d2e6` (wizard save) and hardened by `patchAe` in `ab93c3c`
- `patchAe()` added in `ab93c3c` covering 4 high-risk bootstrap/sync write paths
