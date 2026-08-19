---
doc-type: architecture
status: active
owner: jason
updated: 2026-08-19
---

# Council Findings: Campaign Polish Pass Architecture

**Convened by:** Serena Blackwood (Architect)
**Date:** 2026-08-19
**Scope:** Universal LLM polish pattern for all DailyBriefDashboard consumers

---

## Scoring Matrix (1-5 per criterion)

| Option | Reliability | Reusability | Simplicity | Quality | Maintainability | Total |
|--------|:-----------:|:-----------:|:----------:|:-------:|:---------------:|:-----:|
| A: Placeholder isolation | **5** | **5** | **4** | **4** | **5** | **23** |
| B: HTML-first polish | 2 | 3 | 2 | 3 | 2 | 12 |
| C: Skip polish entirely | **5** | **5** | **5** | 2 | **5** | 22 |
| D: Polish before links | 3 | 3 | 3 | 4 | 3 | 16 |
| E: Per-paragraph polish | 4 | 4 | 3 | 4 | 3 | 18 |

---

## Recommendation: Option A — Placeholder-based Link Isolation

### Why this wins

The fundamental constraint is a **separation of concerns violation**. The current code asks Gemini to do two things simultaneously: (1) rewrite prose for natural flow, and (2) preserve structural markup. These objectives conflict — LLMs treat markup as editable text by default. Every prompt instruction saying "preserve this" is a brittle assertion fighting the model's training.

Option A enforces the separation mechanically:
- **Code handles structure** — extracts links, replaces with numbered placeholders, restores after polish
- **LLM handles prose** — rewrites clean natural-language text with no markup to destroy

This is the same principle as parameterized queries in SQL. You don't ask the database to "please don't interpret this string as SQL" — you separate the data channel from the instruction channel. Similarly, you don't ask Gemini to "please don't rewrite these links" — you remove them from its input entirely.

### Why not the others

**Option B (HTML-first)** changes the format but not the fundamental problem. Gemini strips `<a>` tags almost as readily as it strips `[text](url)`. The friction report already notes this risk. You're still asking an unreliable transform to preserve structure — just different structure.

**Option C (Skip polish)** scores 22/25 but fails on the one criterion that matters most for sales emails: **quality**. Template-assembled text reads like a template. Sales emails that sound mechanical lose deals. The 2-point quality gap is a dealbreaker — this is a B2B outreach tool, not a reporting system.

**Option D (Links after polish)** requires text matching to insert links after Gemini rewrites. If Gemini changes "Red Hat Ansible Automation Platform" to "Ansible" (which it does), the product-name-to-link matcher breaks. This trades one fragile text-matching problem for a different one.

**Option E (Per-paragraph)** reduces blast radius but doesn't eliminate the root cause. If any polished paragraph contains a link, you're back to the same bug. E is a scope reducer, not a solution. It's useful as a future enhancement *on top of* Option A, not instead of it.

### Alignment with PRINCIPLES.md

Option A directly implements the architectural principle from Layer 2:
> "Deterministic sections are TEMPLATED from signals — never sent to Gemini for editorial judgment."

Links are deterministic structure. They should never enter the LLM's edit scope. Option A makes this mechanical.

---

## Implementation: Minimal Changes

### New function: `isolateLinks()`

```typescript
interface LinkPlaceholder {
  placeholder: string    // e.g. "REF1"
  linkText: string       // e.g. "SSP Product Updates"
  url: string            // e.g. "https://..."
}

function isolateLinks(body: string): { cleanBody: string; links: LinkPlaceholder[] } {
  const links: LinkPlaceholder[] = []
  let counter = 0
  const cleanBody = body.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, text, url) => {
    counter++
    const placeholder = `REF${counter}`
    links.push({ placeholder, linkText: text, url })
    return placeholder
  })
  return { cleanBody, links }
}

function restoreLinks(polished: string, links: LinkPlaceholder[]): string {
  let result = polished
  for (const { placeholder, linkText, url } of links) {
    result = result.replace(placeholder, `[${linkText}](${url})`)
  }
  return result
}
```

### Changes to `polishEmailBody()` (campaign-html-template.ts:1686-1763)

1. **Before calling Gemini (line ~1716):** Call `isolateLinks(rawBody)` to get `cleanBody` and `links`
2. **Send `cleanBody` to Gemini** (not `rawBody`) — Gemini sees "REF1", "REF2" instead of markdown links
3. **After Gemini returns (line ~1730):** Call `restoreLinks(polished, links)` to put links back
4. **Delete the re-injection block** (lines 1736-1752) — no longer needed
5. **Update the prompt** (line 1705): Remove "Preserve ALL URLs and markdown links" instruction. Replace with "Text contains reference markers (REF1, REF2, etc.) — keep these markers in place. Do not remove, rename, or merge them."

### Consumer generalization

Extract `isolateLinks()` and `restoreLinks()` to `src/lib/link-isolation.ts`. Every consumer that uses Gemini polish imports from there. The pattern is:

```
raw text with [links](urls)
    ↓ isolateLinks()
clean text with REF1, REF2
    ↓ callGemini() — prose polish
polished text with REF1, REF2
    ↓ restoreLinks()
polished text with [links](urls)
```

This is the universal pattern for all consumers. Meeting prep, account plans, playbooks — any consumer that needs LLM polish on text containing structured references uses the same isolation/restoration cycle.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|:----------:|------------|
| Gemini removes placeholder markers (REF1) | Low | Add assertion: if any REF not found in output, fall back to rawBody |
| Gemini splits text around a placeholder awkwardly | Medium | Accept — a slightly awkward sentence near a link is better than a broken link |
| Multiple links with same anchor text | Low | Placeholders are numbered (REF1, REF2), not text-based — each is unique |
| Placeholder appears in natural text | Very Low | "REF1" is unlikely in sales email prose. If paranoid, use `{{LINK_REF_1}}` |

---

## Acceptance Criteria

1. **Zero broken links in polished output** — Run campaign generation for 3 customers, verify every `[text](url)` in raw body appears intact in polished body
2. **Link re-injection code deleted** — `campaign-html-template.ts` lines 1736-1752 are removed. No regex-based link restoration anywhere in the codebase
3. **Isolation functions are shared** — `src/lib/link-isolation.ts` exists with `isolateLinks()` and `restoreLinks()`, imported by `campaign-html-template.ts`
4. **Placeholder preservation verified** — Gemini prompt instructs preservation of REF markers; assertion falls back to rawBody if any REF is missing
5. **No double-link artifacts** — `markdown-to-html.ts` bare URL catch-all (line 35) no longer creates duplicate links because Gemini never sees or partially preserves URLs
6. **Pattern documented** — ADR created documenting the link isolation pattern as the standard for all consumers needing LLM polish

---

## Follow-up Work (not blockers)

- **Cross-email coordination** (friction report #3) — `usedPeerCompanies` tracking, opener diversity. Separate issue, not related to polish architecture.
- **Field truncation** (friction report #2) — Increase 80-char objective limit. Separate issue.
- **Option E as enhancement** — After A ships and stabilizes, consider segment-based polish (only send opener/context paragraphs to Gemini, keep bullets/CTA deterministic). This is an optimization, not a requirement.
