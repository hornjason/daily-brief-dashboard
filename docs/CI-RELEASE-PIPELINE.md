---
doc-type: runbook
status: active
owner: jason
updated: 2026-05-14
---

# CI & Release Pipeline
*Last validated: 2026-05-14 | Owner: DA | Trigger: Review and update on any structural change to this doc*

## Overview

Three GitHub Actions workflows drive the full pipeline. Every commit to `main` runs the **CI** workflow (Gate 2). Every version tag (`v*`) runs the **Release Gate** workflow (Gate 4). A nightly schedule runs **Data Assertions** (Gate 3). See CONTEXT.md §CI gates for the 4-gate model.

---

## Workflow 1 — CI (`ci.yml`) — Gate 2
**Triggered by:** push to `main` or pull request
**Budget:** <2 minutes

```
git push main
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                  CI Workflow (Gate 2)                    │
│                 (runs in parallel)                      │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Shellcheck  │  │  Env drift   │  │  BATS tests  │  │
│  │  setup.sh    │  │  gate        │  │  setup+drift │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Unit tests + TypeScript check + Build dashboard  │  │
│  │  + doc audit (warning only) + hero purity         │  │
│  │  → uploads dashboard-dist artifact                │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │ needs: test (main+push only) │
│                          ▼                              │
│  ┌──────────────────┐                                   │
│  │  Build & push    │                                   │
│  │  multi-arch image│                                   │
│  │  (amd64 + arm64) │                                   │
│  │  → :main-latest  │                                   │
│  │  → :sha          │                                   │
│  └────────┬─────────┘                                   │
│           │ needs: publish                              │
│           ▼                                             │
│  ┌──────────────────┐                                   │
│  │  Container smoke │                                   │
│  │  test on :7780   │                                   │
│  │  /api/aes check  │                                   │
│  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────┘
```

**What it produces:** multi-arch container image (linux/amd64 + linux/arm64) at `ghcr.io/hornjason/daily-brief-dashboard:main-latest` and `:sha`

**Not in Gate 2:** E2E Playwright tests, Wizard E2E, visual regression. These run exclusively in Gate 4 (release.yml). Rationale: issue #138 — E2E took 20+ min per commit with `continue-on-error: true`, providing no gate value while burning Mac Mini runner time.

---

## Workflow 2 — Release Gate (`release.yml`)
**Triggered by:** pushing a `v*` tag (e.g. `git tag v1.5.2 && git push origin v1.5.2`)

```
git tag v1.5.2 && git push origin v1.5.2
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│              Release Gate Workflow                      │
│                                                         │
│  Job 1: Full E2E — real credentials                     │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Playwright tests against LIVE prod (port 7777) │    │
│  │  Scope: test/api/ + test/contracts/             │    │
│  │  Real Tableau/SF/CCSP sessions on mac-mini      │    │
│  │  Environment: production (requires approval)    │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ needs: release-e2e              │
│                       ▼                                 │
│  Job 2: Tag and push release image                      │
│  ┌─────────────────────────────────────────────────┐    │
│  │  podman build + push to GHCR:                   │    │
│  │    :v1.5.2  (versioned, permanent)              │    │
│  │    :stable  (latest stable)                     │    │
│  │    :latest  (what curl | bash installer pulls)  │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ needs: publish-release          │
│                       ▼                                 │
│  Job 3: Publish to daily-brief-dashboard                │
│  ┌─────────────────────────────────────────────────┐    │
│  │  curl → GitHub API → create release on          │    │
│  │    hornjason/daily-brief-dashboard               │    │
│  │  Attach assets:                                 │    │
│  │    setup.sh        ← the hero installer         │    │
│  │    .env.example    ← config template            │    │
│  │    docker-compose.yml                           │    │
│  │  Uses: PUBLIC_REPO_DEPLOY_TOKEN secret          │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

**What it produces:**
- Multi-arch container image (linux/amd64 + linux/arm64) at `:latest`, `:stable`, `:v1.5.2` on GHCR
- Public GitHub release at `hornjason/daily-brief-dashboard/releases/tag/v1.5.2`
- `setup.sh` downloadable at `releases/latest/download/setup.sh`

---

## Two Repos

| Repo | Purpose | What lives there |
|---|---|---|
| `asaCommandCenter` | Private dev repo | All source code, CI workflows, tests |
| `daily-brief-dashboard` | Public installer repo | README only + release assets |

Users never see `asaCommandCenter`. They land on `daily-brief-dashboard`, run the one-liner, and get `setup.sh` from the release assets.

---

## Keeping `scripts/seed-data/settings.json` in Sync

`scripts/seed-data/settings.json` is baked into the image and becomes every new user's starting `data/config/settings.json` on first boot. It must always reflect the current canonical region/pod list.

**Before every release — verify these are current:**

| Field | Where to verify | What to check |
|---|---|---|
| `regions[].pods[].label` | This file | Matches real pod team name (not a placeholder like "East Comm Corp POD02") |
| `regions[].pods[].sfReportId` | Salesforce or ask ops | Populated for any pod that's live; blank + `pendingSetup` note for pods not yet configured |
| `regions[].territorySheetUrl` | Google Drive | Sheet still exists and is the correct tab |
| `regions[].podBookingsFolderId` | Google Drive | Folder ID still valid |

**Pods with `"pendingSetup"` fields** are incomplete — they have labels but no SF report ID and no CCSP data yet. They will appear in the wizard but the region will show as "Coming Soon" for those pods until ops configures them. When a pod goes live:
1. Get the 18-char Salesforce report ID from ops
2. Remove the `"pendingSetup"` field
3. Add the `sfReportId`
4. Update `data/config/settings.json`, `data-test/config/settings.json`, and `data-demo/config/settings.json` with the same change
5. Cut a patch release so existing installs can pull the update

**All settings.json copies that must stay in sync:**

| File | What it feeds | In git? |
|---|---|---|
| `scripts/seed-data/settings.json` | Source of truth — baked into image, seeds new installs | ✅ Yes |
| `data/config/settings.json` | Laptop production (port 7777) | ✅ Yes |
| `data-test/config/settings.json` | Test container (port 7776) | ✅ Yes |
| `data-demo/config/settings.json` | Demo container (port 7779) | ✅ Yes |
| `data-dev/config/settings.json` | Dev container (port 7778) | ✅ Yes |
| `data-sync/config/settings.json` | **Mac Mini L4 sync daemon** | ❌ No — lives only on Mac Mini |

**`data-sync/config/settings.json` is not in git.** It must be updated manually on the Mac Mini whenever a region or pod is added. The sync daemon reads this file at runtime — it is fully data-driven and requires no code changes when pods are added, but it will silently skip any pod not present in this file.

**To add a new region or pod to the sync daemon:**
```bash
# On Mac Mini — edit the sync daemon's config directly
ssh jasonhorn@mac.tail2fe7c7.ts.net
nano ~/DailyBriefDashboard/data-sync/config/settings.json
# Add the region/pod block matching scripts/seed-data/settings.json
# Then trigger an immediate sync to verify:
make -C ~/DailyBriefDashboard sync-now
make -C ~/DailyBriefDashboard sync-logs
```

**Do not update only the live `data/config/settings.json`** — that only affects the running dashboard instance. New installs get the seed, and the Mac Mini daemon reads `data-sync/` separately.

---

## How to Cut a Release

```bash
# 1. Make sure main is green
# 2. Bump version
npm version patch   # or minor / major
git add package.json
git commit -m "chore: bump vX.Y.Z"

# 3. Tag and push — this triggers the Release Gate automatically
git tag vX.Y.Z
git push && git push origin vX.Y.Z
```

The pipeline does everything else: E2E gate → container push → public release with assets.

---

## GHCR Package Visibility — Must Stay Public

Both the `hornjason/daily-brief-dashboard` repo and the GHCR container image are **public**. The install one-liner works for anyone without authentication because of this.

**After any package recreation** (e.g. GHCR namespace change, deleting and re-pushing the image), re-verify visibility before cutting the next release:
1. Go to `https://github.com/users/hornjason/packages/container/package/daily-brief-dashboard`
2. Confirm visibility shows **Public** — if not, click **Package settings** → **Change visibility** → **Public**

GitHub does not expose package visibility via Actions — it cannot be automated through CI. This is a manual gate before every release.

**Symptom if it goes private:** `setup.sh` runs fine, image pull step fails with `Error: unauthorized` or `manifest unknown`. Users see a failed install with no obvious cause.

---

## What setup.sh Does

The hero install command:
```bash
curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/setup.sh | bash
```

1. Runs preflight checks (Podman installed, ports free, disk/memory)
2. Pulls `ghcr.io/hornjason/daily-brief-dashboard:latest` from GHCR (requires package set to public — see above)
3. Writes a starter `.env`
4. Starts the container on port 7777
5. Directs user to `http://localhost:7777/dashboard/setup` for first-time wizard

`setup.sh` is taken directly from `scripts/setup.sh` in `asaCommandCenter` at the tagged commit — always current for that release.

---

## Runner

All jobs run on `[self-hosted, mac-mini-live]` — the Mac Mini at `localhost:7777`. This is why the Release Gate can test against real live credentials and the actual running prod server.

---

## Multi-Arch Build (2026-05-14)

All container images are built as multi-arch manifests supporting `linux/amd64` and `linux/arm64`. This applies to CI (Gate 2) and Release (Gate 4) workflows, as well as `make build` locally.

**How it works:**
1. Both architectures are built separately via `podman build --platform linux/{amd64,arm64}`
2. A `podman manifest` combines both into a single manifest list
3. `podman manifest push --all` pushes the manifest list to GHCR
4. Docker/Podman clients auto-select the correct architecture on pull

**arm64 builds on Intel runner:** Uses QEMU user-mode emulation (built into Podman Machine). Adds ~1-2 minutes to the build step.

**Scope:** Hero image only. L4 daemon remains amd64-only (Chromium binary dependency).
