---
doc-type: runbook
status: active
owner: jason
updated: 2026-07-14
---

# Engagement Playbook Spec — EngagementBuilder Evolution

**Status:** Draft
**Author:** Serena Blackwood (architecture) + Rayford (DA)
**Date:** 2026-07-13
**Drives:** EngagementBuilder skill at `~/.claude/skills/EngagementBuilder/`

---

## 1. Problem Statement

Today, preparing for a customer engagement requires 15+ minutes of manual searching across 5+ data sources:

1. **Gmail** — hunting for email threads with keywords, hoping to find customer replies with confirmed use cases, agenda items, or technical requirements
2. **Google Drive** — navigating multiple account folders to find meeting prep docs, presentations, follow-up notes, email drafts
3. **Intelligence cache** — reading JSON files for company overview, expansion recommendations, product intel
4. **Pipeline data** — checking opportunity status, renewal dates, deal sizes
5. **Subscription data** — reading Supportable spreadsheet for entitlements and node counts

The current EngagementBuilder skill generates polished Google Docs but only reads from the intelligence cache (source #3). It misses the richest context — the email threads where customers confirm use cases, express preferences, and reveal constraints.

**The cost:** Jason had to tell me "Jul 2 customer confirmed use cases" before I could find Narayanan's email with 9 specific use cases for the Workday AAP demo. Without that hint, the playbook would have been generic instead of precise.

**The fix:** Attendee-based email discovery. Calendar events contain attendee email addresses. Searching Gmail by sender/recipient instead of keywords finds ALL relevant threads automatically.

---

## 2. Solution Overview

Evolve EngagementBuilder with a new `--type playbook` that adds a **Gathering Pipeline** before the existing doc generation:

```
/EngagementBuilder Workday --meeting "AAP Demo"
        │
        ▼
┌─────────────────────────────────┐
│  GATHERING PIPELINE (new)       │
│                                 │
│  Calendar → Attendees           │
│  Gmail → Email Threads          │
│  Drive → Account Folder Docs    │
│  Cache → Intelligence + Expansion│
│  Sheets → Subscriptions         │
│  Pipeline → Opportunities       │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  SYNTHESIS ENGINE (new)         │
│                                 │
│  Raw Data → Playbook Sections   │
│  Use Cases + Products → Straw Man│
│  Known vs Unknown → Gap Analysis │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  DOC GENERATION (existing)      │
│                                 │
│  Template Copy → Content Fill   │
│  → Formatting → Output          │
└─────────────────────────────────┘
```

The existing doc types (`discovery`, `meeting-prep`, `account-plan`, `workshop`, `custom`) continue to work unchanged. `playbook` is a new type that runs the full pipeline.

---

## 3. Architecture

### 3.1 Gathering Pipeline

Each gatherer is an independent module that queries one data source and returns structured data. Gatherers run in parallel where possible. Each handles its own errors — a missing source produces a `{ available: false, reason: "..." }` result, never a failure.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Calendar    │  │  Gmail       │  │  Drive       │
│  Gatherer    │  │  Gatherer    │  │  Gatherer    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │    ┌────────────┴─────┐           │
       │    │  Depends on      │           │
       │    │  Calendar result │           │
       │    │  (attendees)     │           │
       │    └──────────────────┘           │
       │                                   │
┌──────┴───────┐  ┌──────────────┐  ┌──────┴───────┐
│  Cache       │  │  Sheets      │  │  Pipeline    │
│  Gatherer    │  │  Gatherer    │  │  Gatherer    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                         ▼
              ┌──────────────────┐
              │  Gathered Context │
              │  (unified struct) │
              └──────────────────┘
```

**Execution order:**
1. **Parallel batch 1:** Calendar Gatherer + Cache Gatherer + Drive Gatherer + Sheets Gatherer + Pipeline Gatherer
2. **Sequential:** Gmail Gatherer (needs attendee emails from Calendar result)

### 3.2 Synthesis Engine

Takes the gathered context and produces playbook sections through Gemini inference:

1. **Timeline Builder** — orders all interactions chronologically (emails, meetings, docs)
2. **Use Case Extractor** — identifies confirmed use cases from email threads
3. **Solution Mapper** — maps use cases to Red Hat products using expansion intelligence + product knowledge
4. **Subscription Analyzer** — compares current entitlements to solution requirements
5. **Gap Detector** — identifies what's unknown and generates per-attendee questions

### 3.3 External Data Sources (Solution Enrichment)

Beyond customer-specific gathered data, the synthesis engine draws on Red Hat ecosystem knowledge:

1. **Red Hat Architecture Portfolio** — `https://www.redhat.com/architect/portfolio/` — reference architectures matched to customer use cases (e.g., "Event-Driven Ansible for network automation" for Cisco/Palo Alto use cases)
2. **Ansible Certified Content Collections** — matched to customer device vendors (cisco.ios, paloaltonetworks.panos, arista.eos) and use case categories (network compliance, patching, config backup)
3. **Partner Ecosystem** — consulting partners, Navigate engagements, TAM, training paths matched to solution complexity
4. **Product Lifecycle Data** — EOL dates, upgrade paths (e.g., AAP 2.6 → 2.7, RHEL 9 → 10) from cache
5. **Customer Success Stories** — proof points from product intel matched to similar use cases/industries

The Solution Mapper cross-references customer-stated specifics (e.g., "Cisco Catalyst", "Palo Alto via Panorama", "AMZL2023 VMs") against these sources to produce concrete, not generic, recommendations.

### 3.4 Doc Generation

Uses the existing `GenerateDocument.md` workflow (template copy → content fill → formatting) with a new playbook template structure.

---

## 4. Gathering Pipeline — Source Detail

### 4.1 Calendar Gatherer

**Token:** `DailyBriefDashboard/config/.calendar-token.json`
**OAuth keys:** `DailyBriefDashboard/config/gcp-oauth.keys.json`

**Query strategy:**
```javascript
// If --meeting provided, search for matching event
calendar.events.list({
  calendarId: 'primary',
  q: meetingQuery,  // e.g., "AAP Demo" or "Workday"
  timeMin: new Date(Date.now() - 90 * 86400000).toISOString(),
  timeMax: new Date(Date.now() + 30 * 86400000).toISOString(),
  maxResults: 20,
  singleEvents: true,
  orderBy: 'startTime'
});

// If no --meeting, search by customer name
calendar.events.list({
  calendarId: 'primary',
  q: customerName,
  timeMin: new Date(Date.now() - 90 * 86400000).toISOString(),
  timeMax: new Date(Date.now() + 14 * 86400000).toISOString(),
  ...
});
```

**Extract:**
```typescript
interface CalendarResult {
  available: boolean;
  targetEvent?: {
    id: string;
    summary: string;
    start: string;
    end: string;
    attendees: Array<{ email: string; displayName?: string; responseStatus: string }>;
    description?: string;
    htmlLink: string;
  };
  relatedEvents: Array<{...}>; // other meetings with same attendees/customer
  attendeeEmails: string[];    // deduplicated, customer domain only
  internalEmails: string[];    // Red Hat team members
}
```

**Key detail:** Filter attendees by customer domain (from `customers.json`) to separate customer contacts from internal Red Hat team.

### 4.2 Gmail Gatherer

**Token:** `DailyBriefDashboard/config/.gmail-token.json`
**Depends on:** Calendar result (attendeeEmails)

**Query strategy — attendee-based (primary):**
```javascript
// Build query from attendee emails
const attendeeQuery = attendeeEmails
  .map(email => `from:${email} OR to:${email}`)
  .join(' OR ');

// Search last 90 days
gmail.users.messages.list({
  userId: 'me',
  q: `(${attendeeQuery}) newer_than:90d`,
  maxResults: 50
});
```

**Fallback query (no calendar data):**
```javascript
// Search by customer domain
gmail.users.messages.list({
  userId: 'me',
  q: `from:@${customerDomain} OR to:@${customerDomain} newer_than:90d`,
  maxResults: 50
});
```

**For each message, extract:**
```javascript
// Get full message with body
gmail.users.messages.get({
  userId: 'me',
  id: msg.id,
  format: 'full'
});
```

Parse headers: Subject, From, To, Cc, Date
Parse body: decode base64, extract plain text, handle multipart

**Thread grouping:** Group messages by `threadId` to reconstruct conversations. For each thread:
- Subject line
- Participants
- Date range
- Full conversation text (for synthesis)
- Detected action items, use cases, decisions

**Extract:**
```typescript
interface GmailResult {
  available: boolean;
  threads: Array<{
    id: string;
    subject: string;
    participants: string[];
    dateRange: { first: string; last: string };
    messageCount: number;
    fullText: string;         // concatenated thread text for synthesis
    latestSnippet: string;    // last message preview
  }>;
  totalMessages: number;
}
```

**Rate limit handling:** Gmail API allows 250 quota units/second. `messages.list` = 5 units, `messages.get` = 5 units. For 50 messages, that's ~255 units — safe in a single burst. Add 100ms delay between get calls as buffer.

### 4.3 Drive Gatherer

**Token:** `DailyBriefDashboard/config/.google-token.json`

**Query strategy:**
```javascript
// Step 1: Find customer folders
drive.files.list({
  q: `name contains '${customerName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  fields: 'files(id, name, modifiedTime, parents)',
  pageSize: 20
});

// Step 2: For each folder, list contents recursively (1 level)
drive.files.list({
  q: `'${folderId}' in parents and trashed = false`,
  fields: 'files(id, name, mimeType, modifiedTime)',
  orderBy: 'modifiedTime desc',
  pageSize: 50
});

// Step 3: For subfolders (Meeting Prep, Account Plans, etc.), list their contents too
// Step 4: Read the 5 most recent Google Docs (full text via docs.documents.get)
```

**Doc reading strategy:** Don't read ALL docs — that's too slow. Prioritize:
1. Most recent meeting prep doc
2. Most recent account plan
3. Most recent follow-up/email doc
4. Any doc modified in the last 14 days
5. Cap at 5 docs total to stay under 30 seconds

**Extract:**
```typescript
interface DriveResult {
  available: boolean;
  folders: Array<{ id: string; name: string }>;
  recentDocs: Array<{
    id: string;
    name: string;
    type: string; // DOC, SLIDES, SHEET, FILE
    modifiedTime: string;
    content?: string; // full text for top 5 docs
    url: string;
  }>;
  folderStructure: Record<string, string[]>; // subfolder name → doc names
}
```

### 4.4 Cache Gatherer

**Existing pattern** — reuses Step 2 of `GenerateDocument.md`:

```typescript
interface CacheResult {
  available: boolean;
  intelligence?: object;       // from {slug}.json
  accountPlan?: string;        // from {slug}-account-plan.md
  expansion?: object;          // from {slug}-expansion.json
  productDocs?: object;        // from customer-docs/{slug}.json
  campaigns?: object[];        // from campaigns/{slug}-*.json
  pipelineData?: object[];     // from pipeline-data.json filtered
}
```

All reads are local filesystem — fast and reliable.

### 4.5 Sheets Gatherer (Subscriptions)

**Token:** `DailyBriefDashboard/config/.sheets-token.json`
**Input:** `supportableFileId` from customer config

```javascript
sheets.spreadsheets.values.get({
  spreadsheetId: supportableFileId,
  range: 'A1:Z1000', // read full sheet
});
```

**Extract:**
```typescript
interface SheetsResult {
  available: boolean;
  subscriptions: Array<{
    product: string;          // "RHEL", "AAP", "OCP"
    sku: string;
    quantity: number;
    startDate: string;
    endDate: string;
    supportLevel: string;
    status: string;           // "Active", "Expired"
  }>;
  totalNodes: number;
  expiringWithin90Days: Array<{...}>;
}
```

### 4.6 Pipeline Gatherer

**Source:** `data/cache/pipeline-data.json` (local file)
**Fallback:** Search Drive for recent pipeline CSV if local file is stale

Filter by customer name (case-insensitive substring match on `accountName`).

```typescript
interface PipelineResult {
  available: boolean;
  opportunities: Array<{
    name: string;
    acv: number;
    closeDate: string;
    forecastCategory: string;
    products: string[];
    owner: string;
    stage: string;
    isRenewal: boolean;
  }>;
  totalPipeline: number;
  nearestCloseDate: string;
}
```

---

## 5. Synthesis Engine

The synthesis engine takes all gathered data and produces structured playbook sections. It uses Gemini (`bun ~/.claude/PAI/Tools/Inference.ts`) for content generation where raw data needs interpretation.

### 5.1 Timeline Builder

**Input:** Calendar events + Gmail threads + Drive doc modification dates + meeting prep history
**Output:** Chronological engagement timeline

Algorithm:
1. Collect all dated artifacts: emails (by Date header), calendar events (by start time), Drive docs (by modifiedTime)
2. Sort chronologically
3. For each item, extract: date, type (email/meeting/doc), participants, one-line summary
4. Group into engagement phases: "Initial Contact" → "Discovery" → "Technical Deep-Dive" → "Demo/POC" → "Proposal"

No Gemini needed — this is mechanical date sorting + type classification.

### 5.2 Use Case Extractor

**Input:** Gmail thread full text (especially customer replies)
**Output:** Structured use cases

Gemini prompt:
```
Extract confirmed customer use cases from these email threads.

A "confirmed use case" is something the CUSTOMER explicitly said they want to do, solve, or demonstrate — not something Red Hat suggested.

For each use case:
- Description: what they want to accomplish
- Category: cloud | network | security | automation | AI | other
- Source: which email/date it was mentioned
- Confirmation level: CONFIRMED (customer stated it) | INFERRED (implied from context) | PROPOSED (Red Hat suggested, not yet confirmed)

Email threads:
{thread_texts}
```

### 5.3 Solution Mapper

**Input:** Confirmed use cases + expansion intelligence + product knowledge
**Output:** Product-to-use-case mapping with sizing

Algorithm:
1. For each confirmed use case, match to Red Hat product(s) using expansion recommendations as primary signal
2. Cross-reference with product intel for feature-level mapping
3. Determine deployment model based on customer constraints (sovereign cloud → self-hosted, etc.)
4. Size subscriptions based on known environment (node counts from intelligence, endpoint counts from email threads)

Gemini prompt:
```
You are a Red Hat Solution Architect creating an opinionated solution recommendation.

Customer: {customerName}
Environment: {techStack summary}
Confirmed Use Cases:
{use_cases}

Current Red Hat Subscriptions:
{subscriptions}

Expansion Recommendations (from intelligence):
{expansion}

For each use case, recommend:
1. Primary Red Hat product(s) — be specific (AAP, not "automation")
2. Key features that solve this use case — reference specific capabilities
3. Subscription estimate — how many nodes/cores/units based on their environment
4. Deployment model — managed cloud (which provider), self-hosted, or hybrid
5. Implementation approach — POC scope, timeline, success criteria

Also identify:
- Subscription gaps: what they'd need beyond current entitlements
- Quick wins: use cases that can demo in < 1 hour
- Strategic plays: use cases that open larger deals
```

### 5.4 Gap Detector

**Input:** All gathered data + solution recommendation
**Output:** Per-attendee questions organized by priority

Algorithm:
1. Define the "complete solution picture" fields:
   - Environment: node count, OS versions, cloud providers, network devices, firewall vendors
   - Architecture: deployment model preference, connectivity constraints, compliance requirements
   - Operations: current tooling, CI/CD pipeline, monitoring stack, change management process
   - Business: timeline, budget authority, success metrics, competitive evaluations
   - Technical: existing automation (playbooks, scripts), credential management, RBAC requirements

2. For each field, check if we have data from ANY gathered source
3. For missing fields, generate a question:
   - Assign to the most appropriate attendee (by role — Director gets business Qs, Sr Engineer gets technical Qs)
   - Tie to solution impact ("We need this to size the AAP subscription correctly")
   - Prioritize: MUST-KNOW (blocks solution design) vs NICE-TO-KNOW (improves recommendation)

4. For fields where we have PARTIAL data, generate a confirmation question:
   - "Our intelligence shows you're running 64 OpenStack clusters — is that still accurate?"

---

## 6. Playbook Template Structure

### Section 1: Engagement Context

| Field | Source | Required |
|-------|--------|----------|
| Meeting title, date, time | Calendar Gatherer | Yes |
| Meeting objective (1-2 sentences) | Synthesized from meeting topic + customer context | Yes |
| Attendee table: Name, Title, Company, Engagement Angle | Calendar + Intelligence + Drive (LinkedIn doc) | Yes |
| Engagement timeline (chronological) | Timeline Builder | Yes |
| Relationship status | Account Plan cache | If available |
| Previous meeting outcomes | Drive Gatherer (meeting prep docs) + Gmail threads | If available |

### Section 2: Customer Intelligence Summary

| Field | Source | Required |
|-------|--------|----------|
| Company overview (revenue, employees, HQ, fiscal year) | Intelligence cache `company` field | Yes |
| Leadership & org changes | Intelligence cache `leadership` field | If available |
| Strategic priorities (top 3) | Intelligence cache + account plan | Yes |
| Technology landscape (infra, cloud, tools) | Intelligence cache `techStack` + email threads | Yes |
| Known pain points (prioritized) | Intelligence cache `painPoints` + email thread extraction | Yes |
| Competitive landscape | Intelligence cache `competitors` | If available |

### Section 3: Confirmed Use Cases & Requirements

| Field | Source | Required |
|-------|--------|----------|
| Use case table: Description, Category, Source, Confirmation Level | Use Case Extractor (from Gmail) | Yes (may be empty) |
| Customer-stated requirements | Gmail thread extraction | If available |
| Deployment preferences | Gmail thread extraction (managed vs self-hosted discussion) | If available |
| Constraints mentioned | Gmail + intelligence (sovereign cloud, compliance, etc.) | If available |

### Section 4: Red Hat Solution Recommendation (Straw Man)

| Field | Source | Required |
|-------|--------|----------|
| Solution overview (1 paragraph, opinionated) | Solution Mapper | Yes |
| Product-to-use-case mapping table | Solution Mapper | Yes |
| Architecture diagram description | Solution Mapper + environment data | Yes |
| Subscription sizing table: Product, Current Qty, Recommended Qty, Delta | Sheets Gatherer + Solution Mapper | If subscriptions available |
| Deployment model recommendation with rationale | Solution Mapper + customer constraints | Yes |
| Quick wins (demo-able in < 1 hour) | Solution Mapper | Yes |
| Strategic expansion plays | Expansion intelligence + Solution Mapper | Yes |
| SKU/pricing guidance | Pipeline + expansion data | If available |
| Reference architectures | Product intel docs | If available |

### Section 5: Resources & Enablement

| Field | Source | Required |
|-------|--------|----------|
| Free resources: labs, workshops, interactive demos | Sales kit / TDP alignment from meeting prep data | Yes |
| Partner catalog resources | Account plan + consulting recommendations | If available |
| Training and certification paths | Mapped to customer team roles | Yes |
| Customer success stories / case studies | Product intel + campaign data | If available |
| Red Hat Consulting / Navigate / TAM services | Solution Mapper recommendations | Yes |

### Section 6: Gap Analysis & Discovery Questions

| Field | Source | Required |
|-------|--------|----------|
| Question table: Question, Assigned To (attendee), Priority (MUST/NICE), Why We Need It | Gap Detector | Yes |
| Confirmation questions (verify what we think we know) | Gap Detector | If partial data exists |
| Questions grouped by attendee | Gap Detector + attendee role matching | Yes |

### Section 7: Team Alignment & Action Items

| Field | Source | Required |
|-------|--------|----------|
| **Product-matched Red Hat team** (core) | `/api/customer/{slug}/team` → filter by engagement product (e.g., AAP → Ansible SSP + Ansible SSA) | Yes |
| **Extended Red Hat team** (future phases) | `/api/customer/{slug}/team` → remaining specialists mapped to expansion plays | Yes |
| SSA identified as demo lead | Team roster — SSA role for the matched product runs demos | Yes (if demo planned) |
| Pre-meeting assignments | Generated from playbook content, assigned to matched team members | Yes |
| Demo/POC plan with milestones | Solution Mapper quick wins, SSA as demo owner | If demo planned |
| Success criteria for engagement | Solution Mapper + pipeline data | Yes |
| Follow-up cadence recommendation | Engagement timeline analysis | Yes |

**Team matching logic:**
1. Call `/api/customer/{slug}/team` (uses `getAccountTeam()` from `src/account-team.ts`)
2. Match team members to the engagement product:
   - Engagement is AAP → pull Ansible SSP + Ansible SSA into core team
   - Engagement is OCP → pull OpenShift SSP + App Platform SSA into core team
   - Engagement is RHEL → pull RHEL SSP + RHEL SSA into core team
   - Engagement is RHOAI → pull AI SSP into core team
3. SSA for the matched product = **demo lead** (SSAs run demos, SSPs handle positioning/sizing)
4. Remaining specialists go to "extended team" with a note on when to engage (mapped to expansion plays)
5. AE + ASA are always core team regardless of product

---

## 7. Gap Analysis Engine — Detail

### 7.1 Solution Knowledge Requirements

The gap detector maintains a checklist of what's needed to produce a complete solution recommendation. Each item has:

```typescript
interface KnowledgeRequirement {
  field: string;           // "managed_node_count"
  category: string;        // "environment" | "architecture" | "operations" | "business" | "technical"
  question: string;        // "How many managed nodes across cloud and on-prem?"
  whyNeeded: string;       // "Required to size AAP subscription correctly"
  priority: 'MUST' | 'NICE';
  assignTo: string;        // Role-based: "Director" | "Sr. Engineer" | "Team Lead" | "Architect"
  satisfiedBy?: string;    // Which data source answered this, if any
}
```

### 7.2 Requirement Checklist

**Environment (MUST-KNOW):**
- Managed node count (Linux + Windows) → sizes AAP subscription
- Cloud providers and regions → determines deployment topology
- Network device inventory (vendor, model count) → determines network automation scope
- OS distribution breakdown (RHEL, Amazon Linux, Ubuntu, Windows) → RHEL migration opportunity

**Architecture (MUST-KNOW):**
- Deployment model preference (managed cloud / self-hosted / hybrid) → determines SKU
- Connectivity constraints (air-gapped, sovereign, polling-only) → AAP architecture
- Authentication infrastructure (AD, Okta, SAML) → SSO integration
- Existing automation tooling (Terraform, Chef, Puppet, Jenkins) → migration/integration scope

**Operations (NICE-TO-KNOW):**
- CI/CD pipeline (GitHub Actions, GitLab CI, Jenkins) → integration planning
- Monitoring stack (Prometheus, Datadog, Splunk) → EDA integration
- Change management process (ITSM tool, approval workflow) → automation governance
- Patching cadence and compliance requirements → automation priority

**Business (MUST-KNOW):**
- Timeline for decision / POC / production → engagement pacing
- Budget authority level → deal sizing
- Success metrics they'll measure → demo targeting
- Competitive evaluations in progress → competitive positioning

**Technical (NICE-TO-KNOW for straw man, MUST for sizing):**
- Existing Ansible content (playbooks, roles, collections) → migration scope
- Credential/secret management (Vault, AWS Secrets Manager) → integration planning
- RBAC requirements (who can run what) → AAP governance setup
- Inventory source (CMDB, cloud provider, static) → dynamic inventory setup

### 7.3 Satisfaction Logic

For each requirement, check gathered data in order:
1. **Email threads** — did the customer explicitly state this? (strongest signal)
2. **Intelligence cache** — do we have it from company research?
3. **Meeting prep docs** — was it discussed in a previous meeting?
4. **Account plan** — is it documented in the strategic plan?
5. **Pipeline data** — can we infer from opportunity details?

If satisfied → include the data in the solution recommendation, cite the source
If NOT satisfied → generate the question, assign to the right attendee

### 7.4 Attendee Assignment Logic

Match question category to attendee role:
- **Director / VP** → business questions (timeline, budget, success metrics, strategic direction)
- **Sr. Manager / Team Lead** → operations questions (team workflow, tooling, process, adoption)
- **Sr. Engineer / Architect** → technical questions (node counts, architecture, integrations, existing automation)
- **Principal Architect / AI Lead** → architecture questions (deployment model, cloud strategy, AI/ML infrastructure)

Use attendee profiles from intelligence cache + LinkedIn doc for role matching.

---

## 8. Invocation Modes

### 8.1 Manual — Meeting-Specific (Phase 1)

```bash
/EngagementBuilder Workday --meeting "AAP Demo"
# or
/EngagementBuilder Workday --type playbook --meeting "AAP Demo"
# or
/EngagementBuilder Workday --type playbook --context "Demo covering cloud and network automation use cases"
```

The `--meeting` flag triggers:
1. Calendar search for matching event
2. Attendee extraction
3. Full gathering pipeline
4. Playbook generation

If `--meeting` is omitted but `--type playbook` is used:
1. Search calendar for any upcoming events with this customer (next 14 days)
2. If found, use the soonest event
3. If not found, run gathering without calendar context (use customer domain for Gmail search)

### 8.2 Manual — General Account (Phase 1)

```bash
/EngagementBuilder Workday --type playbook
```

No specific meeting target. Produces a general engagement playbook based on all available intelligence. Useful for account planning sessions.

### 8.3 Calendar-Driven (Phase 2 — Dashboard Integration)

The DailyBriefDashboard morning brief process already detects upcoming meetings. In Phase 2:
1. Morning brief identifies customer meetings in the next 48 hours
2. Dashboard offers a "Generate Playbook" button per meeting
3. Clicking it runs the gathering pipeline and produces the playbook
4. Playbook appears in the customer's account folder on Drive

### 8.4 Playbook Update (Phase 2)

```bash
/EngagementBuilder Workday --update-playbook
```

Re-runs gathering on an existing playbook doc. Adds new intelligence, flags what changed since last generation. Uses `replaceAllText` to update sections in place rather than creating a new doc.

---

## 9. Integration with Existing EngagementBuilder

### 9.1 Backward Compatibility

All existing doc types continue to work exactly as documented:
- `--type discovery` → 4-session agenda with OPL guides
- `--type meeting-prep` → pre-meeting briefing
- `--type account-plan` → CY27 CAPI-compliant strategic plan
- `--type workshop` → structured session doc
- `--type custom` → user content in branded template

### 9.2 Playbook as Superset

`--type playbook` produces a document that INCLUDES elements from meeting-prep and account-plan but adds:
- Automated intelligence gathering (the pipeline)
- Confirmed use cases from email threads
- Opinionated solution recommendation
- Subscription gap analysis
- Per-attendee gap questions

### 9.3 Workflow File Changes

`Workflows/GenerateDocument.md` gains new steps:
- After Step 1 (Load Config & Resolve Customer): insert **Step 1b: Run Gathering Pipeline** (only for playbook type)
- After Step 2 (Load Intelligence Stack): insert **Step 2b: Run Synthesis Engine** (only for playbook type)
- Step 5 (Replace Template Variables): add playbook-specific replacements
- Step 7 (Insert Intelligence Appendix): playbook uses the full template structure instead of just an appendix

### 9.4 New Files

```
skills/EngagementBuilder/
├── SKILL.md                          # Updated: add --type playbook docs
├── Workflows/
│   ├── GenerateDocument.md           # Updated: add playbook branching
│   └── GatheringPipeline.md          # NEW: gathering pipeline instructions
├── References/
│   ├── OplPractices.md               # Unchanged
│   ├── PlaybookTemplate.md           # NEW: playbook section specifications
│   └── GapAnalysisChecklist.md       # NEW: knowledge requirements checklist
```

---

## 10. Phased Implementation

### Phase 1: Gathering + Playbook Generation (Build Now)

**Scope:** Get from `/EngagementBuilder Workday --meeting "AAP Demo"` to a complete playbook Google Doc with zero manual searching.

**Steps:**
1. Write `Workflows/GatheringPipeline.md` — instructions for each gatherer
2. Write `References/PlaybookTemplate.md` — section-by-section content spec
3. Write `References/GapAnalysisChecklist.md` — knowledge requirements list
4. Update `SKILL.md` — add `--type playbook` and `--meeting` flag docs
5. Update `Workflows/GenerateDocument.md` — add playbook branching at Steps 1b, 2b, 5, 7
6. Create a new Google Docs template for the playbook layout (or extend existing template)
7. Test with Workday as the reference customer

**Deliverable:** A working skill that produces a complete playbook. Gathering runs in the Claude Code session using Node.js one-liners (same pattern as today's manual searches, but orchestrated by the workflow instructions).

**Estimated effort:** M (3-5 hours)

### Phase 2: Dashboard Integration (Build Later)

**Scope:** Move gathering pipeline into DailyBriefDashboard Node.js app. Calendar-driven triggers. Playbook update mode.

**Steps:**
1. Port gathering pipeline to `src/engagement-playbook/` TypeScript modules
2. Add `/api/customer/:slug/playbook` endpoint
3. Add "Generate Playbook" button to customer detail page
4. Add morning brief integration (detect upcoming meetings, suggest playbooks)
5. Add playbook update mode (re-gather and diff)

**Estimated effort:** L (multi-session)

### Phase 3: Intelligence Loop (Future)

**Scope:** Post-meeting capture. Run the skill after a meeting with `--notes <google_doc_url>` to extract outcomes, update the playbook, and generate follow-up tasks.

---

## 11. Success Criteria

### Phase 1 — Measurable

| Criterion | Threshold | How to Measure |
|-----------|-----------|----------------|
| Invocation to playbook | < 3 minutes | Timestamp from skill start to doc URL output |
| Manual searching required | Zero | User does not need to search Gmail/Drive/cache manually |
| Use case discovery | Finds all customer-confirmed use cases from email threads | Compare against manual search results (Workday baseline: 9 use cases) |
| Source coverage | Queries ≥ 4 of 6 data sources successfully | Completeness report in skill output |
| Solution recommendation | Includes product mapping for every confirmed use case | Manual review |
| Gap analysis | Generates ≥ 5 targeted questions with attendee assignments | Count in output doc |
| Doc quality | PDF-ready with Red Hat branding | Visual inspection |

### Validation — Workday Test Case

Run the playbook skill for Workday and verify:
1. ✅ Finds the Jul 15 AAP Demo calendar event
2. ✅ Discovers Narayanan's Jul 2 email with 9 use cases (without being told to look for it)
3. ✅ Finds Elmer's May 20 follow-up email
4. ✅ Reads the latest account plan from Drive
5. ✅ Pulls expansion intelligence (AAP HIGH, OCP HIGH, RHOAI HIGH)
6. ✅ Maps each use case to AAP features
7. ✅ Identifies subscription gaps (current vs needed)
8. ✅ Generates questions for new attendees (Cy Lim, Mario Gomez, Pradip Kadam, Sohan Bhale — no profiles yet)
9. ✅ Produces a Google Doc in the Workday account folder

---

## 12. Straw Man Learnings (from Workday Jul 15 validation)

Lessons captured from manually running the playbook pipeline for Workday's AAP Demo:

### 12.1 Customer-Stated Topics Are Primary — Intelligence Is Secondary

**Problem found:** The dashboard's meeting-prep consumer generates from intelligence cache (strategic positioning, expansion recs). This produces Red Hat-centric angles ("Terraform integration", "EDA for agentic AI") that sound good but don't match what the customer actually asked for. Narayanan's Jul 1 email listed 9 specific use cases — 4 cloud, 5 network — and Elmer committed to covering them. The meeting prep doc didn't mention any of them.

**Spec requirement:** The gathering pipeline MUST prioritize email thread extraction over intelligence cache. The synthesis engine's Section 3 (Confirmed Use Cases) and Section 7 (Demo Plan) must be driven by **customer-stated topics from email threads**, not by Red Hat's strategic positioning from intelligence. Intelligence informs the solution recommendation (Section 4) and gap analysis (Section 6), but the demo agenda must mirror what the customer asked for.

**Implementation:** In the Synthesis Engine (Section 5.2 - Use Case Extractor), add a priority hierarchy:
1. **Customer-stated use cases** (from email threads — highest priority, drives demo plan)
2. **Red Hat positioning angles** (from intelligence/expansion — secondary, informs solution recommendation)
3. **Gap-filling topics** (from gap analysis — tertiary, used if time permits)

The demo plan generator must verify: "Does every customer-stated use case appear in the demo?" If not, flag it.

### 12.2 Attendee Names Must Come from Calendar/Email, Not Intelligence Cache

**Problem found:** Intelligence cache had wrong names (Christopher Sanchez vs Endsley, Dilip Bhatt vs Vuddaraju, Ismail Dhukka vs Shaik). The calendar invite and email CC list had the correct names. The playbook shipped with wrong names because we built from cached data instead of live email headers.

**Spec requirement:** Calendar Gatherer (Section 4.1) and Gmail Gatherer (Section 4.2) are the source of truth for attendee names and email addresses. Intelligence cache attendee data is fallback only. When names conflict, email/calendar wins.

### 12.3 Meeting Time and Duration Must Come from Calendar Event

**Problem found:** The playbook initially said "Tuesday" when Jul 15 is Wednesday. It had a 70-minute demo plan when the actual calendar invite is 1 hour. These came from the previous session's memory, not from the live calendar event.

**Spec requirement:** Calendar Gatherer must extract and surface: day of week (calculated, not assumed), start time with timezone, duration, and any scheduling notes from email threads (e.g., "9:30 AM Pleasanton time / 10:00 PM IST" from Narayanan's reschedule request).

### 12.4 Meeting Prep Doc Exists — Playbook Should Consume It, Not Compete

**Problem found:** The dashboard already generates a meeting-prep doc per meeting. The playbook duplicated some of that content (company overview, recent interactions) while missing other content the meeting prep had (per-attendee discussion questions with PURPOSE statements, open cases, renewal dates).

**Spec requirement:** The gathering pipeline should read the existing meeting-prep doc as a data source (Drive Gatherer already does this). The playbook should **import** the meeting prep's per-attendee questions and action items rather than regenerating them. The playbook adds value on top: use case mapping, solution sizing, gap analysis, marketplace options, team roster, demo plan — things the meeting prep doesn't produce.

### 12.5 Marketplace Procurement Should Be Auto-Detected

**Problem found:** We had to manually query pipeline data to discover that Workday already buys RHEL through AWS Marketplace Private Offers. This is a critical commercial insight that should surface automatically.

**Spec requirement:** Pipeline Gatherer (Section 4.6) should flag any existing marketplace/CCSP/Private Offer opps for the customer. The synthesis engine should auto-generate the marketplace procurement section based on: (a) existing procurement channel, (b) AAP availability on that channel, (c) comparable deals from pipeline data.

### 12.6 Product-Matched Team Must Be Auto-Populated

**Problem found:** The initial playbook only listed AE + ASA. The Ansible SSA (Eric Ames) and Ansible SSP (Brad Hinson) were missing — they're the people running the demo and sizing. The dashboard's `/api/customer/{slug}/team` endpoint had the full team; it just wasn't used.

**Spec requirement:** Already added to spec Section 7 template. Team matching logic filters by engagement product → SSA = demo lead, SSP = product positioning. Extended team mapped to future phases.

### 12.7 Architecture Decision: Signal Stack, Not Parallel Pipeline (Grill 2026-07-14)

**Decision:** Do NOT build the gathering pipeline as a parallel system outside the signal stack. The gap is a **signal producer gap**, not an architectural gap. The dashboard already queries Gmail, Calendar, and Drive for brief generation. The fix is new signal producer modules, not new infrastructure.

**Rationale (from grill-with-docs session):**
1. PRINCIPLES.md defines three layers: signal producers → template engine → thin consumers. Meeting Prep and Playbook are both consumers in this system. Building a parallel gathering pipeline bypasses all three layers.
2. The gathering pipeline as specified would need to be ported to the dashboard in Phase 2 anyway — a rewrite, not a port.
3. New signal producer modules benefit ALL consumers automatically (briefs, campaigns, meeting prep, playbook, email outreach).

**Implementation path (two issues):**
1. **Prerequisite: Fix Google Docs tab extraction** — `doc-extractors.ts` uses `drive.files.export` which only reads the primary tab. Google Meet transcripts live in a second tab and are invisible. Switch to `docs.documents.get` with `includeTabsContent: true`. Every consumer benefits immediately.
2. **Meeting context correlation module** — New signal producer that cross-references Calendar events + Gmail threads + Drive meeting notes by attendee overlap and temporal proximity. Emits correlated signals (e.g., `{ type: 'meeting-context', headline: 'Customer confirmed 9 AAP use cases' }`). These route through the template engine automatically.

**What this replaces in the spec:** Sections 3 (Architecture) and 4 (Gathering Pipeline) describe a standalone pipeline. These sections remain as documentation of the original design intent, but implementation follows the signal stack approach above.

### 12.8 Google Docs Tab Content Gap (Grill 2026-07-14)

**Problem found:** `ExportableDocExtractor` in `doc-extractors.ts` uses `drive.files.export({ mimeType: 'text/plain' })` which only exports the primary tab of a Google Doc. Google Meet auto-attaches transcripts as a second tab. These are invisible to the entire system — briefs, meeting prep, doc classification, everything.

The `isTranscript()` function in `docs-module.ts` detects transcript filenames and content patterns, but the content it checks never includes tab data. The meeting prep service (`meeting-prep-service.ts:1084`) has the same limitation.

**Fix:** Change `ExportableDocExtractor.extract()` to use Google Docs API v1 `docs.documents.get` with `includeTabsContent: true`. Extract text from all tab bodies, concatenate with tab name headers. Every downstream consumer gets richer content automatically.

---

### 12.9 Live Testing Results (2026-07-14)

Live verification against Workday AAP Demo meeting. Three integration bugs found that unit tests (with mocks) didn't catch:

1. **server.ts missing module import** (#988) — Module registered but never loaded. Side-effect import `import './src/modules/meeting-context-module.ts'` was missing from server.ts. All modules use this pattern.
2. **customers.find crash** (#989) — Module read `customers.json` from disk (returns `{ customers: [...] }` dict) instead of importing from `server-state.ts` (live array). `dict.find()` = crash.
3. **Empty use cases from metadata-only Gmail fetch** (#990) — `gmail.users.messages.get({ format: 'metadata' })` returns headers + snippet only, no body text. Use case extraction needs full body. Fixed to `format: 'full'` with `extractBodyText()` base64url decoder.
4. **Domain mismatch** — Workday config had `domain: 'workdaystore.eu'` but attendees use `@workday.com`. Added `workday.com` to `aliasDomains`. Spec §4.2 already defines domain + aliasDomains search — the module correctly uses both, but the data was incomplete.
5. **5 of 9 use cases extracted** (#991) — Module deduplicates by threadId, keeping only the first message per thread. Gmail `messages.list` returns individual messages; the key email with all 9 use cases may not be the first one returned. Fix: use `threads.get` instead of `messages.get` to fetch ALL messages in each thread.

**Spec requirement added:** Integration testing against live Gmail/Calendar is mandatory for signal producer modules. Unit tests with mocks verify code logic but cannot validate auth, API response shape, data format, or content completeness.

### 12.10 Partner Extraction Scope (2026-07-15)

**Problem found:** Territory partner extraction ran against ALL 3,955 pipeline records from 63 territories across the entire org. Only the user's loaded customers should be in scope. Additionally, 88% of extracted entries (487/555) were single-opp parsing noise — product names, deal types, contract numbers, and opp name fragments.

**Spec requirement:** `generateTerritoryPartners()` must accept a `customerNames` filter. When provided, pipeline records are filtered to only those whose `accountName` matches a loaded customer (case-insensitive substring). Post-extraction noise filter in `extractPartnersFromPipeline()` excludes entries with only 1 customer AND 1 opp. When enriched Tier 1 partners (those with a known `partnershipLevel` — Premier, Advanced, Specialized, Red Hat) number fewer than 3, Tier 2 fallback loads legacy catalog partners with known tiers to ensure meeting prep and playbook always have partner recommendations available.

**Implementation:** `territory-partner-generator.ts` passes customer filter to `extractPartnersFromFile()`. `admin-routes.ts` supplies loaded customer names from `server-state.ts`. `partner-catalog.ts` `loadPartnersFromConfig()` merges territory partners with legacy fallback when enriched count < 3.

### 12.11 Ecosystem-First Partner Population (2026-07-15)

**Problem found:** Pipeline opp name extraction (#993) produced 0 useful partners at the territory level. The hardcoded `partners.json` (13 static entries) was still the only source of partner data. catalog.redhat.com has no public search API (Next.js SSR, no REST endpoints).

**Discovery:** The HYDRA SOLR API (already used for ecosystem catalog sync) returns 194 solutions across ~130 unique partners, each with typed resources (labs, trials, solution briefs, videos, case studies, white papers, design guides, documentation). This is the partner discovery mechanism.

**Spec requirement:** `seedPartnersFromEcosystem()` reads per-partner cache files from `ecosystem-catalog/` directory and creates territory-partner entries. Legacy `partners.json` entries are merged as known-good seeds. The admin "Refresh" button runs ecosystem seeding first, then pipeline extraction second. Each seeded partner gets enriched from `catalog.redhat.com/en/partners/detail/{slug}` for tier and specializations (existing scraper). Meeting prep Tier 2 table includes ecosystem resources (labs, training, solution briefs) alongside partner name/tier/specializations — not just names, but what they offer.

**Data flow:** HYDRA SOLR → ecosystem cache → `seedPartnersFromEcosystem()` → territory-partners.json → `enrichTerritoryPartners()` → catalog.redhat.com detail pages → enriched territory-partners.json with tier + specializations. Meeting prep reads both territory-partners.json (names/tiers) and ecosystem cache (resources) for Tier 2 display.

## 13. Engagement Runbook Evolution (Grill 2026-07-16)

Design decisions from grill-with-docs session. Addresses: meeting prep intelligence pipeline gaps (#1004), Gmail query fix, meeting-context module wiring, engagement lifecycle.

### 13.1 Vision: Living Engagement Runbook

Meeting prep is one view into a **long-lived engagement intelligence record**, not a standalone throwaway document. Each generation is additive — re-running updates with latest intelligence rather than regenerating from scratch.

**Lifecycle model:**
- Meeting 1 → prep doc + captured intelligence (what was discussed, committed, asked for)
- Meeting 2 → builds ON meeting 1's intelligence + new signals
- Meeting N → full engagement history, every interaction threaded
- Opportunity → accumulated intelligence becomes the deal context

**Auto-detection signals (any 2+ = ongoing engagement → runbook mode):**
- Same customer has a pipeline opportunity (renewal, expansion)
- Calendar shows recurring series or ≥2 meetings in 30 days
- Email thread has ≥3 back-and-forth messages
- Prior meeting prep exists in history
- Intelligence graph has ≥10 edges for this customer

**If ongoing engagement →** Runbook mode: accumulate, persist, update-in-place, shareable
**If standalone →** Quick prep mode: generate once, don't create a runbook
**Auto-upgrade:** A first meeting that later gets a follow-up auto-upgrades from standalone to runbook.

**Runbook home:** Google Doc (shareable artifact for team) + Dashboard (live intelligence view). Both stay in sync.

### 13.2 Gold Standard Output Format

Nine sections, informed by competitive research ([Sybill](https://www.sybill.ai/blogs/ai-pre-meeting-brief-sales-call-prospect-research), [AmpUp](https://www.ampup.ai/resources/best-ai-pre-call-briefing-meeting-prep-tools), [SiftHub](https://www.sifthub.io/blog/strategic-sales-meeting-prep-tools-with-ai)):

| § | Section | Source | Deterministic? |
|---|---------|--------|----------------|
| 1 | Meeting Objective | Gemini synthesis + pipeline data + organizer intent + deal urgency (see §13.11) | Hybrid — pipeline $ and closing-meeting flag injected deterministically |
| 2 | Who's in the Room | Calendar + attendee profiles + graph | Yes — from resolved profiles (name, title, company, email) |
| 3 | Engagement Timeline | Intelligence graph edges + email threads | Yes — timestamped entries with source links. REPLACES "Recent Interactions" |
| 4 | Value Play | Gemini synthesis grounded in customer's own words | No — Gemini, but grounded in §3 evidence |
| 5 | Discovery Questions | Gemini per-attendee, informed by prior conversations | No — Gemini, constrained to attendee list |
| 6 | Assets & Resources | TDP alignment + partner resources | Yes — clean table, full link text. REPLACES blockquote dump |
| 7 | Partner Intelligence | Partner config + ecosystem catalog (Pyxis) | Yes — table + resources section |
| 8 | Open Items & Pipeline | Cases + subscriptions + pipeline opps | Yes — merged from current §6+§7 |
| 9 | Action Items | Gemini + carry-forward from prior meetings | Hybrid — prior items deterministic, new items from Gemini |

**Key changes from current format:**
- §3 Engagement Timeline: built deterministically from graph edges, not Gemini hallucination. Each entry has date, content summary, source link, and (when available) direct customer quotes from email threads.
- §6 Assets & Resources: clean table with columns [Asset Name (full, not truncated) | Link | Why Relevant]. Replaces nested blockquote TDP dump.
- §9 Action Items: carry-forward open items from prior meeting preps. "Pre-meeting" items that are past due are flagged.

### 13.3 Data Flow Architecture

**Decision:** Signals pipeline (A) + intelligence graph query (C) combined.

```
┌─────────────────────────────────────────────────────────────┐
│  SIGNAL PRODUCERS (existing modules)                        │
│  cases, subscriptions, CCSP, pipeline, product-lifecycle,   │
│  emails, meeting-context (NEW WIRING)                       │
└────────────────────────┬────────────────────────────────────┘
                         │ signals
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  templateAll() — PRINCIPLES.md Layer 3                      │
│  Routes signals to named sections, produces evidence blocks │
└────────────────────────┬────────────────────────────────────┘
                         │ template result + evidence blocks
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  MEETING PREP SERVICE                                       │
│                                                             │
│  1. Template signals (from registry)                        │
│  2. + meeting-context signals (NEW — attendee correlation)  │
│  3. + intelligence graph query (NEW — evidence doc content) │
│  4. + resolved attendee profiles                            │
│  5. + partner intelligence                                  │
│  6. → Gemini synthesis (§1, §4, §5 — non-deterministic)    │
│  7. → Deterministic overrides (§2, §3, §6, §7, §8, §9)    │
│  8. → Google Doc upload                                     │
└─────────────────────────────────────────────────────────────┘
```

**Intelligence graph consumption (new):**
At prep time, query the graph for:
- `engagement:*` nodes → email thread content for §3 Engagement Timeline
- `evidence:doc-*` nodes → account plan excerpts, prior meeting prep summaries for Gemini context
- `event:*` nodes → past meeting dates/topics for §3
- Edge timestamps → chronological ordering for §3

### 13.4 Gmail Query Fix

**Root cause:** `customer.ts:216` uses `subject:"${customer.name}"` which requires exact match on formal names like "DROPBOX, INC." — misses 9/10 emails.

**Fix:** Use the customer's `aliases` array (already in config) for subject search. Query becomes:
```
(from:@{domain} OR to:@{domain} {aliasDomains...} OR subject:"{alias1}" OR subject:"{alias2}") after:{date}
```

For Dropbox: `(from:@dropbox.com OR to:@dropbox.com OR subject:"dropbox") after:2026/6/16` — returns 10 results vs 1.

**Additionally for meeting prep:** The meeting-context-module uses **attendee-based search** (per spec §4.2) which is even more targeted. Both approaches should be available:
- `fetchCustomerEmails()` in customer.ts: domain + alias search (for morning brief, general intelligence)
- meeting-context-module signals: attendee-based search (for meeting-specific prep)

### 13.5 Invocation Modes

**Calendar-driven (existing):** System detects upcoming meeting from calendar, generates prep automatically or on-demand via dashboard button.

**Ad-hoc (new first-class mode):** User provides meeting parameters directly — customer, topic, attendees, objectives — even without a calendar event. Useful for:
- Prep for a meeting not yet scheduled
- Prep for a partner meeting using customer context
- "What if" prep exploring a customer scenario
- Re-running prep with updated context

POST `/api/customer/:name/meeting-prep/generate` already accepts these parameters. The spec formalizes this as a supported invocation mode with the same output quality bar as calendar-driven.

### 13.6 Phased Implementation

**Phase 1 — Immediate quality (S/M, ship now):**
- Fix Gmail query in customer.ts to use aliases array
- Wire meeting-context-module signals into meeting-prep-service (import + merge with registry signals)
- Build §3 Engagement Timeline deterministically from intelligence graph engagement/event edges
- Replace §6 TDP blockquote dump with clean assets table
- Fix attendee display (company + email from resolved profiles)

**Phase 2 — Engagement lifecycle (M):**
- Engagement auto-detection (signal thresholds)
- Runbook vs standalone mode
- Action item carry-forward across meeting preps
- Intelligence graph evidence doc content injection into Gemini prompt
- Customer quote extraction from email threads for §4 Value Play grounding

**Phase 3 — Dashboard + team (M/L):**
- Dashboard engagement timeline view
- Runbook management UI (list, filter, archive)
- Re-run/update workflow with diff highlighting
- Team sharing features (comments, annotations)
- Ad-hoc meeting prep UI in dashboard

### 13.7 Research Findings — Competitive Landscape (2026)

Revenue intelligence market ($1.2B, 12.8% growth). Key findings from [Gartner MQ for Revenue Action Orchestration](https://pipeline.zoominfo.com/sales/revenue-intelligence-platforms) (Dec 2025):

- **Gong** ($500M ARR, May 2026): Revenue Graph trained on 3B interactions. Strong on post-call analysis and coaching. Weak on pre-call intelligence. $1,600/user/yr + platform fee.
- **Clari+Salesloft** ($450M ARR combined): Forecasting + engagement merged. MCP Server opens data to Claude (Apr 2026). Cross-platform Plays (Mar 2026). Unification "coming years" away.
- **Market gap:** Most tools are strong on **post-call analysis** but weak on **pre-meeting preparation**. This is exactly where PAI builds.
- **Best practice:** AI meeting prep in 2 minutes vs 20 minutes manual. Top performers spend 6x more time on pre-call research. Buyers trust prepared reps more and share more information.
- **Three-phase model:** Before (prep) → During (capture) → After (summary + follow-up + persist). PAI currently covers Before only. The runbook evolution bridges all three.

### 13.8 Verification Framework — Testing & Accuracy

Every phase ships with verification at three layers. No phase is complete until all three pass.

**Layer 1 — API correctness (automated, runs every commit):**
| Test | What it verifies | Pass criteria |
|------|-----------------|---------------|
| Gmail query coverage | Alias-based search returns ≥ domain+formal search | Count from alias query ≥ count from formal query for 3 test customers |
| Meeting-context signal production | Module produces signals when email+calendar data exists | ≥1 signal with type=meeting-context for customer with known email threads |
| Engagement Timeline build | Deterministic builder produces timestamped entries from graph | ≥3 entries for Workday (known 17 engagements), each with date + source |
| Assets table format | TDP block renders as markdown table, not blockquotes | Regex validates `\| Asset \|` table structure, no `> **Aligned to:**` |
| Attendee enrichment | Profiles include company + email | Every attendee line matches `**Name** at Company (email@domain)` |
| Action item carry-forward | Prior meeting's open items appear in new generation | Re-generation includes ≥1 item tagged `[carry-forward]` |
| Link validation | All markdown links resolve to valid URLs | 0 self-referential links, 0 PRM API URLs, 0 404s from static links |

**Layer 2 — Document formatting (Playwright, runs after build):**
| Test | What it verifies | Pass criteria |
|------|-----------------|---------------|
| HTML rendering | All 9 sections render with Red Hat styling | Screenshot comparison: section count = 9, all h2 headers red |
| Table integrity | Partner table and assets table render as single tables | No split tables (table-count check per section) |
| Link rendering | All links are clickable with full text (not truncated) | No `...` in link text, all `<a>` tags have `href` |
| Badge sanity | "Mission Critical" not badged, URLs not corrupted | Zero `<span class="badge-*">` inside `href` attributes |
| Mobile readability | Content readable at 375px viewport | No horizontal scroll, text not clipped |

**Layer 3 — Intelligence accuracy (manual + automated, per customer):**
| Test | What it verifies | Pass criteria |
|------|-----------------|---------------|
| Email coverage | System finds same emails as manual Gmail search | Side-by-side: system count ≥ 80% of manual search count |
| Customer quote fidelity | Quotes in §3 match actual email text | Spot-check 3 quotes against source emails |
| Pipeline accuracy | Dollar amounts, dates, opp names match Salesforce | Every $ figure traceable to pipeline data |
| Case accuracy | Case numbers, severity, descriptions match RH Portal | Every case# exists and severity matches |
| Attendee accuracy | Names, titles, companies match LinkedIn/calendar | Zero wrong names (the §12.2 Workday bug class) |

**Regression gate:** Full test suite (unit + integration) must pass with 0 new failures before any commit. Consumer output verification chain (API → UI → rendered output → goal statement) required for every change touching meeting-prep-service.ts.

**Validation test cases:**
1. **Dropbox** (current gap customer): Must produce ≥8 emails, engagement timeline with ≥3 sourced entries, Level Up partner context, clean assets table
2. **Workday** (gold standard): Must maintain current quality — 4+ Recent Interactions with source links, attendee-based questions, product-matched team
3. **New customer with no history**: Must gracefully produce a useful prep from public intelligence only (no emails, no graph = standalone mode)

### 13.9 Vertical Slice Decomposition

Phase 1 decomposes into vertical slices via `/to-issues` after council review. Each slice is independently shippable and testable:

**Expected slices (Phase 1):**
1. Gmail query alias fix (XS) — customer.ts one-line change + regression test
2. Wire meeting-context signals into meeting-prep-service (S) — import, merge, verify in output
3. Engagement Timeline deterministic builder (S/M) — graph query, chronological build, source links
4. Assets table formatting (S) — replace blockquote TDP dump with clean table
5. Attendee company/email enrichment (XS) — deterministic override fix (already shipped partially)

Each slice gets its own issue with ACs, ships through the harness (SCOPE → BUILD → VERIFY → CLOSE), and has Layer 1 + Layer 2 tests before merge.

**Phase 2 and 3** decompose into slices after Phase 1 ships and we validate the foundation.

### 13.10 Council Review Findings (2026-07-16)

Three-perspective review (architecture, risk, gaps) on §13.1–13.9.

**Architecture findings:**
1. **routeSignal() update required** — §3 Engagement Timeline is a new template section. `routeSignal()` in `signal-templates.ts` needs a route for meeting-context signals → 'engagement-timeline'. Without this, signals fall to 'other' and are invisible. **→ Added to Phase 1 Slice 2.**
2. **Other consumers benefit** — meeting-context signals should flow to ALL consumers (morning brief, playbook, campaign), not just meeting prep. Per PRINCIPLES.md pre-flight #4: "Does every consumer that should see this data actually see it?" **→ Phase 2 follow-up issue.**
3. **Graph is an index, not a content store** — Graph engagement nodes contain labels and metadata (e.g., `"email-invitation-dropbox-red-hat"`), not full email body text. Building §3 Engagement Timeline requires fetching actual content from email cache or Gmail API, not just reading graph node labels. **→ Phase 1 Slice 3 must read from email cache, not graph alone.**

**Risk findings:**
4. **Prompt size budget** — Current Gemini prompts are ~15K tokens. Adding email thread content + graph evidence + meeting-context signals could push to 50K+. Must set a token budget: cap email thread text at 3K tokens, evidence doc excerpts at 2K tokens, total additional context ≤ 8K tokens. **→ Constraint added to Phase 1 Slice 2.**
5. **Deduplication** — emails-module (domain-based) and meeting-context-module (attendee-based) may return overlapping emails. Signals from both will contain the same email thread. Must deduplicate by Gmail threadId before merging. **→ Added to Phase 1 Slice 2.**
6. **Timestamp normalization** — Emails (RFC 2822 date), calendar events (ISO 8601), Drive docs (ISO 8601 modifiedTime) use different formats. §3 chronological ordering needs a unified timestamp parser. **→ Added to Phase 1 Slice 3.**

**Gap findings:**
7. **Section rename ripple** — Changing "Recent Interactions" → "Engagement Timeline" affects: Gemini responseSchema field name, quality validator regex, HTML template section parsing, deterministic overrides, and meeting-prep-validator.ts. **→ Phase 1 Slice 3 must update all 5 locations.**
8. **Action item carry-forward source (Phase 2)** — Prior prep action items live in Google Docs (update-in-place). Extracting structured items requires parsing the previous doc. **→ Phase 2 issue.** For Phase 1, action items are Gemini-generated as today.
9. **Graph freshness** — If graph was built before latest emails arrived, Engagement Timeline will be incomplete. Should trigger graph rebuild before prep generation if stale > 2 hours. **→ Phase 2 issue (graph refresh before consumer generation).**
10. **Gmail API combined load** — Two search paths (customer.ts domain search + meeting-context attendee search) could hit 70+ messages. At 5 units/message, that's 350+ quota units. Below the 250/second limit but should be batched. **→ Constraint noted for implementation.**

**Dispositions:**
- Findings 1, 3, 4, 5, 6, 7 → incorporated into Phase 1 slice definitions
- Findings 2, 8, 9 → logged as Phase 2 follow-up issues
- Finding 10 → implementation constraint (no separate issue needed)

### 13.11 Intelligence Synthesis Rules (2026-07-27)

The §1 Meeting Objective must be a **correlation-driven synthesis**, not a generic "advance evaluations" statement. The system correlates these signals to determine WHY this meeting is happening and WHAT the commercial urgency is:

**Temporal proximity rules:**
| Signal Pattern | Correlation Logic | Output |
|---|---|---|
| Pipeline deal closes within 14 days of meeting date | Flag as **closing meeting** | "This is likely the last face-to-face before [deal name] ($[amount]) closes on [date]" |
| Pipeline deal closes within 30 days | Flag as **acceleration opportunity** | "[Deal name] closes [date] — use this meeting to advance" |
| Renewal within 60 days | Flag as **renewal review** | "September renewal requires count validation" |
| Unresolved email thread (no customer reply >7 days) | Flag as **open item requiring resolution** | "[Subject] — unresolved since [date], [person] is in the room" |
| Rescheduled meeting referencing this meeting's timeframe | Flag as **alignment opportunity** | "[Rescheduled meeting] moved to [date] — align scope at this onsite" |

**Organizer intent extraction:**
- Search email cache for organizer's planning emails (subject contains meeting name or "next meetings" or "onsite" or "agenda")
- Extract stated purpose verbatim as the primary objective
- Example: Carolanne's "Next meetings" email → "Red Hat briefing + review counts for September renewal + BVA kickoff with Stephan"

**MEDDPICC signal:**
- If a MEDDPICC doc was shared or updated within 14 days, the deal is being actively qualified → mention in objective

**Use case confirmation:**
- meeting-context module provides confirmed use cases from email correlation
- Confirmed use cases (not "exploring") should drive the Value Play narrative
- Example: "AWS cost optimization (confirmed)" → Value Play should connect to CCSP/Marketplace

**Prompt size budget (§13.10 finding #4, refined):**
Total Gemini prompt for playbook-derived meeting prep must not exceed ~25K chars of injected context. Budget allocation:
- Playbook sections: 6K chars (strategic position 1K, priorities 1K, product alignment 1.5K, expansion 1K, other 1.5K)
- Signal intelligence: 6K chars (score-ranked, highest first)
- Recent interactions: 3K chars
- Attendee research: 2K chars
- Evidence blocks: 3K chars
- Case/pipeline data: 2K chars
- Buffer: 3K chars

Sections overridden deterministically (§2 attendees, §3 timeline, §7 pipeline, §8 open items) do NOT need detailed data in the Gemini prompt — they're replaced post-generation.

### 13.12 Phase 1 Shipping Status (2026-07-27)

| # | Slice | Status | Evidence |
|---|---|---|---|
| #1005 | Gmail alias query fix | **SHIPPED** | 1→12 emails for Dropbox |
| #1006 | Wire meeting-context signals | **SHIPPED** (was already wired; graph path bug masked it) | routeSignal verified, templateMeetingContext verified |
| #1007 | Engagement Timeline deterministic | **SHIPPED** | Illumio timeline: 8 real entries from email+graph+history |
| #1008 | Assets table formatting | **SHIPPED** | Blockquote→table post-processing code in deterministic-overrides |
| #1009 | Attendee company name | **SHIPPED** | levelupla.com → "Level Up Technology" |
| #1013 | Pipeline empty (NEW) | **SHIPPED** | Graph path fix + deal node supplementation |
| #1014 | Closed cases as active (NEW) | **SHIPPED** | Status filter excludes Closed/Resolved/Cancelled |
| #1016 | Gemini truncation (NEW) | **IN PROGRESS** | Prompt size optimization — cap sections, remove redundancy |

## 14. Open Questions for Jason

1. **Template:** Should the playbook use the existing Red Hat branded template (same as discovery/meeting-prep), or do you want a different layout? The current template is session-oriented (Session 1-4 headings) which doesn't map naturally to playbook sections.

2. **Customer-facing version:** When you produce the customer PDF, which sections get included? Presumably Section 4 (Solution Recommendation) and Section 5 (Resources) but NOT Section 6 (Gap Analysis) or Section 7 (Team Alignment)?

3. **Gemini vs Claude for synthesis:** The current workflow uses Gemini (`Inference.ts`) for content generation. Should the playbook synthesis also use Gemini, or should it use Claude (the skill is already running in a Claude session)?

4. **Email depth:** 90 days of email history — is that enough, or should we go deeper for accounts with longer engagement cycles?

5. **Subscription data:** The Supportable sheet structure varies. Do you have a standard column layout, or does the skill need to handle multiple formats?

---

*Spec authored by Serena Blackwood — July 13, 2026*
