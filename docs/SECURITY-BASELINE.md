---
doc-type: reference
status: active
owner: jason
updated: 2026-05-03
---

# Security Baseline (do not regress)
*Last validated: 2026-04-13 | Owner: DA | Trigger: Any new API endpoint, Sheets write, error response pattern, Gemini prompt assembly, or cache path function added*

- `sanitizeCell()` on all Sheets writes before `valueInputOption: 'RAW'`
- `sanitizeErr(e)` on all API error responses — never return raw `e.message`
- `escapeXml()` on all values interpolated into brief XML sources
- Cache/config files written with `mode: 0o600`
- `dumpDom()` gated behind `CCSP_DEBUG=true` — never in production
- `sanitizeText()` rejects HTML tags (returns null -> 400), does not strip
- **Gemini prompt inputs** — all external/third-party data entering a Gemini prompt must be wrapped in `sanitizePromptInput(value, maxLen)` before interpolation. This includes: intelligence cache fields (company, industry), Drive doc filenames and content, pipeline records from external sheets, and any field not sourced from operator-controlled static config. Subscription summaries and pipeline oppNames already follow this rule — do not regress.
- **Cache path slug guards** — every `*CachePath(slug)` function must validate the slug with `/[^a-zA-Z0-9_-]/.test(slug)` and throw before calling `resolve()`. Pattern: `if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) throw new Error('[module] unsafe slug: "…"')`. Applied to: `briefCachePath`, `expansionCachePath`, `corpusCachePath`. All new cache path functions must follow this pattern.
- **isL3Only gate is UI-only — server enforces NODE_ROLE independently.** The `isL3Only` flag (from `/api/node-role`) hides L4-only UI surfaces on hero installs. It is NOT the security boundary. Server enforcement lives in `src/lib/node-role.ts` (`isPrimary()`, `assertPrimary()`). A spoofed `{ isL3Only: false }` response reveals buttons only — the server rejects those calls on a non-primary node. Never treat the client gate as the sole access control.
