# W3-12: Product Intelligence Hub — Architecture Design

**Date:** 2026-04-04 (revised 2026-04-05/06)
**Author:** Serena Blackwood (Architect Agent)
**Status:** Phase 1 complete, Phase 2 complete, Phase 3 complete (feature injection + talking points)

---

## Problem Statement

Jason needs product-level intelligence for RHEL, OpenShift, OpenShift Virtualization, Ansible Automation Platform, RHEL AI, AI Inference, and OpenShift AI — latest releases, Tech Previews, roadmap signals, and "What's Next" deck content — synthesized by Gemini and surfaced both as standalone product pages and integrated into customer briefs when the customer has that product in their subscriptions.

**Products (7):** `rhel`, `ocp`, `ocp-virt`, `aap`, `rhel-ai`, `rh-ai-inference`, `rhoai`

The existing intelligence pipeline (`account-intelligence.ts`) handles per-customer company/industry analysis. This feature adds a per-product dimension that is orthogonal to accounts but must intersect with them at brief generation time.

---

## Fundamental Constraints

1. **No feature-level API exists.** Red Hat does not publish a structured API for release notes, tech previews, or deprecations. Data lives in HTML on docs.redhat.com (see `docs/research-redhat-product-data-apis.md`).
2. **docs.redhat.com uses client-side rendering.** Simple HTTP GET returns boilerplate. Content requires Playwright or PDF download.
3. **Gemini API is not Gemini API.** This project uses Vertex AI Gemini endpoint (`callGeminiGrounded` in `account-intelligence.ts`). No Gemini API keys — Google Cloud project + service account.
4. **Container-only architecture.** All scraping runs inside the `pai-dashboard` Podman container. No host cron.
5. **Single shared BrowserContext.** Playwright browser context is shared across all scrapers. Product doc scraping must respect the scraper queue (`background-scheduler.ts` queue) to avoid context collision.
6. **No Gemini API (Google AI Studio).** The `feedback_no_gemini_api.md` memory says Gemini API is not allowed at Red Hat. We use Vertex AI endpoint exclusively — this is already the pattern in `account-intelligence.ts`.

---

## 1. Data Pipeline

### 1A. docs.redhat.com Scraping

**Strategy: PDF download over Playwright rendering.**

The research doc confirms PDF URLs are stable and bypass the client-side rendering problem entirely. PDFs are already parseable via `unpdf` (already a dependency — used in `customer.ts` line 4). This avoids adding Playwright page loads to the shared browser context, which is the highest-risk constraint.

**URL patterns (confirmed working in research):**

```
# RHEL release notes
https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/pdf/9.{minor}_release_notes/Red_Hat_Enterprise_Linux-9-9.{minor}_Release_Notes-en-US.pdf

# OCP release notes (single-page HTML is more structured for OCP)
https://docs.redhat.com/en/documentation/openshift_container_platform/4.{minor}/html/release_notes/ocp-4-{minor}-release-notes

# AAP release notes
https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.{minor}/html-single/release_notes/index
```

**For OCP and AAP HTML pages:** Use `fetch()` + Playwright only as fallback if static fetch returns empty content. Enqueue via `enqueueScraperTask()` to respect the shared browser context.

**Version discovery:** Call the Life Cycle Data API (no auth, confirmed working) to get the current version list for each product. Diff against last known versions to detect new releases.

```
GET https://access.redhat.com/product-life-cycles/api/v1/products?name=Red%20Hat%20Enterprise%20Linux
GET https://access.redhat.com/product-life-cycles/api/v1/products?name=OpenShift%20Container%20Platform%204
GET https://access.redhat.com/product-life-cycles/api/v1/products?name=Red%20Hat%20Ansible%20Automation%20Platform
```

**AAP Atom feed:** `https://announcements.ansiblecloud.redhat.com/feed.atom` provides structured announcements. Parse as XML, extract entries. No auth required.

### 1B. Google Drive "What's Next" Drops

Jason drops Markdown files into a Drive folder per product. The pipeline needs to:

1. Read a configured Drive folder ID per product (stored in `data/config/product-intel-config.json`)
2. List files modified since last sync
3. Read Markdown content via Drive export API (same pattern as `fetchCustomerDocs` in `customer.ts`)
4. Store raw content in the product intelligence cache

**Drive reading uses the existing `makeAuth(GDRIVE_TOKEN_PATH)` pattern** — no new OAuth scopes needed (Drive read is already in `NORMAL_SCOPES`).

### 1C. Ingestion Flow

```
                         Life Cycle API (versions)
                                |
                                v
     +------------------+  version diff  +-------------------+
     | product-intel-   | ------------> | Scrape new release |
     | scheduler.ts     |               | notes (PDF/HTML)   |
     |  (runs on timer  |               +-------------------+
     |   or on-demand)  |                        |
     +------------------+               +-------------------+
            |                           | Parse via unpdf   |
            |                           | or HTML extract   |
            |                           +-------------------+
            |                                    |
            v                                    v
     +------------------+              +-------------------+
     | Drive: list new  |              | Raw text stored   |
     | .md files per    | -----------> | per product per   |
     | product folder   |              | version in cache  |
     +------------------+              +-------------------+
                                                |
                                                v
                                       +-------------------+
                                       | Gemini synthesis  |
                                       | per product       |
                                       +-------------------+
                                                |
                                                v
                                       +-------------------+
                                       | product-intel     |
                                       | cache JSON        |
                                       +-------------------+
```

---

## 2. Storage / Cache Schema

### 2A. Product Intelligence Config

**File:** `data/config/product-intel-config.json`

```typescript
interface ProductIntelConfig {
  products: ProductDef[]
  lastFullRefresh?: string   // ISO timestamp
}

interface ProductDef {
  slug: string               // "rhel" | "openshift" | "aap"
  displayName: string        // "Red Hat Enterprise Linux"
  lifecycleApiName: string   // exact name for Life Cycle API query
  docBaseUrls: string[]      // URL templates with {minor} placeholder
  driveFolderId?: string     // Drive folder for "What's Next" drops
  refreshIntervalHours: number  // default 24
}
```

**Seed with seven products:** RHEL, OCP, OCP Virt, AAP, RHEL AI, AI Inference, OpenShift AI. New products added by editing this JSON (admin page can expose this later).

**Drive corpus is optional (Phase 2):** `driveFolderId` is `string | null`. Products without a Drive folder use release-notes-only synthesis — the ingest step is skipped gracefully.

### 2B. Product Intelligence Cache

**Directory:** `data/cache/product-intel/`

**Per-product summary (Gemini output):**
`data/cache/product-intel/{slug}-summary.json`

```typescript
interface ProductIntelSummary {
  slug: string
  displayName: string
  generatedAt: string        // ISO timestamp
  currentVersion: string     // e.g. "9.7", "4.21", "2.6"
  latestGADate: string       // from Life Cycle API
  eolDate?: string           // end of full support

  // Gemini-synthesized sections
  releaseHighlights: string  // markdown: top features in latest release
  techPreviews: string       // markdown: active tech previews
  roadmapSignals: string     // markdown: from What's Next decks + announcements
  deprecations: string       // markdown: deprecated features

  // Source tracking
  sources: ProductIntelSource[]
}

interface ProductIntelSource {
  type: "release_notes" | "tech_preview" | "whats_next" | "atom_feed" | "lifecycle_api"
  version?: string
  url?: string
  fetchedAt: string
  contentHash: string        // SHA-256 of raw content — skip re-synthesis if unchanged
}
```

**Per-version raw content (pre-synthesis):**
`data/cache/product-intel/{slug}-{version}-raw.json`

```typescript
interface ProductVersionRaw {
  slug: string
  version: string
  fetchedAt: string
  releaseNotesText?: string   // extracted from PDF/HTML
  techPreviewText?: string
  deprecationsText?: string
  driveDrops?: DriveDropContent[]
  atomEntries?: AtomEntry[]
}

interface DriveDropContent {
  fileId: string
  fileName: string
  modifiedTime: string
  content: string             // markdown text
}

interface AtomEntry {
  id: string
  title: string
  updated: string
  content: string
}
```

### 2C. Chat History (Phase 3)

`data/cache/product-intel/{slug}-chat.json`

```typescript
interface ProductChatHistory {
  slug: string
  conversations: ChatConversation[]
}

interface ChatConversation {
  id: string                  // UUID
  startedAt: string
  messages: ChatMessage[]
}

interface ChatMessage {
  role: "user" | "assistant"
  content: string
  timestamp: string
  tokenCount?: number         // for cost tracking
}
```

**Decision: Conversation history, not stateless.** A product Q&A session benefits from follow-up questions ("What about the networking changes?" after asking about RHEL 9.7). But cap at 10 messages per conversation and auto-start a new conversation after 1 hour of inactivity. This bounds token costs while enabling natural follow-up.

---

## 3. Gemini Integration

### 3A. Product Synthesis Prompt

This is fundamentally different from account intelligence synthesis. Account intelligence uses Google Search grounding to find external information. Product intelligence synthesizes known internal content — no grounding needed.

**Use `callGeminiGrounded` without the `google_search` tool** — or create a parallel `callGemini` (non-grounded) function. Grounding adds latency and cost with no benefit when the source material is already in the prompt.

```typescript
// New function in product-intelligence.ts
async function callGeminiDirect(opts: {
  systemPrompt: string
  userPrompt: string
  maxOutputTokens?: number
  temperature?: number
  callType?: string
}): Promise<string> {
  // Same as callGeminiGrounded but WITHOUT the tools: [{ google_search: {} }] field
  // Records usage via recordGeminiUsage with callType 'product-intel-*'
}
```

**Product synthesis system prompt:**

```
You are a Red Hat product intelligence analyst. You synthesize release notes,
tech preview documentation, and roadmap signals into concise, actionable
summaries for Account Solution Architects.

Rules:
1. Organize by impact to customer conversations, not by component.
2. Lead with what's NEW in the latest release.
3. Clearly distinguish GA features vs Tech Preview vs Deprecated.
4. For Tech Previews, note expected GA timeline if mentioned in source material.
5. For deprecations, note the removal timeline and migration path.
6. Flag features relevant to competitive positioning (vs VMware, vs AWS, vs Terraform).
7. Keep each section under 300 words. Bullet points preferred.
8. Cite version numbers for every feature mentioned.
```

**Product synthesis user prompt:**

```xml
<product>
  <name>{displayName}</name>
  <current_version>{currentVersion}</current_version>
  <ga_date>{latestGADate}</ga_date>
  <eol_date>{eolDate}</eol_date>
</product>

<source type="release_notes" version="{version}">
{releaseNotesText}
</source>

<source type="tech_previews" version="{version}">
{techPreviewText}
</source>

<source type="deprecations" version="{version}">
{deprecationsText}
</source>

<source type="whats_next_decks" count="{n}">
{driveDropContent}
</source>

<source type="announcements" count="{n}">
{atomEntries}
</source>

<task>
Generate a product intelligence summary with these sections:

## Release Highlights
Top 5-8 features from the latest release, ranked by customer conversation impact.

## Tech Previews to Watch
Active tech previews with expected GA timeline and customer relevance.

## Roadmap Signals
Forward-looking signals from What's Next decks and announcements.

## Deprecations & Migration
Features being deprecated with timelines and recommended alternatives.

## Competitive Positioning
How these changes position Red Hat vs key competitors (VMware, AWS, Terraform, Kubernetes upstream).
</task>
```

### 3B. Chat Prompt (Phase 3)

```
You are a Red Hat product expert for {displayName}. Answer questions using
ONLY the product intelligence data provided below. If the answer is not in the
provided data, say so explicitly — do not guess.

<context>
{productIntelSummary}
{relevantRawContent}  <!-- most recent 2 versions of raw content -->
</context>

<conversation_history>
{previous messages in this conversation}
</conversation_history>
```

**Token budget:** System prompt + context (~4K-8K tokens) + conversation history (capped at ~4K tokens) + user question. Total per-call budget: ~16K input tokens. Well within Gemini 2.5 Flash limits.

### 3C. Account Intelligence vs Product Intelligence — Prompt Differences

| Dimension | Account Intelligence | Product Intelligence |
|-----------|---------------------|---------------------|
| Grounding | Google Search (external) | None (internal content) |
| Temperature | 1.0 (creative, exploratory) | 0.3 (factual, precise) |
| Max tokens | 16384 (long-form) | 4096 (concise summary) |
| Refresh trigger | On-demand per customer | Version release or schedule |
| Source | Web search | PDF/HTML/Drive/Atom |
| Cost tracking callType | `intelligence-company` | `product-intel-synthesis` |

---

## 4. Brief Integration

### 4A. The Intersection: Customer Subscriptions x Product Intelligence

The existing `ProductSubscription` type in `types.ts` has `productDescription` and `sku` fields. The brief pipeline already receives subscription data in XML format. The integration point is in `buildXmlSources()` in `customer.ts`.

**Matching logic:**

```typescript
// Map product slugs to subscription SKU/description patterns
const PRODUCT_MATCHERS: Record<string, RegExp> = {
  rhel: /red hat enterprise linux|rhel/i,
  openshift: /openshift|ocp/i,
  aap: /ansible automation platform|aap/i,
}

function matchProductsForCustomer(subscriptions: ProductSubscription[]): string[] {
  const matched: string[] = []
  for (const [slug, pattern] of Object.entries(PRODUCT_MATCHERS)) {
    if (subscriptions.some(s => pattern.test(s.productDescription) || pattern.test(s.sku))) {
      matched.push(slug)
    }
  }
  return matched
}
```

### 4B. Brief XML Extension

In `buildXmlSources()`, after the existing `<source type="account_intelligence">` block, add product intelligence for matched products:

```xml
<source type="product_intelligence" product="rhel" version="9.7" generated="{generatedAt}">
## Release Highlights
- Feature X enables Y...
## Tech Previews
- Feature Z is in Tech Preview...
</source>

<source type="product_intelligence" product="openshift" version="4.21" generated="{generatedAt}">
...
</source>
```

**Only include for products the customer actually has subscriptions for.** Do not include product intelligence for products the customer does not use. This prevents brief bloat and keeps the delta-first focus.

### 4C. Synthesis Prompt Update

Add to the existing `SYNTHESIS_PROMPT` in `brief-pipeline.ts`:

```
- If product intelligence sources are present, include a "## Product Updates" section
  ONLY for updates relevant to this specific customer's usage patterns.
- Do NOT repeat the full product summary — highlight only items that affect this customer.
- Example: if customer has RHEL 8.x subscriptions and RHEL 9.7 has a migration tool,
  mention it. If customer is already on 9.7, skip version announcements.
```

---

## 5. Phasing

### Phase 1: Scrape + Summary (3-4 days)

**Deliverables:**
- `src/product-intelligence.ts` — core module: Life Cycle API integration, PDF/HTML scraping, Gemini synthesis, cache read/write
- `src/product-intel-routes.ts` — API endpoints: `GET /api/products` (list), `GET /api/products/:slug` (summary), `POST /api/products/:slug/refresh` (on-demand)
- `data/config/product-intel-config.json` — seed config for RHEL, OCP, AAP
- `data/cache/product-intel/` — cache directory
- Dashboard: product cards on a new "Products" tab showing current version, GA date, EOL date, and Gemini summary
- Scheduler integration: add product intel refresh to `background-scheduler.ts` (daily at 6 AM, or configurable)

**Tasks:**
1. [P] Create `product-intelligence.ts` with Life Cycle API client
2. [P] Create PDF download + `unpdf` extraction pipeline
3. [P] Create HTML fallback extraction for OCP/AAP
4. [ ] Wire Gemini synthesis (non-grounded `callGeminiDirect`)
5. [ ] Create cache layer functions in `cache-layer.ts` (or keep in module)
6. [ ] Create `product-intel-routes.ts` with 3 endpoints
7. [ ] Register routes in `server.ts`
8. [P] Dashboard: Products tab with product cards
9. [ ] Scheduler: daily product intel refresh
10. [ ] Test: verify PDF extraction, Gemini synthesis, API endpoints

### Phase 2: Drive Drops + Expanded Products (COMPLETE 2026-04-05)

**Deliverables:**
- Drive corpus made optional — products without `driveFolder` use release-notes-only synthesis
- Expanded from 3 products (RHEL, OCP, AAP) to 7: added OCP Virt, RHEL AI, AI Inference, OpenShift AI
- `product-drive-ingest.ts`: Drive folder listing + Markdown/doc content ingestion
- `ProductIntelSection.tsx` updated to all 7 slugs
- Products page: Option A "Unified Stream" layout (FeatureFilterBar + SpotlightStrip + FeatureListRow + FeatureDetailPanel)
- `SECTION_CAP` 3500→6000, `TOTAL_CAP` 9000→18000 in `product-feature-radar.ts`

### Phase 3: Feature Radar Injection into Customer Intel (COMPLETE 2026-04-06)

**Deliverables (as implemented — differs from original design):**
- Feature radar (`{slug}-features.json`) injected into `generateCustomerProductIntel()` prompt as structured block (4000-char cap)
- New `featureTalkingPoints` field on `CustomerProductIntel` — top 3-5 features ranked by customer relevance, each with `reason` + `signalSource` anchored to a specific customer signal
- Content hash now includes `productFeaturesHash` (corpusHash) for precise cache invalidation when corpus changes
- `product-intel-routes.ts`: loads `getFeatureCache(slug)` before calling generation; passes `productFeatures` + `productFeaturesHash`
- `driveFolder` guard removed from generate route — Drive is optional per Phase 2
- Account intel caps expanded: company 2000→6000 chars, industry 1000→2000 chars
- Bootstrap wizard: Product Intelligence scaffold shown only for first AE (`knownAes.length === 0`)

**Note:** Chat interface (`POST /api/products/:slug/chat`, `ProductChat.tsx`) was descoped from Phase 3. Feature injection into `buildXmlSources()` / brief pipeline (original §4B plan) was also descoped — product intelligence is surfaced via `CustomerProductIntel.featureTalkingPoints` instead, not injected as a brief XML source block.

---

## 6. Risks and Constraints

### R1: docs.redhat.com Rate Limiting

**Risk:** Aggressive scraping triggers rate limits or IP blocks.
**Mitigation:**
- PDF download is a single request per version per product. With 3 products and ~5 active versions each, that is 15 requests per refresh cycle. Negligible load.
- Use `If-Modified-Since` headers and `contentHash` to skip re-download.
- Minimum 2-second delay between requests.
- Daily refresh is sufficient — releases happen monthly at most.

### R2: Token Costs

**Risk:** Gemini synthesis of large release notes PDFs.
**Estimate per refresh cycle:**
- 3 products x 1 synthesis call = 3 calls
- Input: ~8K-12K tokens per product (release notes text)
- Output: ~2K tokens per product (summary)
- Cost: ~$0.003-0.005 per product per synthesis at Gemini 2.5 Flash rates
- Total per daily cycle: ~$0.01-0.015
- Chat: ~$0.001-0.003 per question

**Mitigation:** `contentHash` comparison skips re-synthesis when source content unchanged. Most days, no synthesis runs at all. Record all calls via `recordGeminiUsage()`.

### R3: Cache Invalidation

**Strategy:** Three invalidation triggers:
1. **Version-based:** Life Cycle API returns a new version number. Fetch new content, synthesize.
2. **Content-based:** `contentHash` of raw content changes (page updated without version bump). Re-synthesize.
3. **Time-based:** Force re-synthesis after `refreshIntervalHours` (default 24h) even if no change detected. Catches Atom feed updates and Drive drops.
4. **Manual:** `POST /api/products/:slug/refresh` with `force=true`.

### R4: Shared Browser Context Contention

**Risk:** If Playwright is needed for HTML pages, it competes with scraper queue.
**Mitigation:** PDF-first strategy avoids Playwright for RHEL entirely. For OCP/AAP, try static `fetch()` first. Only fall back to Playwright via `enqueueScraperTask()` if static fetch returns empty. In practice, the `html-single` URL pattern for AAP returns server-rendered content.

### R5: Drive Folder Discovery

**Risk:** Jason creates product folders in various locations.
**Mitigation:** Explicit folder ID configuration per product in `product-intel-config.json`. No fuzzy matching. Jason provides the folder ID once (or uses an admin page picker in Phase 2).

### R6: Subscription Matching Accuracy

**Risk:** SKU/description patterns miss products or false-match.
**Mitigation:** The `PRODUCT_MATCHERS` regex map is conservative. Start with exact known patterns from existing subscription data. Log unmatched subscriptions for tuning. Allow admin override: customer can be manually tagged with products.

---

## 7. New Files Needed

| File | Purpose |
|------|---------|
| `src/product-intelligence.ts` | Core module: Life Cycle API client, PDF/HTML scraping, Gemini synthesis, cache management. Contains `callGeminiDirect()` (non-grounded), `fetchLifecycleVersions()`, `scrapeReleaseNotes()`, `synthesizeProductSummary()`, `refreshProductIntel()`. |
| `src/product-intel-routes.ts` | Hono route handlers: `GET /api/products`, `GET /api/products/:slug`, `POST /api/products/:slug/refresh`, `POST /api/products/:slug/chat` (Phase 3). |
| `data/config/product-intel-config.json` | Seed config with RHEL, OCP, AAP definitions including doc URLs, lifecycle API names, refresh intervals. |
| `dashboard/src/pages/ProductsPage.tsx` | Products listing page with cards showing version, status, summary excerpt. |
| `dashboard/src/pages/ProductDetailPage.tsx` | Single product view: full Gemini summary, chat box (Phase 3). |
| `dashboard/src/components/ProductChat.tsx` | Chat component for Phase 3: message list, input box, send button. |
| `test/api/product-intel.spec.ts` | API tests for product intelligence endpoints. |

**Modified files (no new files):**

| File | Change |
|------|--------|
| `src/server.ts` | Register `product-intel-routes.ts` |
| `src/cache-layer.ts` | Add `readProductIntelCache()`, `writeProductIntelCache()` (or keep in module) |
| `src/background-scheduler.ts` | Add product intel refresh to scheduled tasks |
| `src/customer.ts` (`buildXmlSources`) | Add `<source type="product_intelligence">` blocks for matched products |
| `src/brief-pipeline.ts` | Update `SYNTHESIS_PROMPT` with product intelligence instructions |
| `src/gemini-cost-tracker.ts` | New callTypes: `product-intel-synthesis`, `product-intel-chat` |
| `dashboard/src/App.tsx` | Add Products route |
| `dashboard/src/components/Sidebar.tsx` | Add Products nav item |

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | PDF-first over Playwright for docs.redhat.com | Avoids shared browser context contention. PDFs are stable, `unpdf` is already a dependency. |
| D2 | Non-grounded Gemini for product synthesis | Source content is already in the prompt. Google Search grounding adds cost and latency with no benefit. |
| D3 | Per-product config file, not hardcoded | Jason may add products (RHEL AI, OpenShift Virtualization). Config-driven is future-proof. |
| D4 | Subscription-based brief integration | Only surfaces product intel when customer has active subscriptions. Prevents brief bloat. |
| D5 | Conversation history for chat (not stateless) | Product Q&A benefits from follow-ups. Capped at 10 messages + 1-hour TTL. |
| D6 | Life Cycle API for version discovery | Free, no auth, returns exact version list with dates. Eliminates manual version tracking. |
| D7 | contentHash for synthesis dedup | SHA-256 of raw content prevents re-synthesizing unchanged docs. Most days, zero Gemini calls. |
| D8 | Temperature 0.3 for product synthesis | Factual precision over creativity. Account intel uses 1.0 because it's exploratory. |

---

## Open Questions for Jason

1. **Which Drive folder structure?** One parent folder with subfolders per product (e.g. `Product Intel/RHEL/`, `Product Intel/OpenShift/`)? Or three separate folders?
2. **Additional products beyond RHEL/OCP/AAP?** RHEL AI, OpenShift Virtualization, and Service Mesh are in the Life Cycle API. Should we seed them in config?
3. **Chat history persistence across container rebuilds?** Currently `data/cache/` is volume-mounted, so chat history survives rebuilds. Confirm this is acceptable vs ephemeral.
4. **Product page in dashboard navigation:** Separate top-level tab, or nested under an existing section?
