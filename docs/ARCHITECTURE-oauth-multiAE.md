> **SUPERSEDED** — The OAuth scope design described here (NORMAL_SCOPES / BOOTSTRAP_SCOPES two-tier model) is implemented and documented in `ARCHITECTURE.md` §7 (root). This file is the original design proposal; `ARCHITECTURE.md` is authoritative. Kept for historical rationale only.

# Architecture: OAuth Least-Privilege & Multi-AE Flow

**Date**: 2026-03-28
**Status**: Proposed
**Author**: Serena Blackwood (Architect Agent)

---

## Question 1: OAuth Least-Privilege Scope Flow

### The Fundamental Constraint

Google OAuth2 does not support "scope downgrade" on an existing token. When you request fewer scopes on re-auth, Google issues a new token with only the requested scopes -- but the old refresh token is invalidated. This means any scope transition is a full token replacement that breaks in-flight operations using the old token.

The second constraint: this is a single-user, single-container tool. There is no multi-tenant token isolation needed. The complexity budget should be near zero.

### Recommended Design: Scope-Aware Single Token with Lazy Downgrade

**Do NOT use two separate tokens.** Two tokens means two refresh cycles, two expiry checks, two failure modes, and an auth module that needs to know which operations use which token. For a single-user tool, this is over-engineering.

Instead:

#### 1. Define Two Scope Sets as Constants

```typescript
// src/oauth-scopes.ts
export const NORMAL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
] as const

export const BOOTSTRAP_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive',           // full drive for folder/sheet creation
  'https://www.googleapis.com/auth/spreadsheets',
] as const
```

**Key changes from current state:**
- `cloud-platform` scope removed entirely (not needed -- this was likely left over from early experimentation)
- `drive` downgraded to `drive.readonly` in normal mode
- `spreadsheets` stays in both modes (ongoing sync writes to AE sheets)

#### 2. Track Scope Level in the Token File

The `.google-token.json` already stores a `scope` string (space-separated). Add a `scopeLevel` field:

```typescript
interface StoredToken {
  access_token: string
  refresh_token: string
  scope: string              // Google-provided granted scopes
  token_type: string
  expiry_date: number
  configuredAt: string
  scopeLevel: 'normal' | 'bootstrap'  // NEW: which scope set was requested
}
```

Write `scopeLevel` at token save time based on which scope set was used for the auth URL. This avoids parsing the scope string (which Google may reorder or alias).

#### 3. Scope Check Function

```typescript
// src/oauth-scopes.ts
export function hasBootstrapScopes(token: StoredToken): boolean {
  const granted = new Set(token.scope.split(' '))
  return granted.has('https://www.googleapis.com/auth/drive')
    && !token.scope.includes('drive.readonly')
}

export function getScopeLevel(token: StoredToken): 'normal' | 'bootstrap' | 'unknown' {
  return token.scopeLevel ?? (hasBootstrapScopes(token) ? 'bootstrap' : 'normal')
}
```

#### 4. Modified `/oauth/start` Endpoint

```
GET /oauth/start?mode=bootstrap  -- requests BOOTSTRAP_SCOPES
GET /oauth/start?mode=normal     -- requests NORMAL_SCOPES (default)
GET /oauth/start                 -- requests NORMAL_SCOPES
```

The callback handler reads the `mode` from a cookie or state parameter and writes `scopeLevel` into the token.

#### 5. Bootstrap Guard

```typescript
// In bootstrap endpoints (e.g., POST /api/bootstrap/auto)
const token = JSON.parse(readFileSync(GOOGLE_UNIFIED_TOKEN_PATH, 'utf-8'))
if (!hasBootstrapScopes(token)) {
  return c.json({
    error: 'Bootstrap requires elevated Google permissions',
    action: 'redirect',
    url: '/oauth/start?mode=bootstrap'
  }, 403)
}
```

This is a soft guard. If the user already has full `drive` scope (as they do today), bootstrap works. If they've downgraded, they get a clear redirect.

#### 6. Post-Bootstrap Downgrade Flow

**Do NOT auto-redirect or force re-auth.** The user may want to bootstrap multiple AEs before downgrading. Instead:

1. After bootstrap completes, set a flag in config: `data/config/oauth-state.json`
   ```json
   { "pendingDowngrade": true, "bootstrapCompletedAt": "2026-03-28T15:00:00Z" }
   ```

2. The dashboard shows a persistent (but dismissable) banner:
   > "Your Google permissions include write access to Drive (used during setup). You can reduce permissions to read-only now that setup is complete. [Reduce Permissions] [Dismiss]"

3. "Reduce Permissions" links to `/oauth/start?mode=normal` which triggers re-auth with `NORMAL_SCOPES`.

4. If the user dismisses, the tool works fine -- it just has more permissions than strictly needed. This is the pragmatic tradeoff. Least-privilege is a goal, not a hard requirement for a single-user tool.

#### 7. Scrape Timer Handling During Re-Auth

**Do NOT pause/resume timers.** This adds fragile state management for a 10-second re-auth flow. Instead:

- When a scrape timer fires and the token is invalid/expired, it catches the error, logs it, and retries on the next cycle.
- The `makeAuth()` function already throws if the token file is missing. During re-auth, the old token file is overwritten atomically (write to `.tmp`, rename). The window of breakage is milliseconds.
- If a scrape is actively in-flight when the token changes, the in-flight request completes (it already has a valid access token in memory). The next request uses the new token.

**This is simpler and more robust than timer pause/resume.**

#### 8. Scope-to-API Mapping

| API Call | Scope Needed | Used In |
|----------|-------------|---------|
| Gmail messages.list/get | gmail.readonly | Normal: email scrape |
| Calendar events.list | calendar.readonly | Normal: calendar scrape |
| Drive files.list (read) | drive.readonly | Normal: Drive watcher, file listing |
| Drive files.create (folder) | drive (full) | Bootstrap only: AE folder creation |
| Sheets spreadsheets.create | spreadsheets | Bootstrap: sheet creation |
| Sheets spreadsheets.values.update | spreadsheets | Normal: ongoing sync writes |
| Sheets spreadsheets.get/values.get | spreadsheets | Normal: reading sheet data |

**Note:** `spreadsheets` scope covers both read and write. Google does not offer `spreadsheets.readonly` as a separate scope that also allows `spreadsheets.create`. The `spreadsheets` scope is needed in both modes because ongoing syncs write data to AE-owned sheets.

#### 9. What NOT to Do

- **Do not split into two OAuth clients** -- one client, two scope levels
- **Do not use incremental authorization** -- Google supports this but it only adds scopes, never removes them
- **Do not revoke the token programmatically** before re-auth -- this logs the user out of all Google services in the browser, terrible UX
- **Do not add a database for token management** -- the JSON file is fine for single-user

### Implementation Plan (Q1)

**Phase 1 (1-2 hours):** Create `src/oauth-scopes.ts` with scope constants and check functions. Modify `/oauth/start` to accept `?mode=` param. Write `scopeLevel` to token file in callback.

**Phase 2 (1 hour):** Add `/api/oauth/status` scope level to response. Add bootstrap guard to `POST /api/bootstrap/auto` and other bootstrap endpoints.

**Phase 3 (1-2 hours):** Add `oauth-state.json` tracking. Add dashboard banner component for pending downgrade. Wire "Reduce Permissions" button.

**Phase 4 (30 min):** Remove `cloud-platform` from all scope lists. Test full flow: fresh auth -> bootstrap -> downgrade -> verify scrapes still work.

---

## Question 2: Multi-AE Flow Architecture

### The Fundamental Constraints

1. **Playwright serialization**: One browser context, one page at a time for RH Portal / Salesforce / Tableau. This is the bottleneck. You cannot parallelize account discovery across AEs.

2. **Google API parallelism**: Drive folder creation, Sheets creation, and Sheets writes are all independent API calls. These CAN run in parallel (subject to rate limits -- Google allows ~10 req/sec for Drive API).

3. **Customer overlap**: If AE-A and AE-B both cover "Acme Corp", you only need to discover Acme's account numbers once. The discovery result is customer-scoped, not AE-scoped.

4. **Current data model mismatch**: `Customer.ae` is a string (single AE). Multi-AE ownership needs either an array or a junction.

### Recommended Design: Queue-Based Sequential Bootstrap with Customer Deduplication

#### 1. Data Model Changes

**AE type** -- add optional `team` field:

```typescript
export interface AE {
  name: string
  team?: string               // NEW: optional team grouping (e.g., "Northwest Pod")
  driveFolderId: string
  sfReportId?: string
  tableauTerritories?: string[]
  supportableSheetId?: string
  pipelineSheetId?: string
  ccspSheetId?: string
  bootstrapComplete?: boolean  // NEW: tracks if bootstrap finished successfully
}
```

**Customer type** -- change `ae` from string to string[]:

```typescript
export interface Customer {
  name: string
  domain?: string
  accountNumbers?: string[]
  ae?: string[]               // CHANGED: array of AE names (was: single string)
  segment?: string
  region?: string
  sheetTab?: string
  aliases?: string[]
  aliasDomains?: string[]
  skipAccountDiscovery?: boolean
}
```

**Migration**: On load, if `ae` is a string, wrap it in an array. This is backward compatible:

```typescript
// In customer loading code
const raw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
const customers = (raw.customers ?? []).map((c: any) => ({
  ...c,
  ae: Array.isArray(c.ae) ? c.ae : c.ae ? [c.ae] : []
}))
```

**Why NOT a separate join table or team config file?** Because:
- There are <10 AEs and <50 customers. A join table adds indirection for no performance gain.
- The `ae[]` array on Customer is the simplest representation of "which AEs cover this customer."
- A `team` field on AE is sufficient for grouping. No need for a separate team config file until there are multiple teams (there aren't).

#### 2. Bootstrap Queue Architecture

Replace the single `autoBootstrapState` global with a per-AE state map:

```typescript
const bootstrapQueue = new Map<string, AutoBootstrapState>()
let bootstrapRunning: string | null = null  // name of AE currently bootstrapping
const bootstrapPending: string[] = []       // queue of AE names waiting
```

**Why sequential, not parallel?**
- Account discovery uses Playwright (serial constraint)
- Supportable scrape uses Playwright (serial constraint)
- CCSP scrape uses Playwright (serial constraint)
- Pipeline scrape uses Playwright (serial constraint)
- Drive folder creation is the ONLY parallelizable step

Attempting to interleave Playwright operations between AEs would require multiple browser contexts or careful page management. The complexity is not worth it for a flow that runs once per AE.

**But: batch the customer deduplication step.** This is the key optimization.

#### 3. Optimized Multi-AE Bootstrap Flow

```
Team Bootstrap Request:
  Input: [{ aeName, sfReportId, tableauTerritories, customerNames }, ...]

Phase 1: Parallel (Google API only, no Playwright)
  - Create Drive folders for ALL AEs simultaneously
  - Deduplicate customer list across all AEs
  - Save AE configs to aes.json

Phase 2: Sequential (Playwright-bound, once per unique customer)
  - Discover account numbers for UNIQUE customers only
  - Save to customers.json with ae[] arrays
  - Each customer discovery updates ALL AEs that reference it

Phase 3: Sequential per-AE (Playwright-bound)
  For each AE in queue:
    - Create Supportable sheet (uses discovered account numbers)
    - Create CCSP sheet (Playwright -> Tableau)
    - Sync Pipeline sheet (Playwright -> Salesforce)
    - Mark AE bootstrapComplete = true
```

**Time estimate for 4 AEs with 10 customers each, 60% overlap:**
- Phase 1: ~5 seconds (parallel Drive API calls)
- Phase 2: ~24 unique customers x 90s = ~36 minutes (sequential, but shared)
- Phase 3: ~4 AEs x 3 min each = ~12 minutes
- Total: ~48 minutes (vs ~60+ minutes without dedup)

The real savings is in Phase 2 -- customer deduplication avoids redundant 90-second discovery cycles.

#### 4. API Endpoints

**New: Team bootstrap**
```
POST /api/bootstrap/team
Body: {
  teamName?: string,
  aes: [
    { aeName, sfReportId, tableauTerritories, customerNames, parentFolderId? },
    ...
  ]
}
Response: { started: true, aeCount: N }
```

**Modified: Per-AE status (backward compatible)**
```
GET /api/bootstrap/auto/status
Response (if single AE): { running, aeName, steps, error, completedAt }  // unchanged
Response (if team): {
  team: true,
  queue: [
    { aeName, status: 'pending' | 'running' | 'done' | 'error', steps, error },
    ...
  ],
  currentAe: string | null,
  phase: 'folders' | 'discovery' | 'sheets' | 'complete'
}
```

**Existing: Individual AE bootstrap (unchanged API, enhanced internals)**
```
POST /api/bootstrap/auto
Body: { aeName, sfReportId, tableauTerritories, customerNames, parentFolderId? }
```

This endpoint continues to work for single AE. Internally, it enqueues one AE into the same queue system.

#### 5. Bootstrap State Model

```typescript
interface AEBootstrapState {
  aeName: string
  status: 'queued' | 'running' | 'done' | 'error'
  steps: AutoBootstrapStep[]
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

interface TeamBootstrapState {
  teamName: string | null
  phase: 'init' | 'folders' | 'discovery' | 'sheets' | 'complete'
  aeStates: Map<string, AEBootstrapState>
  uniqueCustomers: string[]           // deduplicated customer list
  discoveredCustomers: string[]       // customers whose discovery is complete
  startedAt: string
  completedAt: string | null
}

let teamBootstrapState: TeamBootstrapState | null = null
```

#### 6. UI Design for Multi-AE Bootstrap

The dashboard setup wizard gets a new "Team Setup" tab (alongside existing individual setup):

```
+-------------------------------------------+
|  Team Bootstrap Progress                   |
+-------------------------------------------+
|  Phase 1: Creating Drive Folders     [===] |
|    Carolanne Farrell  [done]               |
|    Elmer Alvarez      [done]               |
|    Alex Rivera        [done]               |
|    Sam Chen           [done]               |
|                                            |
|  Phase 2: Account Discovery          [==  ]|
|    24 unique customers (from 40 total)     |
|    Discovering: Acme Corp (15/24)          |
|                                            |
|  Phase 3: AE Sheet Creation          [    ]|
|    Carolanne Farrell  [pending]            |
|    Elmer Alvarez      [pending]            |
|    Alex Rivera        [pending]            |
|    Sam Chen           [pending]            |
+-------------------------------------------+
```

Key UX decisions:
- Phase 2 shows CUSTOMER progress, not AE progress (because discovery is customer-scoped)
- Phase 3 shows AE progress (because sheet creation is AE-scoped)
- Each AE row is expandable to show individual step status
- "Add AE" button available even while bootstrap is running (enqueues)

#### 7. Customer Deduplication Logic

```typescript
function deduplicateCustomers(
  aeConfigs: Array<{ aeName: string; customerNames: string[] }>
): { uniqueCustomers: string[]; customerToAEs: Map<string, string[]> } {
  const customerToAEs = new Map<string, string[]>()

  for (const { aeName, customerNames } of aeConfigs) {
    for (const name of customerNames) {
      const normalized = name.trim().toLowerCase()
      const existing = customerToAEs.get(normalized) ?? []
      if (!existing.includes(aeName)) {
        customerToAEs.set(normalized, [...existing, aeName])
      }
    }
  }

  return {
    uniqueCustomers: [...customerToAEs.keys()],
    customerToAEs
  }
}
```

When a customer is discovered, their `ae` array in `customers.json` gets ALL AEs that reference them.

#### 8. Handling AE Deletion

When an AE is removed:
1. Remove AE from `aes.json`
2. For each customer with that AE in their `ae[]` array, remove the AE name
3. If a customer's `ae[]` becomes empty, keep the customer record (they still have account numbers, domain, etc.) but mark them as unassigned
4. Do NOT delete Drive folders or sheets -- the user may want to reference historical data

#### 9. Scrape Timer Changes

Current timers likely iterate once. For multi-AE, each timer iterates over all AEs:

```typescript
// Supportable sync timer
async function runSupportableSync() {
  for (const ae of aes) {
    if (!ae.supportableSheetId) continue
    const aeCustomers = customers.filter(c => c.ae?.includes(ae.name))
    // ... run scrape for this AE's customers and sheet
  }
}
```

This is the minimal change. Each AE's scrape is independent and sequential (sharing the same Playwright context).

#### 10. What NOT to Do

- **Do not create a separate process per AE** -- one Bun process, one Playwright browser, sequential operations
- **Do not use a real message queue** (Redis, RabbitMQ) -- an in-memory array is fine for <10 AEs
- **Do not create a "team" config file** -- the `team` field on AE is sufficient until multiple teams exist
- **Do not allow concurrent Playwright operations** -- the browser context will corrupt; sequential is correct
- **Do not split customers.json into per-AE files** -- one file with `ae[]` arrays is simpler and prevents desync

### Implementation Plan (Q2)

**Phase 1 (2-3 hours):** Data model migration. Change `Customer.ae` from `string` to `string[]` with backward-compatible loading. Add `team` and `bootstrapComplete` to AE type. Update all code that reads `customer.ae` (about 8-10 files).

**Phase 2 (2-3 hours):** Bootstrap queue. Refactor `autoBootstrapState` to `Map<string, AEBootstrapState>`. Implement `POST /api/bootstrap/team` endpoint. Add customer deduplication. Keep `POST /api/bootstrap/auto` working for single AE.

**Phase 3 (3-4 hours):** UI. Team setup tab in wizard. Multi-AE progress dashboard. Per-phase progress indicators.

**Phase 4 (1-2 hours):** Scrape timer iteration. Update all scrape timers to iterate over AEs. Test with 2+ AEs.

**Phase 5 (1 hour):** Integration test. Run team bootstrap for 2 AEs with overlapping customers. Verify dedup, sheet creation, and ongoing scrapes.

---

## Combined Implementation Order

These two features are independent and can be implemented in either order. However, Q1 (OAuth) is simpler and provides immediate security value. Recommended order:

1. **Q1 first** -- tighten scopes, get the banner UX working
2. **Q2 Phase 1** -- data model migration (foundational, unblocks everything)
3. **Q2 Phases 2-5** -- multi-AE bootstrap

Total estimated effort: 12-16 hours of implementation across both features.
