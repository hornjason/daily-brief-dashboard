---
Last validated: 2026-04-24
---

# ADR-005: Code Organization — Prevent Monolithic Files

**Date:** 2026-03-29
**Status:** Accepted
**Context:** server.ts reached 3,600 lines / 80 endpoints with no architectural boundary

---

## Context

`server.ts` grew from a single-file prototype to 3,600 lines containing 80 HTTP endpoints, 6 background job functions, 3 scraper orchestrators, shared state management, and utility functions. The growth was gradual — each PR added ~50 lines to what was already working. No automated check stopped the accumulation.

The consequences:
- Silent failures were invisible because the file was too large to review carefully
- Race conditions accumulated because the write-path pattern wasn't obvious at scale
- New contributors repeated wrong patterns because correct patterns were buried on line 2,800
- Refactoring became risky because everything was tangled together

---

## Decision

### Rule 1: Max 500 lines per source file

No TypeScript file in `src/` or as a top-level server entry may exceed 500 lines. Exceptions require explicit ADR amendment.

Enforced via CI (`scripts/check-file-size.sh`):
```bash
#!/bin/bash
# Fail if any .ts file (excluding node_modules, test-results) exceeds 500 lines
THRESHOLD=500
FAILED=0
while IFS= read -r file; do
  lines=$(wc -l < "$file")
  if [ "$lines" -gt "$THRESHOLD" ]; then
    echo "FAIL: $file has $lines lines (max $THRESHOLD)"
    FAILED=1
  fi
done < <(find . -name "*.ts" \
  -not -path "*/node_modules/*" \
  -not -path "*/test-results/*" \
  -not -path "*/.claude/*" \
  -not -name "*.spec.ts")
exit $FAILED
```

### Rule 2: Route modules live in `src/routes/`

When `server.ts` is refactored (scheduled as T15), each domain becomes its own route file:

```
src/routes/
  aes.ts          — GET/POST /api/aes, AE config management
  auth-redhat.ts  — /api/auth/redhat/* endpoints
  auth-salesforce.ts — /api/auth/salesforce/* endpoints
  bootstrap.ts    — /api/bootstrap/* endpoints
  customers.ts    — /api/customers/* endpoints
  dashboard.ts    — /api/dashboard/* data endpoints
  territory.ts    — /api/territory-lookup
```

Each route file imports shared state from `src/state.ts` and exports a Hono sub-router.

### Rule 3: Shared state in `src/state.ts`

All module-level variables (`aes`, `customers`, `autoBootstrapState`, `lastScraped`, etc.) live in `src/state.ts` and are exported. Route modules import what they need. No global state in `server.ts` itself.

### Rule 4: One utility, one place

Shared utility functions (`fmtCurrency`, `normalizeCustomerName`, `timeAgo`) live in:
- Frontend: `dashboard/src/lib/format.ts` (exists)
- Backend: `src/lib/fmt.ts` (to be created during T15 refactor)

Never copy-paste a utility into a component. If a function appears twice, extract it.

---

## Refactor Plan (T15)

The monolith refactor happens AFTER all bug fixes are committed — tests must pass before restructuring. Sequence:

1. Create `src/state.ts` — export all module-level state variables
2. For each domain, create `src/routes/<domain>.ts`:
   - Move endpoints
   - Import state from `src/state.ts`
   - Export `const router = new Hono()`
3. In `server.ts`, import and mount each router:
   ```typescript
   app.route('/api/aes', aesRouter)
   app.route('/api/auth/redhat', authRhRouter)
   // etc.
   ```
4. Verify: `bun run test:e2e` must pass after each route is moved
5. Final `server.ts` should be <200 lines (setup, middleware, mounts, startup)

---

## Consequences

- New features must be added to the appropriate route module
- PRs that push a file over 500 lines will fail CI
- The 500-line gate forces the developer to ask "where does this actually belong?" before adding code
- `server.ts` will gradually shrink as the T15 refactor proceeds

---

## Related

- T15 monolith refactor scheduled (after Phase 3 bug fixes complete)
- `fmtCurrency` extracted to `dashboard/src/lib/format.ts` in `9b28e6e`
- ESLint enforcement of complexity rules pending (ADR-003)
