---
doc-type: reference
status: active
owner: jason
updated: 2026-05-15
---

# Module Developer Guide

How to build a new feature module for the DailyBriefDashboard. Follow this guide to ensure your module integrates with the registry, admin panel, signal stack, and all content generation surfaces.

## The FeatureModule Contract

Every module implements this interface (`src/feature-module-registry.ts`):

```typescript
interface FeatureModule {
  name: string                                    // unique identifier
  cachePaths: (slug: string) => string[]           // cache file paths
  driveArtifacts?: (slug: string) => string[]      // Drive folder paths
  notebookSources?: boolean                        // NotebookLM sync
  refreshInterval?: number | null                  // ms between refreshes (null = on-demand)
  fetch: (customerName: string) => Promise<void>   // pull fresh data
  cleanup: (customerName: string) => Promise<void>  // remove archived customer data
  syncNow: (customerName: string) => Promise<void>  // manual trigger (Refresh button)
  signals?: (customerSlug: string) => Promise<Signal[]>  // contribute to signal stack
}
```

## Signal Interface

```typescript
interface Signal {
  source: string           // your module name
  type: SignalType         // one of 13 types (see below)
  headline: string         // short summary
  detail: string           // full content
  score?: number           // 0-1 normalized (optional)
  timestamp: string        // ISO 8601
  url?: string             // link to source
  metadata?: Record<string, unknown>  // per-type extras
}

type SignalType =
  | 'news' | 'intelligence' | 'expansion' | 'subscription'
  | 'case' | 'email' | 'meeting' | 'product-release'
  | 'event' | 'product-intel' | 'account-plan' | 'competitive' | 'brief'
```

## Step-by-Step: Building a New Module

### 1. Create the fetcher (`src/my-fetcher.ts`)

```typescript
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'my-data')

export async function fetchMyData(): Promise<void> {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true })
  }

  // Fetch from your data source
  // Write to cache
  writeFileSync(resolve(CACHE_DIR, 'data.json'), JSON.stringify(data), { mode: 0o600 })
}
```

**Path rules:**
- Cache files: use `process.env.CACHE_DIR ?? 'data/cache'`
- Config files: use `process.env.CONFIG_DIR ?? 'data/config'`
- Never use `process.env.DATA_DIR` — it's undefined in containers

### 2. Create the module (`src/modules/my-module.ts`)

```typescript
import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { fetchMyData } from '../my-fetcher.ts'

FeatureModuleRegistry.register({
  name: 'my-module',
  cachePaths: (slug) => [`data/cache/my-data/${slug}.json`],
  refreshInterval: 4 * 60 * 60 * 1000,  // every 4 hours (null = on-demand)

  async fetch(customerName) {
    await fetchMyData()
  },

  async cleanup(customerName) {
    // Delete cache files for this customer
  },

  async syncNow(customerName) {
    await fetchMyData()
  },

  async signals(customerSlug): Promise<Signal[]> {
    // Read cache, return Signal[] with appropriate type and score
    return [{
      source: 'my-module',
      type: 'news',        // pick the right SignalType
      headline: '...',
      detail: '...',
      score: 0.7,          // 0-1 normalized
      timestamp: new Date().toISOString(),
    }]
  },
})
```

### 3. Register in server.ts

Add a side-effect import:
```typescript
import './src/modules/my-module.ts'
```

### 4. Add a scheduler (optional)

In `src/background-scheduler.ts`, add a timer function:
```typescript
export function scheduleMyModuleRefresh(): void {
  const INTERVAL = 4 * 60 * 60 * 1000  // 4 hours
  setTimeout(async () => {
    const module = FeatureModuleRegistry.get('my-module')
    if (module) await module.fetch('_global')
    scheduleMyModuleRefresh()
  }, INTERVAL)
}
```

Call it in `server.ts`.

## What You Get for Free

By registering your module, these surfaces automatically consume your signals:

| Surface | How | File |
|---------|-----|------|
| **Intelligence tab** | `collectAllSignals()` → per-customer signals | `IntelligenceTab.tsx` |
| **Red Hat Pulse card** | Global intelligence aggregation | `RedHatPulseCard.tsx` |
| **Morning brief** | Top signals in Gemini synthesis prompt | `brief-pipeline.ts` |
| **Campaign generation** | Registry signals enrich Gemini prompts | `campaigns-routes.ts` |
| **MeetingPrep skill** | `collectAllSignals()` for meeting context | PAI skill |
| **Admin panel** | Module status, health, Sync Now button | `AdminPage.tsx` |
| **Sync Now API** | `POST /api/customer/:name/modules/:moduleName/sync` | `feature-module-routes.ts` |
| **Startup catch-up** | Missed scheduled runs recovered on restart | `feature-module-registry.ts` |

## Existing Modules

| Module | Signal Type | Refresh | Cache Location |
|--------|------------|---------|----------------|
| `news-radar` | `news` | Daily 5:30am | `cache/news/{slug}.json` |
| `product-lifecycle` | `product-release` | Weekly | Reads from `cache/product-intel/` |
| `rh-rss` | `news` | Every 4h | `cache/rss/rh-feeds.json` |
| `rh-events` | `event` | Weekly | `cache/events/rh-events.json` |
| `campaigns` | — | On-demand | `cache/campaigns/{slug}.json` |
| `tools` | — | On-demand | `cache/tools/{slug}.json` |

## Shared Utilities Available

| Utility | Import | Purpose |
|---------|--------|---------|
| `toSlug(name)` | `./cache-layer` | Name → cache-safe slug |
| `makeAuth()` | `./google` | Google OAuth client |
| Drive client | `./lib/drive-client` | Folder traversal, file listing |
| `getGeminiModel()` | `./ai-config` | Current Gemini model |
| `getGeminiToken()` | `./gemini-auth` | Vertex AI access token |
| `recordGeminiUsage()` | `./gemini-cost-tracker` | Cost tracking |
| `getAccountTeam(customer)` | `./account-team` | Team members for a customer |
| `normalizeSettings()` | `./region-config` | Region/territory mapping |
| `sanitizeErr(e)` | `./utils` | Safe error strings for API responses |

## Quality Checklist

Before shipping a new module:

- [ ] Registers via `FeatureModuleRegistry.register()`
- [ ] `fetch()` actually refreshes from source (not just re-reads cache)
- [ ] `syncNow()` triggers a real refresh (this is what Refresh buttons call)
- [ ] `recordOutcome()` called after fetch/sync operations
- [ ] `refreshInterval` set appropriately (enables automatic scheduling)
- [ ] `signals()` returns useful, scored, timestamped Signal[] data
- [ ] `cleanup()` removes all cached data for archived customers
- [ ] Cache paths use `CACHE_DIR` (never `DATA_DIR`)
- [ ] Config paths use `CONFIG_DIR` (never `DATA_DIR`)
- [ ] Error handling: partial failures logged but don't block other operations
- [ ] Unit tests cover signal generation and edge cases
- [ ] `tsc --noEmit` clean
- [ ] `bun test test/unit/` all pass

## ADRs

- **ADR-020** — Feature Module Registry (why this pattern)
- **ADR-021** — Signal contract and auto-discovery (flat bag vs discriminated union)
