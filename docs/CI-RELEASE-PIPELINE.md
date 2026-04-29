# CI & Release Pipeline

## Overview

Two GitHub Actions workflows drive the full pipeline. Every commit to `main` runs the **CI** workflow. Every version tag (`v*`) runs the **Release Gate** workflow.

---

## Workflow 1 — CI (`ci.yml`)
**Triggered by:** push to `main` or pull request

```
git push main
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                     CI Workflow                         │
│                 (runs in parallel)                      │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Shellcheck  │  │  Env drift   │  │  BATS tests  │  │
│  │  setup.sh    │  │  gate        │  │  setup+drift │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Unit tests + TypeScript check + Build dashboard  │  │
│  │  → uploads dashboard-dist artifact                │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │ needs: test                  │
│             ┌────────────┴────────────┐                 │
│             ▼                         ▼                 │
│  ┌──────────────────┐    ┌────────────────────────────┐ │
│  │  Build & push    │    │  Integration & E2E tests   │ │
│  │  container image │    │  (continue-on-error: true) │ │
│  │  → :main-latest  │    │  playwright --project=ci   │ │
│  │  → :sha          │    │  BASE_URL=7778             │ │
│  └────────┬─────────┘    └────────────────────────────┘ │
│           │ needs: publish                              │
│           ▼                                             │
│  ┌──────────────────┐                                   │
│  │  Container smoke │                                   │
│  │  test on :7780   │                                   │
│  │  /api/aes check  │                                   │
│  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────┘
```

**What it produces:** container image at `ghcr.io/hornjason/daily-brief-dashboard:main-latest` and `:sha`

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
- Container image at `:latest`, `:stable`, `:v1.5.2` on GHCR
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

## What setup.sh Does

The hero install command:
```bash
curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/setup.sh | bash
```

1. Runs preflight checks (Podman installed, ports free, disk/memory)
2. Pulls `ghcr.io/hornjason/daily-brief-dashboard:latest` from GHCR
3. Writes a starter `.env`
4. Starts the container on port 7777
5. Directs user to `http://localhost:7777/dashboard/setup` for first-time wizard

`setup.sh` is taken directly from `scripts/setup.sh` in `asaCommandCenter` at the tagged commit — always current for that release.

---

## Runner

All jobs run on `[self-hosted, mac-mini-live]` — the Mac Mini at `localhost:7777`. This is why the Release Gate can test against real live credentials and the actual running prod server.
