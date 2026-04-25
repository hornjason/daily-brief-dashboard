# Research: Red Hat Product Feature Data - Programmatic Access

**Date:** 2026-04-01
**Researcher:** Ava Sterling (Claude Researcher)
**Scope:** AAP, OCP, RHEL - release notes, features, tech previews, roadmap data

---

## Executive Summary

Red Hat provides **no single unified API for product features and release notes**. However, a multi-source strategy combining three APIs, structured HTML scraping, Atom feeds, and AI augmentation can deliver comprehensive product intelligence. The highest-value approach is a hybrid: use the Life Cycle API for version/date tracking, scrape docs.redhat.com release notes for feature data, and use Gemini with Google Search grounding for summarization and matching.

---

## A. Structured Data Sources

### 1. Red Hat Product Life Cycle Data API (CONFIRMED WORKING)

**The single most valuable API for this use case.**

- **Endpoint:** `https://access.redhat.com/product-life-cycles/api/v1/products`
- **Auth:** None required (public API)
- **Format:** JSON (also supports XML)
- **Documentation:** https://docs.redhat.com/en/documentation/red_hat_product_life_cycle_data_api/1.0/html-single/red_hat_product_life_cycle_data_api/index

**What it provides:**
- Product names and UUIDs
- All version numbers per product
- Lifecycle phases with exact dates (GA, Full Support, Maintenance, ELS, Extended Life)
- Operator flag (`is_operator`)
- OpenShift compatibility data
- Former product names

**Tested queries:**
```bash
# All products (233 total)
curl -s 'https://access.redhat.com/product-life-cycles/api/v1/products'

# Filter by name
curl -s 'https://access.redhat.com/product-life-cycles/api/v1/products?name=Red%20Hat%20Enterprise%20Linux'
curl -s 'https://access.redhat.com/product-life-cycles/api/v1/products?name=OpenShift%20Container%20Platform%204'
curl -s 'https://access.redhat.com/product-life-cycles/api/v1/products?name=Red%20Hat%20Ansible%20Automation%20Platform'
```

**Key data per version:**
```json
{
  "name": "4.21",
  "type": "Full Support",
  "phases": [
    { "name": "General availability", "end_date": "2026-02-03T00:00:00.000Z" },
    { "name": "Full support", "end_date": "GA of 4.22 + 3 Months" },
    { "name": "Maintenance support", "end_date": "2027-08-03T00:00:00.000Z" }
  ]
}
```

**Products relevant to your customers:**
- 233 total products in the API
- Includes: RHEL (7, 8, 9, 10), OCP 4 (4.14-4.21), AAP (2.2-2.6), Ansible Core, RHEL AI, OpenShift AI, OpenShift Virtualization, Service Mesh, GitOps, Pipelines, Serverless, Dev Spaces, and 200+ more

### 2. Red Hat Security Data API (Hydra)

- **Base URL:** `https://access.redhat.com/hydra/rest/securitydata/`
- **Auth:** None required
- **Format:** JSON and XML
- **Documentation:** https://docs.redhat.com/en/documentation/red_hat_security_data_api/1.0/html-single/red_hat_security_data_api/index

**Endpoints:**
```bash
# CSAF advisories (security only - RHSA)
curl -s 'https://access.redhat.com/hydra/rest/securitydata/csaf.json?after=2026-03-01&per_page=5'

# CVE data
curl -s 'https://access.redhat.com/hydra/rest/securitydata/cve.json?after=2026-03-01&per_page=5'

# OVAL data
curl -s 'https://access.redhat.com/hydra/rest/securitydata/oval.json'
```

**Limitation:** This API only covers **security advisories (RHSA)**. It does NOT include enhancement advisories (RHEA) or bug fix advisories (RHBA). Therefore it cannot be used to track new features -- only security fixes. The `type` parameter is not supported.

**Each CSAF entry includes:**
- Advisory ID (RHSA-YYYY:NNNNN)
- Severity (low, moderate, important, critical)
- Release date
- CVE IDs
- Bugzilla IDs
- Affected packages with full NEVRA

### 3. Red Hat API Catalog (console.redhat.com)

- **Portal:** https://developers.redhat.com/api-catalog/
- **Auth:** Requires offline token from https://console.redhat.com/openshift/token
- **48+ APIs available**

**Most relevant APIs:**
| API | Description | Use Case |
|-----|-------------|----------|
| Managed Inventory | Host inventory for Insights | Track customer installed products |
| Subscriptions Usage v1/v2 | Subscription tracking | Know which products customer owns |
| Subscription Management | Activation keys, manifests | Entitlement data |
| Advisor | Insights recommendations | Proactive recommendations |
| Vulnerability Management | CVE tracking per system | Security posture |
| Patch | Available patches per system | Update recommendations |

**Strategic insight:** If a customer has Insights connected, these APIs could automatically tell you what versions they're running, enabling automatic "upgrade recommendation" features.

### 4. No Feature-Level API Exists

After exhaustive search: **Red Hat does not publish a structured API for release notes features, tech previews, or deprecations.** This data exists only in HTML documentation on docs.redhat.com.

---

## B. Release Cadence

### RHEL
- **Major releases:** Every ~3 years (RHEL 9: June 2022, RHEL 10: 2025)
- **Minor releases:** Every ~6 months (9.0, 9.1, ... 9.7)
- **Support:** 10 years (5 Full + 5 Maintenance), optional ELS add-on
- **Tech Preview to GA:** Typically 1-3 minor releases (6-18 months)

### OpenShift Container Platform 4
- **Minor releases:** Every ~4 months (4.14 -> 4.15 -> ... -> 4.21)
- **Latest:** OCP 4.21 (GA: 2026-02-03)
- **Support:** 18 months from GA
- **EUS (even versions):** Up to 48 months with all 3 EUS terms
- **Feature freeze:** ~12 weeks before GA
- **Tech Preview to GA:** Typically 1-2 releases (4-8 months)
- **Upcoming features announced:** Red Hat Summit, blog posts, release notes

### Ansible Automation Platform
- **Major versions:** AAP 2.5 (Sep 2024), 2.6 (2025), 2.7 (June 2026 managed cloud)
- **Release cadence:** ~6-9 months between major versions
- **Self-Service Portal:** ~3 month release cycle
- **Tech Preview to GA:** Typically 1-2 versions

---

## C. Scraping Approaches

### docs.redhat.com Release Notes Structure

**URL patterns (all confirmed 200 status):**
```
# RHEL 9.x release notes
https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/9.{minor}_release_notes/new-features
https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/9.{minor}_release_notes/technology-previews
https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/9.{minor}_release_notes/deprecated-functionality

# OCP 4.x release notes (single page with all sections)
https://docs.redhat.com/en/documentation/openshift_container_platform/4.{minor}/html/release_notes/ocp-4-{minor}-release-notes

# AAP 2.x release notes
https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.{minor}/html/release_notes/new-features
https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.{minor}/html-single/release_notes/index
```

**HTML Structure (from CSS analysis):**
- Features organized in `<section>` elements with heading hierarchy (h2 > h3 > h4)
- Categories via h2/h3 (e.g., "Installer and image creation", "Security", "Networking")
- Individual features as h4 + paragraph text
- Jira/Bugzilla IDs embedded as links within feature descriptions
- Definition lists (`<dl>/<dt>/<dd>`) used in OCP release notes
- Custom elements: `<rh-table>`, `<rh-alert>`

**Scraping challenge:** docs.redhat.com uses heavy client-side rendering (PatternFly, Lit, RHDS components). The actual content is loaded dynamically. A simple HTTP GET returns CSS/JS boilerplate, not content. **You need a headless browser (Puppeteer/Playwright) or the single-page PDF versions.**

**PDF alternative (no JS rendering needed):**
```
https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/pdf/9.7_release_notes/Red_Hat_Enterprise_Linux-9-9.7_Release_Notes-en-US.pdf
```

### docs.redhat.com Sitemap

**Sitemap index:** `https://docs.redhat.com/sitemaps/docs/docs-sitemap-index.xml`
- 23 sub-sitemaps (sitemap-0.xml through sitemap-22.xml)
- sitemap-0.xml alone contains 50,000 URLs, including 2,023 release note URLs
- Multi-language (en, ja, zh-cn, ko)
- Can be parsed to discover new release notes automatically

**Approach:** Parse sitemap weekly, filter for `/en/` + product name + `release_notes`, diff against previous run to detect new releases.

### Red Hat Blog

**No RSS feed exists** (blog/feed and blog/rss.xml both return 404).

**Blog channels exist at:**
- https://www.redhat.com/en/blog/channel/red-hat-ansible-automation
- https://www.redhat.com/en/blog/channel/red-hat-openshift
- https://www.redhat.com/en/blog/channel/red-hat-news

These would need to be scraped (also JS-rendered Drupal site).

### AAP Notification Feed (CONFIRMED WORKING)

**Atom feed:** `https://announcements.ansiblecloud.redhat.com/feed.atom`
- Structured Atom/XML with custom `aap:` namespace
- Includes deployment types (managed-azure, saas-aws, all)
- Publish/unpublish dates
- Links to full KB articles
- Currently shows: AAP 2.7 upgrade timeline, service account migration, infrastructure updates

---

## D. AI-Augmented Approach

### Gemini with Google Search Grounding

**Confirmed capability:** Gemini API with Google Search grounding can answer questions like "What's new in OCP 4.18?" by searching the web and synthesizing results.

**Key features:**
- Links model responses to live Google Search results
- Reduces hallucinations on time-sensitive topics
- Provides cited sources alongside answers
- **Structured output support:** Can combine Search grounding with JSON schema output -- perfect for extracting features into a parseable format

**Pricing (as of Jan 2026):** $14 per 1,000 search queries (usage-based)

**Recommended approach:**
```typescript
// Weekly Gemini call per product version
const prompt = `
List all new features, tech previews, and deprecations in
Red Hat OpenShift Container Platform 4.18.
For each item provide:
- category (networking, security, storage, etc.)
- name
- status (GA, TechPreview, Deprecated)
- one-sentence description
Return as JSON array.
`;

const result = await gemini.generateContent({
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  tools: [{ googleSearch: {} }],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: featureSchema,
  },
});
```

**Cost estimate:** 3 products x 3-5 active versions x 4 calls/month = ~60 queries/month = ~$0.84/month

### Customer Matching Strategy

To match features to customer tech stack:

1. **Know what they run:** Pull from Insights Inventory API or manual config
2. **Version delta:** Customer on OCP 4.15, latest is 4.21 = 6 versions of features
3. **Gemini summarization:** "Summarize the most impactful features added between OCP 4.15 and 4.21 for a customer running [workload types]"
4. **Priority scoring:** Features in their domain (security, networking, AI/ML) score higher

---

## E. Integration Architecture

### Recommended Multi-Source Pipeline

```
┌─────────────────────────────────────────────────┐
│              Weekly Cron Job                      │
├─────────────────────────────────────────────────┤
│                                                   │
│  1. Life Cycle API ────► Version/date tracking    │
│     (free, JSON, reliable)                        │
│                                                   │
│  2. Sitemap diff ────► New release detection      │
│     (free, XML, weekly)                           │
│                                                   │
│  3. Gemini + Search ────► Feature extraction      │
│     ($0.84/mo, JSON, weekly)                      │
│                                                   │
│  4. AAP Atom feed ────► AAP notifications         │
│     (free, Atom/XML, on-demand)                   │
│                                                   │
│  5. Security Data API ────► CVE tracking          │
│     (free, JSON, daily)                           │
│                                                   │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│         product_features cache (JSON)             │
│                                                   │
│  { product, version, features[], techPreviews[],  │
│    deprecations[], releaseDate, eolDate,          │
│    securityAdvisories[] }                         │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│         Brief XML Source Type                     │
│                                                   │
│  <source type="product_features"                  │
│          product="ocp"                            │
│          customer_version="4.15"                  │
│          latest_version="4.21" />                 │
│                                                   │
│  Dashboard: "6 versions behind, 47 new features,  │
│  12 tech previews, 3 critical security fixes"     │
└─────────────────────────────────────────────────┘
```

### New XML Source Type

```xml
<source type="product_features"
        product="openshift_container_platform"
        customer_version="4.15"
        latest_version="4.21">
  <include>new_features,tech_previews,deprecations,security</include>
  <categories>networking,security,storage,ai_ml</categories>
</source>
```

### Dashboard Integration Ideas

1. **Product Health Card:** Per-customer card showing installed vs. latest version, support status (Full/Maintenance/EUS), days until EOL
2. **Feature Delta View:** "You're 6 versions behind. Here are the top 10 features you're missing."
3. **Upgrade Risk Assessment:** Tech previews that became GA (safe to adopt), deprecated features (need migration plan)
4. **Security Posture:** Outstanding CVEs for their version, fixed in newer versions

### Code Example: Life Cycle API Client

```typescript
interface ProductVersion {
  name: string;
  type: string;  // "Full Support" | "Maintenance Support" | "End of Maintenance"
  phases: {
    name: string;
    start_date: string;
    end_date: string;
  }[];
}

interface Product {
  uuid: string;
  name: string;
  versions: ProductVersion[];
  is_operator: boolean;
}

async function getProductLifecycle(productName: string): Promise<Product[]> {
  const resp = await fetch(
    `https://access.redhat.com/product-life-cycles/api/v1/products?name=${encodeURIComponent(productName)}`
  );
  const data = await resp.json();
  return data.data;
}

async function getVersionStatus(product: string, version: string) {
  const products = await getProductLifecycle(product);
  const p = products[0];
  const v = p.versions.find(v => v.name === version);
  if (!v) return null;

  const gaPhase = v.phases.find(p => p.name === 'General availability');
  const eolPhase = v.phases.find(p => p.name === 'Maintenance support');

  return {
    version: v.name,
    supportStatus: v.type,
    gaDate: gaPhase?.end_date,
    eolDate: eolPhase?.end_date,
    isEOL: v.type === 'End of Maintenance',
  };
}
```

---

## Strategic Assessment

### What Works Today (Tier 1 - Build Now)
1. **Life Cycle API** - Version tracking, support status, EOL dates. Free, reliable, JSON. Build the client immediately.
2. **Sitemap monitoring** - Detect new release notes. Free, XML. Simple weekly diff job.
3. **AAP Atom feed** - Ansible notifications. Free, structured. Direct integration.

### What Works With Effort (Tier 2 - Build Next)
4. **Gemini Search grounding** - Feature extraction from release notes. ~$1/month. Need prompt engineering and schema definition.
5. **Security Data API** - CVE tracking per product. Free, JSON. Good for security posture dashboard.

### What Requires Investigation (Tier 3 - Validate First)
6. **Headless browser scraping** - docs.redhat.com release notes. Requires Playwright/Puppeteer. Heavy, fragile.
7. **PDF parsing** - Release notes PDFs. More stable than HTML but less structured.
8. **Insights APIs** - Customer inventory. Requires customer Insights connection and auth tokens.

### Second-Order Effects to Consider
- **Customer trust:** Proactively showing "you're 3 versions behind with 12 unfixed CVEs" builds credibility
- **Upgrade conversations:** Feature data creates natural upgrade discussion hooks
- **Competitive advantage:** Most SAs don't have automated product intelligence -- this differentiates your briefings
- **Maintenance burden:** Scraping is fragile; AI-augmented approach (Gemini) is more resilient to HTML changes

---

## Sources

- [Red Hat Product Life Cycle Data API](https://docs.redhat.com/en/documentation/red_hat_product_life_cycle_data_api/1.0/html-single/red_hat_product_life_cycle_data_api/index)
- [Red Hat Security Data API](https://docs.redhat.com/en/documentation/red_hat_security_data_api/1.0/html-single/red_hat_security_data_api/index)
- [Red Hat API Catalog](https://developers.redhat.com/api-catalog/)
- [OpenShift Life Cycle Policy](https://access.redhat.com/support/policy/updates/openshift)
- [AAP Life Cycle Policy](https://access.redhat.com/support/policy/updates/ansible-automation-platform)
- [AAP Notification Feed](https://access.redhat.com/articles/7128258)
- [RHEL 9.7 Release Notes](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/9.7_release_notes/new-features)
- [OCP 4.18 Release Notes](https://docs.redhat.com/en/documentation/openshift_container_platform/4.18/html/release_notes/ocp-4-18-release-notes)
- [AAP 2.5 Release Notes](https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.5/html-single/release_notes/index)
- [AAP 2.6 Release Notes](https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.6/html-single/release_notes/index)
- [Gemini Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- [Red Hat Documentation GitHub (acorns)](https://github.com/redhat-documentation/acorns)
- [docs.redhat.com Sitemap](https://docs.redhat.com/sitemaps/docs/docs-sitemap-index.xml)
- [Red Hat Errata Types Explained](https://access.redhat.com/articles/explaining_redhat_errata)
- [Getting Started with Red Hat APIs](https://access.redhat.com/articles/3626371)
