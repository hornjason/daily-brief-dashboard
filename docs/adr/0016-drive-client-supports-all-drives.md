---
doc-type: adr
status: active
owner: jason
updated: 2026-05-01
---

# `supportsAllDrives: true` is always-on in DriveFolderClient

**Date:** 2026-05-01

Every `drive.files.list` and `drive.files.create` call inside `src/lib/drive-client.ts` includes `supportsAllDrives: true` and `includeItemsFromAllDrives: true` unconditionally. This is not configurable per-call.

The L3 shared folder — the source of truth for all hero installs — lives in a Google Shared Drive. Without `supportsAllDrives: true`, `drive.files.list` silently returns zero results for any Shared Drive folder: no error, just missing data. This was the root cause of Drive discovery gaps in pre-module call sites that omitted the flag. The AE parent folder may also be in a Shared Drive depending on how a user organizes their Drive. Always-on is safe for personal Drive folders (the flags are no-ops there) and mandatory for Shared Drive folders. Making it opt-in would guarantee it gets omitted on future call sites.

## Considered options

- **Always-on (chosen)** — zero risk of silent data loss; flags are harmless on personal Drive
- **Opt-in per call** — callers would need to remember to set it; pre-module history shows they don't

## Addendum (BKL-ARCH-07c, 2026-05-03)

`DriveFolderClient` also owns Google Docs API upsert operations (`upsertDoc`). The class name is a historical misnomer — it covers both Drive folder traversal and Docs content writes. A rename to `DriveClient` is deferred to avoid a cross-codebase churn. All new Drive + Docs write operations should be added as methods here, not re-implemented at call sites.
