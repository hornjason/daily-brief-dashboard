---
doc-type: guide
status: active
owner: jason
updated: 2026-05-20
---

# Feature Module Developer Guide

**The ONE document to read before building a new feature module.**

This guide walks through creating a new data source, signal producer, or scheduled task using the Feature Module Registry pattern. Whether you're adding a customer intelligence source, an admin tool, or a new scheduled sync — this is your starting point.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [The Three-Layer Architecture](#the-three-layer-architecture)
3. [Step-by-Step: Creating a New Module](#step-by-step-creating-a-new-module)
4. [The 6 Pre-Flight Questions](#the-6-pre-flight-questions)
5. [Anti-Patterns](#anti-patterns)
6. [Reference](#reference)

---

## Quick Start

### What is a feature module?

A self-contained unit of functionality that registers itself with the Feature Module Registry at server startup. It can:
- Produce signals (customer-specific intelligence)
- Schedule recurring tasks (daily sync, weekly refresh)
- Declare UI navigation (nav links, customer tabs)
- Manage its own cache and Drive artifacts

### What does the registry give you for free?

1. **Centralized scoring** — You provide `rawRelevance` + metadata, the registry calculates final scores based on specificity (customer/industry/general) and metadata boosters
2. **Automatic scheduling** — Declare `refreshInterval`, the scheduler runs your refresh automatically
3. **Pre-flight refresh** — Implement `ensureFresh()` + `cacheTtlMs`, all consumers auto-refresh your data before generating content
4. **Admin visibility** — Your module appears in the admin dashboard with status, compliance checks, and manual refresh buttons
5. **Template routing** — Signals route to the right template sections automatically based on metadata keys
6. **Navigation** — Declare `nav` and/or `accountTab`, your UI surfaces appear automatically

### What are the layers?

- **Layer 1: Signal producers** — Modules emit `rawRelevance` + metadata, registry scores them
- **Layer 2: Template engine** — Routes scored signals into deterministic markdown sections
- **Layer 3: Thin consumers** — Call `templateAll()` to get formatted output, add narrative via Gemini

---

## The Three-Layer Architecture

Every feature in this project follows three architectural layers. Understanding this flow is critical to building a compliant module.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Signal Producers (Your Module)                    │
│                                                             │
│  signals() {                                                │
│    return [{                                                │
│      source: 'my-module',                                   │
│      type: 'competitive',                                   │
│      headline: 'Company evaluating OpenShift',              │
│      detail: '...',                                         │
│      rawRelevance: 0.85,  ← NOT score! (0-1 within domain) │
│      metadata: {                                            │
│        customerSlug: 'acme-corp',                           │
│        redHatProducts: ['OpenShift'],                       │
│        confidence: 'HIGH',                                  │
│        context: 'evaluating'                                │
│      }                                                       │
│    }]                                                        │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Registry: scoreSignal()                                     │
│                                                             │
│  1. Detect specificity from metadata:                       │
│     - has customerSlug → customer tier (0.50-1.00)          │
│     - has industryMatch → industry tier (0.35-0.69)         │
│     - else → general tier (0.10-0.35)                       │
│                                                             │
│  2. Apply boosters:                                         │
│     - redHatProducts non-empty: +0.10                       │
│     - confidence: HIGH: +0.05                               │
│     - context: evaluating: +0.10                            │
│                                                             │
│  3. Clamp to tier range:                                    │
│     baseScore = 0.50 + (0.85 × 0.50) = 0.925                │
│     + boosters = 0.925 + 0.25 = 1.00 (capped)               │
│                                                             │
│  Final: score: 1.00 (Critical tier)                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Template Engine                                   │
│                                                             │
│  routeSignal(signal):                                       │
│    - Has redHatProducts → Product Alignment section         │
│    - Has provider/hasCloudSpend → Cloud Marketplace         │
│    - Has severity/caseNumber → Cases                        │
│    - Has renewal/closeDate → Renewals                       │
│    - Has confidence + context(eval) → Tech Stack            │
│                                                             │
│  templateAll(signals, team, { format: 'brief' }):           │
│    deterministic: "## Product Alignment\n..."               │
│    narrativeContext: "Top 10 signals for Gemini..."         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Thin Consumers                                     │
│                                                             │
│  const { deterministic, narrativeContext } =                │
│    templateAll(signals, team, { format: 'playbook' })       │
│                                                             │
│  const geminiOutput = await callGemini({                    │
│    systemPrompt: deterministic + narrativeContext,          │
│    userPrompt: 'Generate strategic position...'             │
│  })                                                          │
└─────────────────────────────────────────────────────────────┘
```

### Key principles:

1. **Modules NEVER set `score` directly** — only `rawRelevance` + metadata
2. **Template sections are deterministic** — no Gemini prompt engineering for data display
3. **Consumers are thin** — they call `templateAll()` and optionally add Gemini narrative

---

## Step-by-Step: Creating a New Module

Let's walk through creating a hypothetical **Competitive Intel Module** that scrapes competitor mentions from industry news.

### Step 1: Create the module file

**File:** `src/modules/competitive-intel-module.ts`

```typescript
/**
 * Competitive Intel Module
 * Tracks competitor mentions and customer evaluation signals.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const COMPETITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// ── Types ────────────────────────────────────────────────────

interface CompetitorMention {
  competitor: string
  context: string
  date: string
  sourceUrl?: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

// ── Cache helpers ────────────────────────────────────────────

function getCachePath(customerSlug: string): string {
  return resolve(CACHE_DIR, `competitive/${customerSlug}.json`)
}

function isCacheFresh(customerSlug: string): boolean {
  const path = getCachePath(customerSlug)
  if (!existsSync(path)) return false

  try {
    const stat = statSync(path)
    return Date.now() - stat.mtimeMs < COMPETITIVE_TTL_MS
  } catch {
    return false
  }
}

async function refreshCompetitiveIntel(customerSlug: string): Promise<void> {
  // Your actual scraping/API logic here
  const mentions: CompetitorMention[] = await scrapeCompetitorMentions(customerSlug)

  const entry = {
    mentions,
    lastUpdated: new Date().toISOString(),
  }

  const path = getCachePath(customerSlug)
  writeFileSync(path, JSON.stringify(entry, null, 2), { mode: 0o600 })
}

// ── Module registration ──────────────────────────────────────

FeatureModuleRegistry.register({
  // ── Identity ───────────────────────────────────────────────
  name: 'competitive-intel',
  displayName: 'Competitive Intelligence',

  // ── Scope ──────────────────────────────────────────────────
  // 'customer' = per-customer only
  // 'portfolio' = portfolio-wide only
  // 'both' = can operate at both levels
  scope: 'customer',

  // ── UI Navigation ──────────────────────────────────────────
  // Optional: add a global nav link
  nav: {
    label: 'Competitive Intel',
    icon: 'TrendingUp',  // Lucide icon name
    group: 'intelligence',  // Groups: 'portfolio' | 'intelligence' | 'operations' | 'admin'
    path: '/dashboard/competitive',
    order: 30,  // Sort order within group
  },

  // Optional: add a tab to customer detail pages
  accountTab: {
    label: 'Competitive',
    icon: 'TrendingUp',
    order: 30,
  },

  // ── Endpoints ──────────────────────────────────────────────
  // Optional: manual refresh endpoint
  refreshEndpoint: '/api/refresh/competitive',

  // ── Cache management ───────────────────────────────────────
  // Return paths to this module's cache files for cleanup
  cachePaths: (customerSlug: string) => [
    `data/cache/competitive/${customerSlug}.json`,
  ],

  // How long data is considered fresh (pre-flight refresh uses this)
  cacheTtlMs: COMPETITIVE_TTL_MS,

  // ── Drive artifacts ────────────────────────────────────────
  // Optional: if this module writes to Google Drive
  driveArtifacts: (customerSlug: string) => [
    `${customerSlug}/competitive/`,
  ],

  // ── NotebookLM integration ─────────────────────────────────
  // Optional: if this data should be included in NotebookLM sources
  notebookSources: true,

  // ── Scheduling ─────────────────────────────────────────────
  // Optional: auto-refresh interval (in milliseconds)
  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // Weekly

  // ── Pre-flight refresh ─────────────────────────────────────
  // CRITICAL: Implement this if you produce signals with cached data
  async ensureFresh(customerSlug: string): Promise<void> {
    if (isCacheFresh(customerSlug)) {
      return  // Cache is fresh, nothing to do
    }

    // Cache is stale or missing — trigger refresh
    await refreshCompetitiveIntel(customerSlug)
  },

  // ── Signal production ──────────────────────────────────────
  // CRITICAL: This is what consumers see
  async signals(customerSlug: string): Promise<Signal[]> {
    const path = getCachePath(customerSlug)
    if (!existsSync(path)) return []

    let data: { mentions: CompetitorMention[]; lastUpdated: string }
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return []
    }

    if (!data.mentions || data.mentions.length === 0) return []

    return data.mentions.map(m => ({
      // ── Required fields ──────────────────────────────────────
      source: 'competitive-intel',
      type: 'competitive' as const,
      headline: `${m.competitor} evaluation detected`,
      detail: m.context,
      timestamp: m.date,

      // ── NEVER set score directly! Use rawRelevance instead ───
      rawRelevance: m.confidence === 'HIGH' ? 0.9 :
                    m.confidence === 'MEDIUM' ? 0.7 : 0.5,

      // ── Optional fields ──────────────────────────────────────
      url: m.sourceUrl,

      // ── Metadata (drives scoring + routing) ──────────────────
      metadata: {
        // REQUIRED for customer-tier scoring (0.50-1.00 range)
        customerSlug,

        // Boosters (see ADR-027 for full list):
        confidence: m.confidence,  // HIGH: +0.05
        context: 'evaluating',     // evaluating: +0.10
        redHatProducts: ['OpenShift'],  // non-empty: +0.10

        // Custom fields for your domain
        competitor: m.competitor,
      },
    }))
  },

  // ── Legacy hooks (implement as needed) ────────────────────
  async fetch(): Promise<void> {
    // Called by manual refresh endpoint if declared
    // For customer-scoped modules, this is usually a no-op
    // (refresh happens per-customer via ensureFresh)
  },

  async cleanup(customerSlug: string): Promise<void> {
    // Called when a customer is deleted
    const path = getCachePath(customerSlug)
    if (existsSync(path)) {
      unlinkSync(path)
    }
  },

  async syncNow(customerSlug: string): Promise<void> {
    // Called by admin "Sync Now" button
    await refreshCompetitiveIntel(customerSlug)
  },
})
```

### Step 2: Register the module

**The module registers itself at import time** — just importing the file registers it.

**In `src/server.ts`:**

```typescript
// Import all feature modules (order doesn't matter)
import './modules/news-module.ts'
import './modules/emails-module.ts'
import './modules/competitive-intel-module.ts'  // ← Add this line
// ... other modules
```

That's it. No manual registry calls. The module is now live.

### Step 3: Add signals with metadata

Your `signals()` function returns an array of `Signal` objects. Each signal MUST include:

#### Required fields:
- `source` — Your module name (e.g., `'competitive-intel'`)
- `type` — Signal classification (see `SignalType` in `feature-module-registry.ts`)
- `headline` — Short summary (used in UI lists)
- `detail` — Full content (used in templates and Gemini prompts)
- `rawRelevance` — 0-1 within-domain ranking (NOT the final score!)
- `timestamp` — ISO 8601 date

#### Metadata for scoring:

The registry examines `metadata` to determine **specificity** and apply **boosters**.

**Specificity detection** (determines score range):
- `customer` tier (0.50-1.00): has `customerSlug`, `accountNumber`, `severity`, or `acvPlus`
- `industry` tier (0.35-0.69): has `industryMatch`
- `general` tier (0.10-0.35): neither

**Boosters** (applied after specificity):
- `redHatProducts` non-empty: +0.10
- `acvPlus` or `amount` > 0: +0.10
- `confidence: 'HIGH'`: +0.05
- `confidence: 'LOW'`: -0.10
- `context: 'evaluating' | 'migrating_from'`: +0.10
- `severity: 1`: +0.15, `severity: 2`: +0.10
- `endDate` within 90 days: +0.10
- `hasCloudSpend: true`: +0.10

**Metadata routing keys** (determines which template section):

Signals auto-route to template sections based on these metadata keys (priority order):

1. `hasCloudSpend` OR `provider` → **Cloud Marketplace**
2. `severity` OR `caseNumber` → **Cases**
3. `renewal` OR (`stage` + `closeDate`) → **Renewals**
4. `infrastructure` OR (`confidence` + `context` with eval/migrate keywords) → **Tech Stack**
5. `redHatProducts` OR `product` → **Product Alignment**
6. Fallback: source name

**Example:**

```typescript
metadata: {
  customerSlug: 'acme-corp',        // ← customer tier (0.50-1.00)
  redHatProducts: ['OpenShift'],    // ← +0.10 booster, routes to Product Alignment
  confidence: 'HIGH',               // ← +0.05 booster
  context: 'evaluating',            // ← +0.10 booster, routes to Tech Stack
  competitor: 'VMware',             // ← custom field for your module
}
```

With `rawRelevance: 0.85`:
- Base: 0.50 + (0.85 × 0.50) = 0.925
- Boosters: +0.10 (products) +0.05 (confidence) +0.10 (context) = +0.25
- Final: min(1.00, 0.925 + 0.25) = **1.00** (Critical tier)

### Step 4: Add ensureFresh (pre-flight refresh)

If your module produces signals with cached data, you MUST implement `ensureFresh()` + `cacheTtlMs`.

**Why?** Before generating any content (playbook, brief, campaign, meeting prep), the system calls `loadCustomerSignals({ ensureFresh: true })`. This triggers a parallel refresh of ALL modules that implement `ensureFresh()`. Your module gets auto-discovered — no hardcoded lists.

**Pattern:**

```typescript
cacheTtlMs: 7 * 24 * 60 * 60 * 1000,  // 7 days

async ensureFresh(customerSlug: string): Promise<void> {
  // 1. Check if cache exists and is fresh
  if (isCacheFresh(customerSlug)) {
    return  // Cache is fresh, nothing to do
  }

  // 2. Cache is stale or missing — refresh it
  await refreshCompetitiveIntel(customerSlug)
}
```

**What happens if you skip this?**

Consumers will generate content with stale or missing data. The system won't know your data needs refreshing. Your module will appear in the admin compliance report as "advisory" (missing `ensureFresh`).

### Step 5: Add scheduling (optional)

If your module needs to run on a schedule (daily, weekly, interval), declare `refreshInterval`:

```typescript
refreshInterval: 24 * 60 * 60 * 1000,  // Daily (24 hours in ms)
```

The scheduler registry will:
1. Auto-discover your module at startup
2. Create a scheduled task named `feature-module:competitive-intel`
3. Run your `syncNow()` function at the specified interval
4. Track last run, next run, and errors
5. Show status in the admin dashboard

**Examples:**

- Daily: `24 * 60 * 60 * 1000`
- Weekly: `7 * 24 * 60 * 60 * 1000`
- Every 4 hours: `4 * 60 * 60 * 1000`

**What runs?**

The scheduler calls your module's `syncNow()` function. For customer-scoped modules, you typically iterate all customers:

```typescript
async syncNow(): Promise<void> {
  const { customers } = await import('../server-state.ts')
  for (const customer of customers) {
    const slug = toSlug(customer.name)
    await refreshCompetitiveIntel(slug)
  }
}
```

### Step 6: Verify

Run these checks before declaring your module complete:

#### 1. Signal debug endpoint

```bash
curl http://localhost:7777/api/customer/acme-corp/signals/debug | jq
```

Look for your module's signals in the output. Verify:
- `score` is in the expected range (0.50-1.00 for customer-tier)
- `metadata` includes all the fields you set
- Signals appear in the right tier (Critical/High/Medium/Low/Noise)

#### 2. Compliance check

```bash
curl http://localhost:7777/api/modules/compliance | jq
```

Your module should appear in the `compliant` array if it has `ensureFresh()` + `cacheTtlMs`. If it's in `advisory`, you're missing pre-flight refresh.

#### 3. Scheduler status

```bash
curl http://localhost:7777/api/admin/scheduler-status | jq
```

If you declared `refreshInterval`, your module should appear with `lastRun`, `nextRun`, and `state`.

#### 4. Admin page

Open `http://localhost:7777/dashboard/admin`

- **Feature Modules section:** Your module should appear with a status badge
- **Scheduler section:** Your scheduled task should appear if you declared `refreshInterval`
- **Manual refresh:** Click "Refresh Now" to trigger `syncNow()` — verify it works

#### 5. Template routing

Generate a customer brief or playbook and verify your signals appear in the correct section:

```bash
curl http://localhost:7777/api/customer/acme-corp/playbook | jq
```

Look for your signal content in the deterministic sections (Product Alignment, Tech Stack, etc.).

---

## The 6 Pre-Flight Questions

**Answer these BEFORE writing code.** If you can't answer them, you're not ready to build.

### 1. Is this a producer, consumer, or both?

- **Producer** → Implement `signals()` with `rawRelevance` + metadata
- **Consumer** → Call `templateAll()` from signal-templates.ts
- **Both** → Do both

Most modules are **producers only**. Consumers are rare (playbook, brief, campaign, meeting-prep are the only ones).

### 2. What metadata does this emit?

Map every metadata field to ADR-027 boosters and routing keys.

**Example:**

| Field | Purpose | Effect |
|-------|---------|--------|
| `customerSlug` | Specificity detection | Customer tier (0.50-1.00) |
| `redHatProducts` | Booster + routing | +0.10, routes to Product Alignment |
| `confidence` | Booster | HIGH: +0.05, LOW: -0.10 |
| `context` | Booster + routing | evaluating: +0.10, routes to Tech Stack |

If you're missing `customerSlug`, your signals will score as `general` tier (0.10-0.35) — probably not what you want.

### 3. Which template section does this data belong in?

Trace the routing logic in `signal-templates.ts`:

1. `hasCloudSpend` / `provider` → Cloud & Marketplace
2. `severity` / `caseNumber` → Cases
3. `renewal` / `stage` / `closeDate` → Renewals & Pipeline
4. `confidence` / `context` / `infrastructure` → Tech Stack
5. `redHatProducts` / `product` → Product Alignment
6. Fallback: source name

If your signal doesn't match any of these, it won't appear in deterministic sections. You may need to:
- Add a routing case to `routeSignal()` in signal-templates.ts
- Add a new template function (e.g., `templateCompetitive()`)
- Wire it into `templateAll()`

### 4. Does every consumer that should see this data actually see it?

Trace the signal through the template engine to each consumer output:

1. Your module produces signals with metadata
2. Registry scores them based on specificity + boosters
3. `templateAll()` routes them to sections
4. Consumers call `templateAll()` with different formats

Verify with the debug endpoint:

```bash
curl http://localhost:7777/api/customer/acme-corp/signals/debug | jq '.signals[] | select(.source == "your-module")'
```

### 5. What happens when this data is missing or stale?

Module health guards should flag it. Admin page should show actionable fix.

**For missing data:**
- Does your module return `[]` from `signals()` when cache is empty?
- Does the admin page show a warning?
- Is there a "Refresh Now" button?

**For stale data:**
- Does `ensureFresh()` check cache age correctly?
- Does it trigger a refresh when stale?
- Does the pre-flight refresh system discover your module?

### 6. Does this module implement `ensureFresh()`?

**If it produces signals with a cache, it MUST implement `ensureFresh()` + `cacheTtlMs`.**

No module should be invisible to the refresh system. Consumers generate content with `{ ensureFresh: true }` — if your module isn't refreshed, it's broken.

---

## Anti-Patterns

### ❌ Hardcoding `score` in a module

```typescript
// WRONG
return [{
  source: 'my-module',
  type: 'competitive',
  headline: '...',
  score: 0.85,  // ❌ Don't do this!
}]

// RIGHT
return [{
  source: 'my-module',
  type: 'competitive',
  headline: '...',
  rawRelevance: 0.85,  // ✅ Let the registry score
  metadata: {
    customerSlug: 'acme-corp',
    confidence: 'HIGH',
  },
}]
```

**Why?** The registry calculates scores based on specificity and boosters. Hardcoding breaks the centralized scoring contract.

### ❌ Adding signal type to a Gemini prompt instruction

```typescript
// WRONG — prompt engineering for deterministic data
const prompt = `
Generate a competitive analysis.
Include these competitors: ${competitorList}
`

// RIGHT — template it
const { deterministic } = templateAll(signals, team, { format: 'playbook' })
const prompt = `
${deterministic}

Generate a strategic position based on the competitive signals above.
`
```

**Why?** Deterministic data (competitor names, product names, ACV values) should be templated, not sent to Gemini for editorial judgment.

### ❌ Building a consumer that assembles its own signal context

```typescript
// WRONG
const signals = await collectAllSignals(customerSlug, customerName)
const competitiveSignals = signals.filter(s => s.source === 'competitive-intel')
const promptContext = competitiveSignals.map(s => `- ${s.headline}`).join('\n')

// RIGHT
const { deterministic, narrativeContext } = templateAll(signals, team, { format: 'brief' })
const promptContext = deterministic + '\n\n' + narrativeContext
```

**Why?** The template engine handles routing, formatting, and section grouping. Consumers should call `templateAll()`, not build their own.

### ❌ Creating a feature without answering the 5 pre-flight questions

You'll end up with:
- Signals that don't score correctly
- Data that doesn't appear in the right sections
- Modules invisible to the refresh system
- Missing admin visibility

### ❌ Shipping without checking the signal debug endpoint

You won't know if your signals are scoring correctly until you check:

```bash
curl http://localhost:7777/api/customer/acme-corp/signals/debug | jq
```

### ❌ Building a module with cached data but no `ensureFresh()`

Consumers will generate content with stale or missing data. Your module will appear in the admin compliance report as "advisory".

### ❌ Hardcoding refresh sources in signal-loader

```typescript
// WRONG — hardcoded list
const modulesToRefresh = ['emails', 'news-radar', 'competitive-intel']

// RIGHT — auto-discovery
const modules = FeatureModuleRegistry.getRegisteredModules()
for (const module of modules) {
  if (module.ensureFresh) {
    await module.ensureFresh(customerSlug)
  }
}
```

**Why?** The registry is the single source of truth. New modules should auto-participate.

---

## Reference

### Architecture Documentation

- **ARCHITECTURE.md §22-§28** — Signal scoring, template engine, pre-flight refresh, compliance gates
- **PRINCIPLES.md** — The three layers, pre-flight questions, anti-patterns
- **ADR-027** — `docs/adr/ADR-027-universal-signal-scoring-contract.md` — Full scoring spec
- **ADR-028** — Scheduler registry design (daily/weekly/interval tasks)

### Code References

- **Registry interface:** `src/feature-module-registry.ts` — `FeatureModule` interface, `scoreSignal()` function
- **Template engine:** `src/lib/signal-templates.ts` — `templateAll()`, routing logic, section builders
- **Signal loader:** `src/lib/signal-loader.ts` — `ensureSignalsCurrent()`, pre-flight refresh
- **Scheduler:** `src/scheduler-registry.ts` — `ScheduleEntry` interface, timer management

### Example Modules

- **Emails module:** `src/modules/emails-module.ts` — Minimal compliant module with `ensureFresh()`
- **News module:** `src/modules/news-module.ts` — Full-featured module with nav, tab, scheduling
- **Cloud marketplace:** `src/modules/cloud-marketplace-module.ts` — Complex signal routing example
- **Intelligence:** `src/modules/intelligence-module.ts` — Multi-stage pipeline with Drive writes

### Debug Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/customer/:name/signals/debug` | View all signals with scores, tiers, metadata |
| `GET /api/modules/compliance` | Check module compliance (ensureFresh coverage) |
| `GET /api/admin/scheduler-status` | View scheduled task status |
| `GET /api/feature-modules/nav` | View registered nav links and tabs |

### Signal Types

From `feature-module-registry.ts`:

```typescript
type SignalType =
  | 'news' | 'intelligence' | 'expansion' | 'subscription'
  | 'case' | 'email' | 'meeting' | 'product-release'
  | 'event' | 'product-intel' | 'account-plan' | 'competitive' | 'brief'
  | 'cloud-spend' | 'qualification-gap' | 'technology'
```

### Metadata Boosters (ADR-027)

| Metadata Field | Booster | Notes |
|----------------|---------|-------|
| `redHatProducts` (non-empty) | +0.10 | Array of product names |
| `acvPlus` > 0 OR `amount` > 0 | +0.10 | Numeric value |
| `confidence: 'HIGH'` | +0.05 | String literal |
| `confidence: 'LOW'` | -0.10 | Penalty for low confidence |
| `context: 'evaluating'` | +0.10 | Evaluation phase |
| `context: 'migrating_from'` | +0.10 | Migration signal |
| `severity: 1` | +0.15 | Critical severity |
| `severity: 2` | +0.10 | High severity |
| `endDate` within 90 days | +0.10 | Urgency booster |
| `hasCloudSpend: true` | +0.10 | Cloud usage detected |

### Specificity Tiers

| Tier | Range | Detection | Example |
|------|-------|-----------|---------|
| Customer | 0.50-1.00 | has `customerSlug`, `accountNumber`, `severity`, or `acvPlus` | Support case, subscription data |
| Industry | 0.35-0.69 | has `industryMatch` | Industry news, sector trends |
| General | 0.10-0.35 | Neither | Generic product news, broad announcements |

---

## Quick Checklist

Before shipping your module, verify:

- [ ] `signals()` returns `rawRelevance` + metadata (NOT `score`)
- [ ] Metadata includes `customerSlug` (for customer-tier scoring)
- [ ] Metadata includes routing keys (for template sections)
- [ ] `ensureFresh()` + `cacheTtlMs` implemented (if cached data)
- [ ] `cachePaths()` returns accurate paths (for cleanup)
- [ ] `refreshInterval` declared (if scheduled refresh needed)
- [ ] Module imported in `server.ts`
- [ ] Signal debug endpoint shows correct scores
- [ ] Compliance endpoint shows module as compliant (not advisory)
- [ ] Admin page shows module status
- [ ] Template sections include your signals
- [ ] All 6 pre-flight questions answered

---

**Last updated:** 2026-05-20
**Reference implementation:** `src/modules/emails-module.ts`, `src/modules/news-module.ts`
