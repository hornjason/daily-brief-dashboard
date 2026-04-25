---
Last validated: 2026-04-24
---

# Data Rules (do not regress)

- Never overwrite non-empty cache with empty results (stale-overwrite guard)
- Always pass `knownSheetIds` to bypass Drive BFS (quota protection)
- Tab matching: word-boundary regex for names <= 4 chars (prevents "EBS" matching "Webster")
- Pipeline dedup by `oppNumber` across shared SF reports
- Territory sync: auto-add new customers, flag removals (never auto-delete)
- Customer names come from territory Google Sheet — not manual entry
