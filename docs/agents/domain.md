---
doc-type: reference
status: active
owner: jason
updated: 2026-05-01
---

# Domain Docs

This repo uses a **single-context** layout.

- **Domain glossary:** `CONTEXT.md` at the project root (if it exists) — check here for canonical entity names before writing issues, briefs, or PRDs
- **ADRs:** `docs/archive/adr/` — read-only; record closed architectural decisions. Never re-litigate these without explicit instruction
- **Architecture:** `ARCHITECTURE.md` at project root — intentional patterns that look like anti-patterns; read before suggesting structural changes
- **Principles:** `PRINCIPLES.md` at project root

## Intentional patterns (do not flag as issues)

- Shared browser context — intentional; isolation breaks Tableau SSO
- No auth middleware — intentional; single-user localhost-only app
- Config files mutated at runtime — intentional; config IS the persistence layer
- In-memory mutex — safe; single-threaded Bun process

## Protected files (never modify without explicit instruction)

- `src/rh-scraper.ts`, `src/ccsp-scraper.ts`, `src/sf-scraper.ts`, `src/scraper-manager.ts` — read `docs/SCRAPER-RULES.md` first
