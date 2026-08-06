---
doc-type: adr
status: accepted
owner: jason
updated: 2026-08-06
---

# ADR-042: Data Hygiene — Zero Real Data in Source or Committed Config

**Date:** 2026-08-06
**References:** #163 (Umbrella: DDB open-source sanitization), #164, #165, PRINCIPLES.md (Pre-flight Questions)
**Deciders:** Jason Horn (owner), Rayford (DA)
**Trigger:** Sanitization audit (#163) found 31 items across source, config, and test fixtures containing org-specific URLs, real customer names, internal hostnames, and hardcoded credentials. These items block open-source readiness and create security risk if the repository is ever shared or forked.

## Status

Accepted

## Context

### The Problem: Real Data Embedded in Source

The DailyBriefDashboard codebase accumulated org-specific data throughout development: Salesforce instance URLs, real customer names in test fixtures, internal Google Drive folder IDs, Red Hat-specific hostnames, and API credentials stored as string literals. This was expedient during single-developer development but creates three risks:

1. **Security exposure.** Credentials and internal URLs in source code are accessible to anyone with repository access. Git history preserves them even after deletion.
2. **Open-source blocker.** The repository cannot be shared, forked, or demonstrated without exposing org-specific infrastructure details.
3. **Environment coupling.** Hardcoded URLs and IDs break when infrastructure changes. Environment variables are the standard solution.

### Audit Findings

The sanitization audit (#163) identified 31 items across 4 categories:

| Category | Count | Examples |
|----------|-------|---------|
| Org-specific URLs | 12 | Salesforce instance URLs, internal dashboard links, Tableau endpoints |
| Real customer data | 8 | Customer names in test fixtures, slug references in config |
| Personal identifiers | 5 | Email addresses, team member names in source |
| Hardcoded credentials | 6 | API keys, Drive folder IDs, service account references |

Each item was remediated in #164 (source cleanup) and #165 (config externalization).

## Decision

### Five Zero-Rules for Data Hygiene

Every commit to this repository must satisfy these five rules. Violations are caught by the enforcement stack (pre-commit hook + Control Plane scanner + architecture compliance test).

#### Rule 1: Zero org-specific URLs in source

No Salesforce instance URLs, internal dashboard links, Tableau endpoints, or org-specific service URLs in `.ts`, `.tsx`, or `.json` source files. All external URLs must come from environment variables or runtime configuration.

**Pattern:**
```typescript
// BAD: hardcoded org URL
const SF_URL = 'https://redhat.my.salesforce.com'

// GOOD: environment variable
const SF_URL = process.env.SALESFORCE_INSTANCE_URL
```

#### Rule 2: Zero real customer data in source or fixtures

No real customer names, account IDs, or org-specific identifiers in source code, test fixtures, or configuration templates. Test fixtures use synthetic data (`acme-corp`, `test-customer-1`).

**Pattern:**
```typescript
// BAD: real customer in fixture
{ "customerName": "Fred Hutchinson Cancer Center", "slug": "fred-hutch" }

// GOOD: synthetic customer
{ "customerName": "Acme Corp", "slug": "acme-corp" }
```

#### Rule 3: Zero personal identifiers in source

No real email addresses, team member names, phone numbers, or employee IDs in source files. Use placeholder values (`user@example.com`, `Jane Doe`).

#### Rule 4: Zero hardcoded credentials or secrets

No API keys, tokens, passwords, service account paths, or OAuth client IDs in source. All secrets load from environment variables or `.env` files (which are `.gitignore`d).

**Pattern:**
```typescript
// BAD: credential in source
const API_KEY = 'sk-abc123...'

// GOOD: environment variable
const API_KEY = process.env.API_KEY
```

#### Rule 5: Zero internal infrastructure IDs in source

No Google Drive folder IDs, Slack channel IDs, internal hostnames, or infrastructure-specific identifiers in source. These go in environment variables or `config-example` files with placeholder values.

### Configuration Template Pattern

For config files that require structure but not real values, maintain a `-example` template:

```
config/salesforce.json        → .gitignore'd, contains real values
config/salesforce-example.json → committed, contains placeholder values
```

The example file documents required fields and expected format. The real file is created locally or injected by the deployment environment.

## Consequences

**Positive:**

- **Open-source ready.** Repository can be shared without exposing org-specific data.
- **Security posture.** No credentials in git history from this point forward. Prior history addressed in #164.
- **Environment portability.** Switching Salesforce instances, Drive folders, or API providers requires only environment variable changes, not code changes.
- **Onboarding clarity.** Config-example files document every required environment variable with expected format.

**Negative:**

- **Environment setup overhead.** New installs require populating environment variables from the example templates. Mitigated by the setup wizard (bootstrap).
- **Enforcement maintenance.** Scanner patterns must be updated when new categories of sensitive data are introduced.

**Risks:**

- **Git history.** Prior commits still contain real data. History rewriting is out of scope for this ADR — addressed separately in #164.
- **False positives.** Scanner patterns may flag legitimate test data that resembles real data. The scanner should support allowlisting with justification comments.

## Enforcement Stack

Three layers catch violations before they reach the repository:

| Layer | Mechanism | When |
|-------|-----------|------|
| Pre-commit hook | `scripts/hooks/pre-commit` scans staged files for sensitive patterns | Every commit |
| Control Plane scanner | `scanSensitiveData()` audits the full codebase | On demand + scheduled |
| Architecture compliance test | `architecture-compliance.test.ts` verifies no regressions | Every `bun test` run |

## PRINCIPLES.md Update

Added pre-flight question Q23: "Does this change introduce any org-specific URLs, real customer data, personal identifiers, or hardcoded credentials? (ADR-042)"

Added to cross-reference index:

| Pre-flight # | ADR | Question |
|---|---|---|
| 23 | ADR-042 | Data hygiene: no org-specific data in source |

## References

- GitHub #163 (Umbrella: DDB open-source sanitization)
- GitHub #164 (Source cleanup — remove org-specific data)
- GitHub #165 (Config externalization — env vars + examples)
- `PRINCIPLES.md` Pre-flight Question 23
- `MODEL.md` Data Hygiene section
