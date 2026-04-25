---
Last validated: 2026-04-24
---

# UX Research Brief: Products Page Feature Radar

**Author:** Aditi Sharma, UX/UI Design
**Date:** 2026-04-05
**Scope:** Information architecture, card design, and interaction patterns for the Product Intelligence feature radar
**Audience:** Solutions Architects preparing for customer conversations

---

## 1. Current State Assessment

### What Works

The existing layout is structurally sound. Product sections are clearly delineated, status filter tabs provide immediate counts, search is per-product, and the 2-column card grid is a reasonable density for a dark-themed dashboard. The `FeatureCard` component is clean: name, status badge, version, description, tags, and a Learn More link. The status color palette (green/amber/blue/gray) is established and semantically correct.

### What Does Not Work

**Information architecture problems:**

- **Flat card grid treats all 73 features equally.** An SA preparing for a meeting does not need to scan 30 RHEL cards in a flat grid. The cognitive load is too high for a "what should I talk about?" workflow. Cards are individually readable but collectively overwhelming.

- **No temporal signal.** There is no way to see what changed recently. An SA returning after two weeks cannot distinguish features that appeared since their last visit from features that have been GA for three years.

- **Tech Preview features are visually under-differentiated.** They get an amber badge, the same visual weight as every other status. For SAs, Tech Preview is the highest-conversation-value status. It means "available for testing, not production" -- the exact kind of nuance SAs need to communicate accurately. A badge alone does not convey that weight.

- **No version-based filtering.** The `versionIntroduced` field exists in the data model but has no corresponding filter. SAs preparing for "what's new in RHEL 9.5?" conversations cannot isolate features by version.

- **Tags are decorative.** Tags render as pills but are not clickable or filterable. They consume card space without providing interaction value.

- **Confidence indicator is hidden.** The `confidence` field (HIGH/MEDIUM/LOW) exists in the data but is not rendered. For SA conversations, citing a LOW-confidence feature as fact is a professional risk.

---

## 2. Design Recommendations

### Priority 1: Add a "New / Recently Added" Temporal Signal

**Problem:** SAs cannot distinguish fresh features from long-standing ones.

**Recommendation:** Add a "New" badge (use existing `delta-new` / `delta-new-bg` tokens: `#58A6FF` on `rgba(88,166,255,0.10)`) to features extracted within the last 30 days. Render it as a small pill to the left of the status badge. Do not replace the status badge -- layer it.

**Implementation:** Compare `extractedAt` from the `ProductFeatureCache` against a 30-day threshold. This is a pure frontend calculation, no API change.

**Rationale:** Temporal relevance is the primary driver for SA conversation prep. "What's new?" is the most common question SAs answer.

### Priority 2: Elevate Tech Preview Visual Treatment

**Problem:** Tech Preview features deserve stronger visual differentiation because they carry specific conversation implications (available for testing, not production-supported).

**Recommendation:** Add a left border accent to Tech Preview cards. Use a 3px solid `amber-500` left border on the card container. This creates a visual "flag" effect that is scannable in the grid without requiring badge reading. The card already has `border border-border rounded-xl` -- override the left border only.

```
// Tech Preview card treatment
className={`bg-surface border border-border rounded-xl p-4 flex flex-col gap-2.5 ${
  feature.status === 'Tech Preview' ? 'border-l-[3px] border-l-amber-500' : ''
}`}
```

**Do not** use a full background tint. It would create too much visual noise in the grid and fight the dark theme. The left border is the correct amount of emphasis: visible in peripheral vision, not distracting when focused elsewhere.

**Rationale:** SAs need to spot Tech Preview features at a glance without reading every badge. The left border creates a visual lane that the eye follows down the grid.

### Priority 3: Version Filter Dropdown

**Problem:** SAs preparing for version-specific conversations ("what's new in OpenShift 4.16?") must manually scan all cards.

**Recommendation:** Add a version dropdown filter adjacent to the existing status filter tabs. Position it right-aligned on the same row as the tabs. Populate it from the unique `versionIntroduced` values in the feature set, sorted descending (newest first). Include an "All Versions" default.

**Implementation notes:**
- Extract unique versions from `features.map(f => f.versionIntroduced).filter(Boolean)`
- Sort using semver-aware comparison (split on `.`, compare numerically)
- This filter stacks with the status filter -- both apply simultaneously
- Show the count of matching features in the dropdown label: "v9.5 (8)"

**Rationale:** Version-specific conversations are the second most common SA use case after "what's new generally."

### Priority 4: Render Confidence Indicator

**Problem:** The `confidence` field exists but is invisible. SAs may cite LOW-confidence features as fact.

**Recommendation:** Show confidence as a subtle icon in the card footer, next to the tags. Use a three-tier indicator:
- HIGH: no indicator (clean default, most features are HIGH)
- MEDIUM: a small `~` icon or "approx" indicator in `text-text-secondary`
- LOW: a small warning triangle icon in `warning` color (`#D29922`)

**Do not** show confidence as text ("Low confidence") -- it reads as editorial judgment. An icon with a tooltip ("Source confidence: LOW -- verify before citing") is the correct pattern.

**Rationale:** SAs need to know what they can state as fact vs. what needs verification. Hiding this field creates professional risk.

### Priority 5: Make Tags Filterable

**Problem:** Tags consume card space but provide no interaction value.

**Recommendation:** Make tags clickable. Clicking a tag should populate the search field with that tag text and filter accordingly. This is a low-effort change: `onClick={() => setSearchTerms(prev => ({ ...prev, [slug]: tag }))}` on each tag pill.

**Additional improvement:** Add a tag cloud or faceted filter above the grid that shows the top 8 tags across all features in a product, with counts. This gives SAs a second axis for browsing beyond status.

**Rationale:** Tags like "security", "networking", "storage" map directly to SA conversation topics. Making them interactive turns them from decoration into navigation.

### Priority 6: Distinguish Slide-Sourced vs. Release-Note-Sourced Features

**Problem:** Features extracted from slides may have different fidelity than those from official release notes.

**Recommendation:** Do not create a strong visual distinction. Instead, add a subtle source indicator in the card footer -- a small icon (presentation icon for slides, document icon for release notes) that is visible but not prominent. The `slideSource` field already exists in the data model.

**Rationale:** Source provenance matters for SA credibility but should not dominate the visual hierarchy. An SA who clicks "Learn More" already gets the source URL. The icon is a lightweight provenance signal, not a primary navigation element. Over-emphasizing source type would create visual noise that competes with the more important status and recency signals.

---

## 3. Anti-Patterns to Avoid

### Do Not Switch to a Table Layout

Tables are tempting for information density but are wrong for this use case. SAs are browsing and scanning, not comparing row-by-row. Cards allow variable-length descriptions, tag wrapping, and visual status differentiation that tables cannot. The 2-column grid is the correct layout.

### Do Not Add Expandable/Collapsible Cards

Accordion patterns create interaction debt. Every collapsed card is a decision the user must make: "should I expand this?" For 30 RHEL features, that is 30 micro-decisions. The current card height with 2-4 sentence descriptions is the right density. If descriptions are too long, truncate with a "..." and make the full text available on hover or in a detail panel.

### Do Not Add Drag-and-Drop Reordering

Custom ordering creates state that must be persisted and maintained. SAs visit this page for quick reference, not to curate a personal view. Sorting by status and recency covers the use case.

### Do Not Introduce a Kanban/Column View by Status

Kanban columns (GA | Tech Preview | Roadmap | Deprecated side by side) waste horizontal space and make counts uneven. RHEL with 24 GA features and 6 Tech Preview would create a massively lopsided layout. The filter tabs are the correct pattern for status-based browsing.

### Do Not Add Inline Editing

This is a read-only intelligence surface, not a content management tool. Feature data comes from extraction pipelines. Any editing would create data inconsistency on the next refresh.

---

## 4. Implementation Priority Matrix

| Priority | Change | Effort | SA Value | Risk |
|----------|--------|--------|----------|------|
| P1 | "New" temporal badge | Low (frontend only) | Very High | None |
| P2 | Tech Preview left border accent | Trivial (CSS only) | High | None |
| P3 | Version filter dropdown | Medium (new component) | High | Low |
| P4 | Confidence indicator | Low (icon + tooltip) | Medium | None |
| P5 | Clickable tags | Low (event handler) | Medium | None |
| P6 | Source type indicator | Low (icon) | Low | None |

**Recommended implementation order:** P1 and P2 can ship together as a single change (under 30 minutes of work). P3 is the most complex and should be its own pass. P4 and P5 can ship together. P6 is optional and can wait.

---

## 5. Open Questions for User Research

These questions would benefit from direct SA feedback if available:

1. **Feature grouping:** Would SAs prefer features grouped by domain (security, networking, storage) rather than flat alphabetical? This would require a `category` field in the data model.

2. **Comparison view:** Do SAs ever need to compare features across products (e.g., "show me all Tech Preview features across RHEL, OpenShift, and AAP")? The current per-product section layout makes cross-product comparison impossible.

3. **Customer relevance tagging:** Would SAs value the ability to "star" or flag features relevant to specific customers? This would require a lightweight per-user state layer, which the current architecture intentionally avoids.

4. **Print/export:** Do SAs print or export feature lists for offline use in customer meetings? If so, the card layout needs a print-optimized CSS media query.

---

## 6. Summary of Recommended Card Anatomy

Current card structure with proposed additions marked:

```
+-----------------------------------------------+
| [NEW]  Feature Name              [Tech Preview]|  <-- NEW badge (P1), status badge
| v9.5                                           |  <-- version pill (existing)
|                                                |
| Description text, 2-4 sentences of context     |  <-- existing
| about the feature and its SA-relevant details. |
|                                                |
| [security] [networking]     [~]  Learn more -> |  <-- clickable tags (P5),
|                              ^                  |      confidence icon (P4),
|                              confidence         |      source icon (P6)
+-----------------------------------------------+
  ^-- 3px amber left border for Tech Preview (P2)
```

This preserves the existing card structure while layering in the recommended improvements. No card height change, no layout reflow, no new interaction patterns that break the browse-and-scan workflow.
