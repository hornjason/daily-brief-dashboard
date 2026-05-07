---
doc-type: adr
status: active
owner: jason
updated: 2026-05-07
---

# ADR-017: CCSP Column Detection by Content Pattern

**Status:** PROPOSED  
**Date:** 2026-05-07  
**Author:** Serena Blackwood (Architect Agent)  
**References:** `src/lib/ccsp-resolvers.ts` lines 234-280 (`parseCcspRows`)

---

## Context

`parseCcspRows` identifies columns exclusively by header text matching. When Tableau exports shift column positions or rename headers (which happens when report views change), the parser silently produces wrong data or returns zero records.

Current header-only detection (lines 242-252):

```ts
const acctCol = headers.findIndex((h) => {
  const lower = h.toLowerCase()
  return lower === 'account name' || lower === 'account' || ...
})
```

Observed failure: header says "Account Name" but the column contains 18-character Salesforce IDs (`001f200001S9RH3AAN`). The parser trusts the header, emits SF IDs as account names, and downstream consumers render garbage.

The fundamental constraint is that Tableau CSV exports are a **schema-unstable interface** — we control neither the column order nor the header labels. Header names are a hint, not a contract. Content patterns are the actual invariant.

---

## Decision

**Add a content-pattern detection layer that runs before header-name matching, validates agreement between the two approaches, and logs mismatches.**

The detection pipeline becomes:

```
1. Sample first N data rows (N = min(10, rows.length - 1))
2. For each column, run pattern classifiers against sampled values
3. Score each column against each known field type
4. Build ColumnMapping from pattern scores (highest confidence wins)
5. Build ColumnMapping from header names (existing logic)
6. Merge: pattern detection is primary; header names break ties
7. Log any disagreements at WARN level
```

### Pattern Detection Rules

Each required field has a **content fingerprint** — a set of regex patterns and statistical checks applied to sampled column values.

| Field | Pattern Rule | Confidence Threshold |
|---|---|---|
| `accountName` | String values; contains comma/period/space; NOT matching SF ID pattern (`/^[0-9A-Za-z]{15,18}$/`); NOT matching territory code pattern; average length > 5 chars | 0.7 |
| `acvPlus` | Numeric or currency-formatted (`$1,234.56`); after stripping `[$,]`, `parseFloat` succeeds on >= 80% of non-empty cells | 0.8 |
| `quarter` | Matches `/^\d{4}-Q[1-4]$/` or `/^FY\d{2}\s*Q[1-4]$/i` on >= 60% of non-empty cells | 0.9 |
| `closeDate` | Matches ISO date (`/^\d{4}-\d{2}-\d{2}/`) or US date (`/^\d{1,2}\/\d{1,2}\/\d{2,4}/`) on >= 60% of non-empty cells | 0.85 |
| `cloudPartner` | Values are a small set containing "AWS", "Amazon", "Google", "Microsoft", or "Other" — unique value count <= 10 AND >= 50% of values match known partner keywords | 0.75 |
| `territory` | Matches `/^[A-Z_]{10,}$/` (uppercase + underscores, long codes like `WEST_COMM_CORP_NORTHWEST_TERR01`) on >= 50% of non-empty cells | 0.85 |
| `sfId` | Matches `/^[0-9A-Za-z]{15,18}$/` (Salesforce ID format) on >= 80% of non-empty cells | 0.95 |
| `productOfferingGroup` | Column index 18 (positional); string values from known set (`RHEL`, `OpenShift`, `Ansible`, etc.) on >= 40% of non-empty cells | 0.6 |

**Negative patterns are as important as positive ones.** The `accountName` classifier explicitly rejects columns that match SF ID or territory patterns. This prevents the exact failure mode observed in production.

### Ambiguity Resolution

When multiple columns score above threshold for the same field type:

1. **Highest confidence wins.** If column 3 scores 0.92 for `accountName` and column 7 scores 0.71, column 3 is selected.
2. **No column may be assigned to two fields.** Once a column is claimed by a higher-confidence match, it is removed from the candidate pool for remaining fields.
3. **If tied (within 0.05):** fall back to header-name matching as the tiebreaker.
4. **If still tied:** prefer the leftmost column (Tableau exports tend to place primary identifiers left).

### Sample Size

- Sample the first `min(10, dataRows.length)` data rows.
- Skip entirely empty rows in the sample.
- A column needs at least 3 non-empty values in the sample to be classified. Below that threshold, the column is marked `low-sample` and header-name matching is used instead.
- This keeps detection under the 50ms budget. Ten rows times ~30 columns = ~300 regex checks, which is sub-millisecond work.

---

## Fallback Strategy

The system uses a **trust hierarchy**:

```
Pattern detection (primary)
  |
  v  disagree?  --> log WARN, use pattern result
  |
Header-name matching (secondary)
  |
  v  pattern detection failed (low-sample / no match)?  --> use header result
  |
Neither matched --> return empty records + log ERROR
```

**When pattern and header agree:** High confidence. No log entry needed.

**When pattern and header disagree:** Use the pattern result. Log at WARN level:

```
[ccsp-detect] MISMATCH sheet {id}: header says col 1 is "Account Name" 
but content pattern classifies it as sfId (confidence: 0.95). 
Using pattern detection result.
```

**When pattern detection has insufficient data:** Fall back to header-name matching (existing behavior). Log at INFO level:

```
[ccsp-detect] LOW-SAMPLE sheet {id}: col 1 has <3 non-empty values 
in sample. Falling back to header-name matching.
```

**When neither approach finds a required column (accountName, acvPlus):** Return empty array (existing behavior). Log at ERROR level with both header list and pattern scores for debugging.

---

## Implementation Approach

### New Types

```ts
/** Confidence that a column contains a specific field type. */
interface ColumnScore {
  field: string          // 'accountName' | 'acvPlus' | 'quarter' | ...
  columnIndex: number
  confidence: number     // 0.0 - 1.0
  method: 'pattern' | 'header' | 'both'
}

/** Final resolved column positions. */
interface ColumnMapping {
  acctCol: number        // -1 if not found
  acvCol: number
  qtrCol: number
  closeDateCol: number
  partnerCol: number
  territoryCol: number   // new: not currently extracted
  scores: ColumnScore[]  // full scoring for diagnostics
  mismatches: string[]   // human-readable mismatch descriptions
}
```

### New Function

```ts
export function detectColumnsByPattern(
  rows: unknown[][],
): ColumnMapping
```

- Pure function, no I/O.
- Takes the full row set (header + data rows).
- Returns `ColumnMapping` with confidence scores.
- Exported from `ccsp-resolvers.ts` alongside `parseCcspRows`.

### Integration Point

Inside `parseCcspRows`, replace the current header-only detection block (lines 241-252) with:

```ts
const mapping = detectColumnsByPattern(rows)
for (const m of mapping.mismatches) {
  console.warn(`[ccsp-detect] ${m}`)
}

const acctCol = mapping.acctCol
const acvCol = mapping.acvCol
const qtrCol = mapping.qtrCol
const closeDateCol = mapping.closeDateCol
const partnerCol = mapping.partnerCol
```

**Backward compatibility:** The `parseCcspRows` function signature does not change. The `ColumnMapping` type is internal to the detection step. Callers of `parseCcspRows` see the same `CCSPRecord[]` output.

### Hardcoded Column Index 18

The current code hardcodes `row[18]` for `productOfferingGroup`. The pattern detector should attempt to identify this column by content (known product names). If pattern detection finds it at a different index, use the detected index. If pattern detection cannot classify it (low confidence), fall back to index 18. Log a warning if the detected index differs from 18.

---

## Testing Strategy

### Unit Tests with Known-Good Format

```ts
// Headers match positions. Pattern and header agree.
const goodRows = [
  ['Account Name', 'Fiscal Year Quarter', 'Opportunity Close Date', 'Financial Partner', 'ACV Plus'],
  ['Acme Corp', '2025-Q1', '2025-03-15', 'AWS', '1234.56'],
  ['Globex Inc', '2025-Q2', '2025-06-30', 'Google', '5678.90'],
]
// Expect: all columns detected, zero mismatches, high confidence
```

### Unit Tests with Broken Header Format

```ts
// Headers are WRONG — positions shifted. Pattern detection must override.
const brokenRows = [
  ['Account Name', 'Territory', 'ACV Plus'],           // header lies
  ['001f200001S9RH3AAN', 'Acme Corp', '1234.56'],      // col 0 is SF ID, col 1 is account name
  ['001f200001XYZABC', 'Globex Inc', '5678.90'],
]
// Expect: acctCol = 1 (not 0), mismatch logged for col 0
```

### Unit Tests with Future Format Changes

```ts
// New columns added, order changed, new header names.
const futureRows = [
  ['SF Opportunity ID', 'Company', 'Region Code', 'FY Quarter', 'Deal Value (ACV+)'],
  ['001f200001S9RH3AAN', 'Acme Corp', 'WEST_COMM_CORP_01', '2026-Q1', '9999.99'],
]
// Expect: pattern detection finds accountName=1, quarter=3, acvPlus=4
// Header fallback would fail on "Deal Value (ACV+)" — pattern detection saves it
```

### Edge Case Tests

- **All-empty sample rows:** Falls back to header-only. No crash.
- **Single data row:** Sample size = 1, below threshold for most classifiers. Header fallback.
- **Duplicate high-confidence matches:** Greedy assignment resolves without crash.
- **No account name column at all:** Returns empty array with ERROR log.
- **Mixed date formats in same column:** Confidence score reflects the mix; still classifies if majority matches.

### Performance Test

- 10 rows x 39 columns (A:AM range) completes in under 5ms.
- Assertion: `detectColumnsByPattern` execution time < 50ms for 100 rows x 50 columns.

---

## Consequences

### Positive

- **Resilience to Tableau format drift.** The primary failure mode (headers don't match content) is eliminated. The system self-heals when columns shift.
- **Diagnostic visibility.** Mismatch logging reveals format changes immediately, rather than silently producing wrong data that surfaces days later in customer briefs.
- **Testable in isolation.** `detectColumnsByPattern` is a pure function — no Sheets client, no network. Mock data exercises every classification rule.
- **Future-proof.** Adding a new column type requires only adding a new pattern classifier entry — no changes to the detection framework itself.

### Negative

- **Maintenance of pattern rules.** Each column type needs a regex/heuristic that must be updated if Tableau fundamentally changes value formats. This is unlikely (SF IDs, ISO dates, and currency formats are stable) but not zero-cost.
- **False positive risk.** A column of short company names (e.g., "IBM", "SAP") could score low on the `accountName` classifier because average length is short and no commas/periods are present. Mitigation: the negative-pattern checks (not SF ID, not territory code) still differentiate correctly. Header name acts as tiebreaker.
- **Slight complexity increase.** The detection pipeline adds ~80 lines of pure logic. This is justified by the production failure it prevents.

---

## Implementation Notes

1. **Phase 1 (ship first):** Implement `detectColumnsByPattern` with classifiers for the 5 currently-used fields (accountName, acvPlus, quarter, closeDate, cloudPartner). Wire into `parseCcspRows`. Add unit tests for all three scenarios (good/broken/future).

2. **Phase 2 (optional):** Add territory and sfId classifiers. These are not currently extracted into `CCSPRecord` but would enable future fields without re-engineering detection.

3. **Phase 3 (optional):** Persist detected `ColumnMapping` to a diagnostic cache so the admin UI can show "last detected column layout" per sheet. Useful for debugging Tableau format changes without reading logs.

4. **Do not add productOfferingGroup to the known-set classifier until we have >20 distinct product names validated.** The current hardcoded-set approach risks false negatives on new product lines. Index-18 fallback is safer short-term.
