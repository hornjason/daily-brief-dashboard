---
doc-type: runbook
status: active
owner: jason
updated: 2026-05-05
---

# Release Management Runbook
*Last validated: 2026-05-06 | Owner: DA | Trigger: Review and update on any structural change to this doc*

How DailyBriefDashboard versions, ships, and rolls back.

## Branch Strategy

- **`main` = production.** There is no staging branch or environment.
- All PAI agents use **git worktrees** for parallel work. Worktrees branch off main and merge back. The Makefile blocks `make build` from inside a worktree path to prevent accidental image builds with partial changes.
- **Direct-to-main** for docs, config, and small fixes.
- **Feature branches / worktrees** for risky changes (scraper modifications, schema changes, multi-file refactors).
- After all agent worktrees merge to main, the primary DA runs one `make rebuild` from the project root.

## Cutting a Release

Three Makefile targets handle releases. Each one:

1. Bumps the version in `package.json` (via `npm version`)
2. Creates a git commit with message `chore: release v<new-version>`
3. Creates a git tag `v<new-version>`
4. Pushes the commit and tag to the remote

| Command | When to use |
|---|---|
| `make release-patch` | Bug fixes, small tweaks (1.0.0 -> 1.0.1) |
| `make release-minor` | New features, backlog items shipped (1.0.0 -> 1.1.0) |
| `make release-major` | Breaking changes, major rearchitecture (1.0.0 -> 2.0.0) |

Check the current version at any time:

```bash
make version
```

## What CI Does on a Tag Push

Pushing a `v*` tag (or manually triggering the workflow) runs `.github/workflows/release.yml` — a two-job pipeline:

### Job 1: `release-e2e` — Full E2E with Real Credentials

- Runs on `ubuntu-latest` in the **production** GitHub environment (requires manual approval in GitHub Settings > Environments > production).
- Timeout: 30 minutes.
- Steps:
  1. Checks out the repo.
  2. Installs Bun, project dependencies, and dashboard dependencies (`bun install --frozen-lockfile`).
  3. Builds the dashboard (`cd dashboard && bun run build`).
  4. Installs Playwright Chromium.
  5. Runs the full E2E test suite (`bun run test:e2e`) with real credentials injected from GitHub environment secrets (Google OAuth, Gemini, Salesforce, Red Hat Portal).
  6. Uploads the Playwright HTML report as a build artifact (retained 14 days).

### Job 2: `publish-release` — Build and Push Versioned Image

- Runs only after `release-e2e` succeeds.
- Also requires the **production** environment approval.
- Steps:
  1. Logs in to GitHub Container Registry (`ghcr.io`).
  2. Determines the version tag from the git tag (or from manual workflow input).
  3. Builds the container image from `Containerfile` and pushes two tags:
     - `ghcr.io/hornjason/daily-brief-dashboard:<version>` (e.g. `v1.1.0`)
     - `ghcr.io/hornjason/daily-brief-dashboard:stable`

The `stable` tag always points to the latest successfully released image.

## Local Build (No Release)

For day-to-day development, `make rebuild` builds locally and restarts the container without tagging or pushing to GHCR:

```bash
make rebuild   # build -> push (to local GHCR cache) -> restart container
```

This overwrites `localhost/daily-brief-dashboard:latest` and `ghcr.io/hornjason/daily-brief-dashboard:latest`.

## Rolling Back

### Rollback to a Previous GHCR Image

If a release introduced a regression, pull and run a previous versioned tag:

```bash
# Stop the current container
make down

# Pull the known-good version
podman pull ghcr.io/hornjason/daily-brief-dashboard:v1.0.0

# Tag it as latest so `make up` uses it
podman tag ghcr.io/hornjason/daily-brief-dashboard:v1.0.0 localhost/daily-brief-dashboard:latest

# Start with the rolled-back image
make up
```

Or use the `stable` tag to get the last successful release:

```bash
podman pull ghcr.io/hornjason/daily-brief-dashboard:stable
podman tag ghcr.io/hornjason/daily-brief-dashboard:stable localhost/daily-brief-dashboard:latest
make up
```

### Rollback to a Previous Git State

If you need to rebuild from an older commit:

```bash
# Find the tag you want
git tag --list 'v*' --sort=-version:refname

# Check out that tag
git checkout v1.0.0

# Rebuild the image from that state
make rebuild

# Return to main when done
git checkout main
```

### Verify After Rollback

Always confirm the container is healthy after a rollback:

```bash
make ps
curl -s http://localhost:7777/api/aes | head -c 200
```

## Pre-Release Gate (Recommended)

Before cutting a release, run the Rook (security) and Quinn (QA) gates on changed files. This is currently a team convention, not an automated CI gate:

1. Rook scans changed files and pattern siblings for security issues.
2. Quinn runs the Playwright test suite and visual review.
3. Only after both pass: `make release-patch` (or minor/major).

## Image Tags Reference

| Tag | Where | Meaning |
|---|---|---|
| `latest` | localhost | Last local `make build` |
| `latest` | ghcr.io | Last `make push` (may not match a release) |
| `stable` | ghcr.io | Last image that passed the release E2E gate |
| `v1.2.3` | ghcr.io | Specific release version |
| `demo-latest` | localhost | Frozen snapshot for demos (`make demo-snapshot`) |
