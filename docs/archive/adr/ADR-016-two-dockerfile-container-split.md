# ADR-016: Two-Dockerfile Container Split (Hero Install vs L4 Daemon)

**Status:** ACCEPTED  
**Date:** 2026-05-02  
**Author:** Rayford (DA) via grill-with-docs session with Jason  
**References:** BKL-ARCH-L4-SPLIT (pending), project_l4_scraper_container memory, project_node_role_architecture memory

---

## Context

The dashboard codebase today ships a single container image (`daily-brief-dashboard:latest`) for all deployment roles. The primary node (Mac Mini) runs the image with `NODE_ROLE=primary` + `SYNC_DAEMON=true` to enable L4 scraping. Hero installs run the same image with `NODE_ROLE` unset — L4 code is present but never runs.

This creates three problems:

1. **Image bloat on hero installs.** Every user pulls a full image that includes Playwright, Chromium, the CCSP/Tableau scraper, and the SF OAuth scraper — none of which will ever run. These dependencies alone add 400–600 MB to the image.

2. **Instability surface.** L4 scraper code (browser context management, session keepalive, Tableau VNC flows) is brittle by nature. It is present in the hero install image, can be accidentally invoked, and its imports execute at startup even when gated.

3. **Testability.** A hero install with browser-session code in the module graph cannot be cleanly unit-tested for its actual responsibility (Drive reads, data parsing, RH Hydra API calls). The browser context initialization paths create startup-time side effects that affect test isolation.

The Mac Mini already runs what is effectively a standalone scraper loop — a modified script that keeps browser sessions alive and syncs to L3 Drive daily. This is logically a separate service.

---

## Decision

**Split into two Dockerfiles from one repository:**

- **`Dockerfile.hero`** — Hero install image. Contains: dashboard UI, API server, RH Hydra scraper (pure HTTP, offline token), Drive reader, L3-sourced schedulers (territory sync, SF pipeline read). Does NOT contain: CCSP/Tableau scraper, SF OAuth scraper, Playwright, Chromium, browser context management.

- **`Dockerfile.l4`** — L4 daemon image. Contains: CCSP/Tableau scraper, SF OAuth scraper, browser runtime, daily L3 sync script. Does NOT contain: dashboard UI, API server, RH Hydra scraper.

Both images build from the same source repository. Shared types, utilities, and Drive client code remain in `src/lib/` and are compiled into both images.

**Build targets:**
- `make build` → builds `Dockerfile.hero` → `daily-brief-dashboard:latest`
- `make build-l4` → builds `Dockerfile.l4` → `daily-brief-l4-daemon:latest`

---

## Rejected Alternatives

| Option | Reason rejected |
|--------|----------------|
| A: One image, runtime NODE_ROLE gating (current state) | Hero install carries browser runtime forever; instability surface remains; testability gap persists; every user pays the image size cost for code they will never run |
| C: Two separate repositories | Shared types (Drive client, data structures, customer-folder module) would need to be extracted to a third package or duplicated; maintenance overhead disproportionate to benefit for a single-developer project |

---

## Consequences

- **Positive:** Hero install image drops ~400–600 MB (Playwright + Chromium removed).
- **Positive:** Hero install module graph has no browser-session code; unit tests for Drive reads, data parsing, and RH Hydra API run cleanly.
- **Positive:** L4 daemon image is slim — only the scraper loop, no API server, no UI assets.
- **Positive:** Bootstrap wizard no longer references Tableau VNC; setup time drops from 7–15 min to under 1 min per AE.
- **Risk:** Shared code in `src/lib/` must not import from L4-only modules transitively — enforced by verifying `tsc --noEmit` passes on the hero build without L4 source files present.
- **Risk:** Two Dockerfiles = two build pipelines to maintain. Mitigated by single source repo and shared `make` targets.
- **Neutral:** `NODE_ROLE=primary` env var remains as a runtime guard for any residual conditional logic, but the primary architectural gate is now the build target (file absence), not the env var.
