# ── PAI Dashboard — Container Operations ──────────────────────────────────────
#
# This is the ONLY sanctioned way to run the container.
# Never use raw `podman run` — env vars and ports live here, not in your head.
#
# Usage:
#   make up        Start (or restart) the container
#   make down      Stop and remove the container
#   make logs      Follow container logs
#   make build     Build the image locally
#   make push      Push to GHCR
#   make rebuild     Full cycle: build → push → restart hero container
#   make rebuild-l4  Full cycle: build-l4 → push-l4 (then pull on Mac Mini)
#   make ps        Show container status
#   make seed         Populate data-test/ with known fixture data
#   make test-up      Start test container on port 7776 (ALLOW_RESET=true, seeds fake data)
#   make test-up-live      Start test container preserving existing data-test/ (no seed wipe)
#   make test-rebuild-live Rebuild image + start preserving existing data-test/ (no seed wipe)
#   make test-snapshot     Save data-test/ as versioned tarball in data-snapshots/
#   make test-restore      Restore newest data-snapshots/ tarball into data-test/
#   make test-down    Stop test container
#   make demo-snapshot Freeze prod data + image for demo
#   make demo-up      Start demo container on port 7779 (local only)
#   make demo-deploy  Full deploy to Mac Mini: snapshot→export→transfer→start (one command)
#   make demo-status  Check if demo is running on Mac Mini
#   make demo-restart Restart demo container on Mac Mini (no data refresh)
#   make demo-setup-tunnel Install/reinstall instatunnel + watchdog LaunchAgents on Mac Mini
#   make env-status   Show which containers are running
#   make onboarding-check  Rebuild image + run full 6-phase E2E onboarding test (auto-rebuilds)
#   make pre-promote  Run all gates before make rebuild
#   make install-hooks  Install git hooks (run once after clone)
#   make lint         Check for empty catch blocks in dashboard/src/

IMAGE      := localhost/daily-brief-dashboard:latest
REMOTE     := ghcr.io/hornjason/daily-brief-dashboard:latest
IMAGE_L4   := localhost/daily-brief-l4-daemon:latest
REMOTE_L4  := ghcr.io/hornjason/daily-brief-l4-daemon:latest
PLATFORMS  := linux/amd64,linux/arm64
DATA       := $(CURDIR)/data

# ── Mac Mini demo machine ─────────────────────────────────────────────────────
MAC_MINI_HOST ?= jasonhorn@mini.local
MAC_MINI_DIR  ?= ~/DailyBriefDashboard

.PHONY: up down logs build build-l4 push-l4 rebuild-l4 push rebuild ps setup doctor backup-config restore-config release-patch release-minor release-major version \
       dev-snapshot dev-up dev-down dev-logs \
       seed test-up test-rebuild test-up-live test-rebuild-live test-down test-logs \
       test-snapshot test-restore test-check lint \
       pre-promote install-hooks onboarding-check onboarding-check-nightly \
       smoke smoke-alert \
       monitor-once \
       update-snapshots \
       demo-snapshot demo-up demo-down demo-logs demo-export \
       demo-deploy demo-status demo-restart demo-setup-tunnel \
       pai-sync-remote demo-full-refresh \
       all-down all-ps \
       sync-up sync-down sync-logs sync-status sync-now sync-up-vnc keepalive-now

up: down
	@test -f $(DATA)/config/aes.json || (echo "❌ data/config/aes.json missing — run 'make setup' or restore from backup first" && exit 1)
	podman run -d \
	  -p 7777:7777 \
	  -p 6080:6080 \
	  -v $(DATA):/data:Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard \
	  $(IMAGE)

down:
	podman stop pai-dashboard 2>/dev/null || true
	podman rm   pai-dashboard 2>/dev/null || true

.PHONY: vnc-url
vnc-url: ## Print current VNC URL via Tailscale MagicDNS
	@echo "http://$$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[\"Self\"][\"DNSName\"].rstrip(\".\"))' 2>/dev/null || tailscale ip --4):6080/vnc.html"

logs:
	podman logs -f pai-dashboard

build:
	@if echo "$(CURDIR)" | grep -q '\.claude/worktrees'; then \
	  echo "❌  make rebuild must be run from the project root, not a git worktree"; \
	  echo "   Current dir: $(CURDIR)"; \
	  echo "   Run from: $(shell git worktree list 2>/dev/null | head -1 | awk '{print $$1}')"; \
	  exit 1; \
	fi
	@git worktree prune 2>/dev/null || true
	podman manifest rm $(REMOTE) 2>/dev/null || true
	podman rmi $(REMOTE) 2>/dev/null || true
	podman manifest create $(REMOTE)
	podman build -f Dockerfile.hero --platform linux/amd64 -t daily-brief-hero-amd64 .
	podman manifest add $(REMOTE) containers-storage:localhost/daily-brief-hero-amd64:latest
	rm -rf .hero-dist && podman create --name hero-extract daily-brief-hero-amd64 true && \
	  podman cp hero-extract:/app/dashboard/dist .hero-dist && podman rm hero-extract
	podman build -f Dockerfile.hero-runtime --platform linux/arm64 -t daily-brief-hero-arm64 .
	rm -rf .hero-dist
	podman manifest add $(REMOTE) containers-storage:localhost/daily-brief-hero-arm64:latest
	podman tag daily-brief-hero-amd64 $(IMAGE)

# ── L4 daemon image (Mac Mini primary node only) ──────────────────────────────
# BKL-ARCH-L4-SPLIT (ADR-016): L4 scraper image — Playwright + Chromium + browser scrapers.
# Does NOT contain dashboard UI or API server.
build-l4:
	@if echo "$(CURDIR)" | grep -q '\.claude/worktrees'; then \
	  echo "❌  make build-l4 must be run from the project root, not a git worktree"; \
	  exit 1; \
	fi
	podman build -f Dockerfile.l4 -t $(IMAGE_L4) -t $(REMOTE_L4) .

push-l4:
	podman push $(REMOTE_L4)

# Full cycle for L4 daemon: build → push → restart daemon (Mac Mini must pull + sync-up after)
rebuild-l4: build-l4 push-l4
	@echo "✅  L4 daemon image pushed to GHCR"
	@echo "   On Mac Mini: podman pull $(REMOTE_L4) && make sync-up"

push:
	podman manifest push --all $(REMOTE) docker://$(REMOTE)

login-ghcr: ## Re-authenticate to GHCR using GITHUB_TOKEN from .env
	@TOKEN=$$(grep '^GITHUB_TOKEN=' .env | cut -d= -f2); \
	if [ -z "$$TOKEN" ]; then echo "GITHUB_TOKEN not set in .env"; exit 1; fi; \
	podman login ghcr.io -u hornjason --password "$$TOKEN" && echo "Login succeeded"

rebuild: build push up smoke

ps:
	podman ps --filter name=pai-dashboard --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# ── Release Management ────────────────────────────────────────────────────────
# Bumps package.json, commits, tags, and pushes — triggers release.yml in CI.
# Use patch for bug fixes, minor for new features, major for breaking changes.

version:
	@node -p "require('./package.json').version"

release-patch: build
	npm version patch -m "chore: release v%s"
	@$(MAKE) _release-finalize

release-minor: build
	npm version minor -m "chore: release v%s"
	@$(MAKE) _release-finalize

release-major: build
	npm version major -m "chore: release v%s"
	@$(MAKE) _release-finalize

_release-finalize:
	@VERSION=$$(node -p "require('./package.json').version"); \
	echo "━━━ Releasing v$$VERSION ━━━"; \
	echo "Tagging container image..."; \
	podman tag $(IMAGE) ghcr.io/hornjason/daily-brief-dashboard:v$$VERSION; \
	echo "Pushing to GitHub..."; \
	git push && git push --tags; \
	echo "Pushing container image v$$VERSION..."; \
	podman push ghcr.io/hornjason/daily-brief-dashboard:v$$VERSION; \
	podman push $(REMOTE); \
	echo "Creating GitHub release..."; \
	gh release create v$$VERSION \
	  --title "v$$VERSION" \
	  --generate-notes; \
	echo "✅  v$$VERSION released — GitHub + container registry"

setup:
	@mkdir -p data/config data/cache data/rh-profile
	@if [ ! -f .env ]; then \
	  cp .env.example .env; \
	  echo "Created .env from template — edit it with your REDHAT_OFFLINE_TOKEN"; \
	fi
	@if grep -q 'your_offline_token_here' .env 2>/dev/null; then \
	  echo "⚠️  WARNING: REDHAT_OFFLINE_TOKEN is still the placeholder — edit .env before running"; \
	fi
	@echo "Next steps: Run 'make rebuild' then open http://localhost:7777 to complete setup"

doctor: ## Run environment health check
	@echo "Running environment health check..."
	@echo ""
	@command -v podman >/dev/null 2>&1 && echo "  ✓ podman found" || echo "  ❌ podman not found"
	@test -f $(DATA)/config/aes.json && echo "  ✓ aes.json present" || echo "  ❌ data/config/aes.json missing"
	@test -f $(DATA)/config/customers.json && echo "  ✓ customers.json present" || echo "  ❌ data/config/customers.json missing"
	@test -f $(DATA)/config/settings.json && echo "  ✓ settings.json present" || echo "  ❌ data/config/settings.json missing"
	@test -f .env && echo "  ✓ .env present" || echo "  ❌ .env missing — run 'make setup'"
	@if [ -f .env ]; then grep -q '^REDHAT_OFFLINE_TOKEN=' .env 2>/dev/null && echo "  ✓ REDHAT_OFFLINE_TOKEN set" || echo "  ⚠ REDHAT_OFFLINE_TOKEN not set in .env"; fi
	@podman image exists $(IMAGE) 2>/dev/null && echo "  ✓ container image exists" || echo "  ⚠ image not built — run 'make build'"
	@podman ps --filter name=pai-dashboard --format "  ✓ container: {{.Status}}" 2>/dev/null | head -1 || echo "  ⚠ container not running"
	@curl -sf http://localhost:7777/api/aes >/dev/null 2>&1 && echo "  ✓ API healthy on :7777" || echo "  ⚠ API not responding on :7777"
	@echo ""
	@echo "Doctor complete."

backup-config: ## Snapshot config files for migration
	@mkdir -p backups
	@STAMP=$$(date +%Y%m%d-%H%M%S); \
	tar czf backups/config-backup-$$STAMP.tar.gz \
	  -C $(DATA) \
	  config/aes.json config/customers.json config/settings.json \
	  config/product-intel-config.json \
	  $$(test -f $(DATA)/config/pod-config.json && echo config/pod-config.json) \
	  $$(test -f $(DATA)/config/data-sources.json && echo config/data-sources.json) \
	  $$(test -f $(DATA)/config/gcp-oauth.keys.json && echo config/gcp-oauth.keys.json); \
	echo "✓ Config backed up to backups/config-backup-$$STAMP.tar.gz"

restore-config: ## Restore config from backup tarball (FILE=path/to/backup.tar.gz)
	@test -n "$(FILE)" || (echo "Usage: make restore-config FILE=backups/config-backup-YYYYMMDD.tar.gz" && exit 1)
	@test -f "$(FILE)" || (echo "❌ File not found: $(FILE)" && exit 1)
	@mkdir -p $(DATA)/config
	tar xzf "$(FILE)" -C $(DATA)
	@echo "✓ Config restored from $(FILE)"

# ── Dev environment (port 7778) ──────────────────────────────────────────────
dev-snapshot:
	@echo "Syncing production data to dev..."
	rsync -a --delete $(CURDIR)/data/ $(CURDIR)/data-dev/
	@echo "Dev snapshot ready at data-dev/"

dev-up: dev-down
	@test -f $(CURDIR)/data-dev/config/aes.json || (echo "ERROR: Run 'make dev-snapshot' first" && exit 1)
	podman run -d \
	  -p 7778:7777 \
	  -p 127.0.0.1:6081:6080 \
	  -v $(CURDIR)/data-dev:/data:Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard-dev \
	  $(IMAGE)
	@echo "Dev container running at http://localhost:7778"

dev-down:
	podman stop pai-dashboard-dev 2>/dev/null || true
	podman rm   pai-dashboard-dev 2>/dev/null || true

dev-logs:
	podman logs -f pai-dashboard-dev

# ── Test environment (port 7776, destructive-safe) ───────────────────────────
# ALLOW_RESET=true enables POST /api/setup/reset and POST /api/__test/restore
# against datasets with >5 customers. Never set this on the production container.
seed:
	@echo "Seeding test data..."
	@echo "  Cleaning stale auth state..."
	@rm -f "$(CURDIR)/data-test/config/.rh-session.json" "$(CURDIR)/data-test/config/.sf-session.json"
	@rm -f "$(CURDIR)/data-test/rh-profile/Default/Cookies" "$(CURDIR)/data-test/rh-profile/Default/Login Data" "$(CURDIR)/data-test/rh-profile/Default/Web Data"
	@rm -f $(CURDIR)/data-test/config/customers.json.bak*
	@mkdir -p $(CURDIR)/data-test/config $(CURDIR)/data-test/cache/intelligence $(CURDIR)/data-test/rh-profile
	@cp $(CURDIR)/scripts/seed-data/aes.json         $(CURDIR)/data-test/config/aes.json
	@cp $(CURDIR)/scripts/seed-data/customers.json   $(CURDIR)/data-test/config/customers.json
	@cp $(CURDIR)/scripts/seed-data/settings.json    $(CURDIR)/data-test/config/settings.json
	@cp $(CURDIR)/scripts/seed-data/product-intel-config.json $(CURDIR)/data-test/config/product-intel-config.json
	@cp $(CURDIR)/scripts/seed-data/data-sources.json $(CURDIR)/data-test/config/data-sources.json
	@if [ -f "$(CURDIR)/data/config/.google-token.json" ]; then cp "$(CURDIR)/data/config/.google-token.json" "$(CURDIR)/data-test/config/.google-token.json"; fi
	@echo '{"history":[]}' > $(CURDIR)/data-test/config/bootstrap-history.json
	@echo '{"folders":{},"lastChecked":null}' > $(CURDIR)/data-test/config/drive-watcher-state.json
	@echo "  Wiping stale cache before seeding fresh..."
	@rm -rf "$(CURDIR)/data-test/cache"
	@mkdir -p $(CURDIR)/data-test/cache/intelligence
	@cp -r $(CURDIR)/scripts/seed-data/cache/. $(CURDIR)/data-test/cache/
	@echo "✅  Test data seeded at data-test/"

# test-up  = fast restart with EXISTING image (data reset only, no rebuild)
# test-rebuild = rebuild image first, THEN restart (use after any source code change)
test-up: test-down seed
	podman run -d \
	  -p 7776:7777 \
	  -p 127.0.0.1:6083:6080 \
	  -v $(CURDIR)/data-test:/data:Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e OAUTH_BASE_URL=http://localhost:7776 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  -e ALLOW_RESET=true \
	  -e NODE_ROLE= \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard-test \
	  $(IMAGE)
	@echo "Test container running at http://localhost:7776 (ALLOW_RESET=true)"

test-rebuild: build test-down seed
	podman run -d \
	  -p 7776:7777 \
	  -p 127.0.0.1:6083:6080 \
	  -v $(CURDIR)/data-test:/data:Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e OAUTH_BASE_URL=http://localhost:7776 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  -e ALLOW_RESET=true \
	  -e NODE_ROLE= \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard-test \
	  $(IMAGE)
	@echo "Test container rebuilt and running at http://localhost:7776 (ALLOW_RESET=true)"
	@echo "Use 'make test-up' to restart without rebuilding the image."

test-down:
	podman stop pai-dashboard-test 2>/dev/null || true
	podman rm   pai-dashboard-test 2>/dev/null || true

test-logs:
	podman logs -f pai-dashboard-test

lint:
	@echo "Checking for empty catch blocks in dashboard/src/..."
	@bash $(CURDIR)/scripts/check-empty-catches.sh

audit-docs: ## Audit docs for staleness, dead refs, and archive candidates
	bun scripts/audit-docs.ts

seed-live-clean:
	@echo "  Cleaning stale auth state (live data preserved)..."
	@rm -f "$(CURDIR)/data-test/config/.rh-session.json" "$(CURDIR)/data-test/config/.sf-session.json"
	@rm -f "$(CURDIR)/data-test/rh-profile/Default/Cookies" "$(CURDIR)/data-test/rh-profile/Default/Login Data" "$(CURDIR)/data-test/rh-profile/Default/Web Data"
	@rm -f $(CURDIR)/data-test/config/customers.json.bak*

# test-up-live     = restart with EXISTING image + EXISTING data (no seed wipe — use when debugging with real accounts)
# test-rebuild-live = rebuild image + restart with EXISTING data (no seed wipe — use when source changes + real data needed)
test-up-live: test-down seed-live-clean
	podman run -d \
	  -p 7776:7777 \
	  -p 127.0.0.1:6083:6080 \
	  -v $(CURDIR)/data-test:/data:Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  -e ALLOW_RESET=true \
	  -e NODE_ROLE= \
	  $(if $(OAUTH_BASE_URL),-e OAUTH_BASE_URL=$(OAUTH_BASE_URL),) \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard-test \
	  $(IMAGE)
	@echo "Test container running at http://localhost:7776 (live data preserved — no seed)"

test-rebuild-live: build test-down seed-live-clean
	podman run -d \
	  -p 7776:7777 \
	  -p 127.0.0.1:6083:6080 \
	  -v $(CURDIR)/data-test:/data:Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e OAUTH_BASE_URL=http://localhost:7776 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  -e ALLOW_RESET=true \
	  -e NODE_ROLE= \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard-test \
	  $(IMAGE)
	@echo "Test container rebuilt at http://localhost:7776 (live data preserved — no seed)"

# ── Test data snapshots (BKL-TEST-P0-07) ─────────────────────────────────────
# Save data-test/ as a versioned tarball after a successful onboarding-check so
# future runs can skip the ~33-minute full bootstrap when source hasn't changed.
# Snapshots are host-only (not mounted into the container) and never committed.
#
#   make test-snapshot   Save current data-test/ to data-snapshots/
#   make test-restore    Wipe data-test/ and extract newest snapshot back into it
test-snapshot:
	@test -d $(CURDIR)/data-test || (echo "❌  data-test/ does not exist — nothing to snapshot" && exit 1)
	@mkdir -p $(CURDIR)/data-snapshots
	@SHA=$$(git rev-parse --short HEAD); \
	 STAMP=$$(date +%Y%m%d); \
	 FNAME="data-test-snapshot-$$SHA-$$STAMP.tar.gz"; \
	 tar czf $(CURDIR)/data-snapshots/$$FNAME -C $(CURDIR) data-test; \
	 echo "Snapshot saved to data-snapshots/$$FNAME"

test-restore:
	@if podman ps --filter name=pai-dashboard-test --format '{{.Names}}' 2>/dev/null | grep -q pai-dashboard-test; then \
	  echo "❌  pai-dashboard-test is running — it holds data-test/ files open."; \
	  echo "   Run 'make test-down' first, then re-run 'make test-restore'."; \
	  exit 1; \
	fi
	@test -d $(CURDIR)/data-snapshots || (echo "❌  No data-snapshots/ directory — run 'make test-snapshot' first" && exit 1)
	@LATEST=$$(ls -1 $(CURDIR)/data-snapshots/data-test-snapshot-*.tar.gz 2>/dev/null | sort | tail -1); \
	 if [ -z "$$LATEST" ]; then \
	   echo "❌  No snapshots found in data-snapshots/ — run 'make test-snapshot' first"; \
	   exit 1; \
	 fi; \
	 test -n "$(CURDIR)" && rm -rf "$(CURDIR)/data-test"; \
	 tar --no-same-owner --no-same-permissions -xzf "$$LATEST" -C "$(CURDIR)"; \
	 echo "Restored $$(basename "$$LATEST") → data-test/"

# ── Smoke / post-deploy verification ─────────────────────────────────────────
# BKL-TEST-P0-03: Non-destructive production smoke gate, run automatically as
# the last step of `make rebuild`. Targets port 7777 (production) only.
#
#   make smoke          Run the smoke suite against the running prod container
#
# Budget: ≤90 seconds. Hard timeout enforced via --timeout=90000.
# Spec:   test/smoke-prod.spec.ts (uses the `ci` Playwright project, read-only).
# On failure: fires a voice alert via the PAI notification daemon and exits 1,
# which causes `make rebuild` to fail after the container is already up. That
# is intentional — the container is live, but the human is told immediately
# that the post-deploy checks did not pass.
smoke:
	@echo "Waiting for container to be ready..."
	@sleep 2
	@for i in $$(seq 1 60); do \
	  curl -sf http://localhost:7777/health > /dev/null 2>&1 && echo "Container ready after $$i seconds" && break; \
	  sleep 1; \
	done
	@curl -sf http://localhost:7777/health > /dev/null || (echo "❌  Container failed to start after 60s" && exit 1)
	@BASE_URL=http://localhost:7777 npx playwright test test/smoke-prod.spec.ts --project=ci --reporter=line --timeout=90000 || \
	  (curl -s -X POST http://localhost:8888/notify \
	    -H "Content-Type: application/json" \
	    -d '{"message": "Production smoke test FAILED after rebuild — check logs", "voice_id": "fTtv3eikoepIosk8dTZ5", "voice_enabled": true}' ; exit 1)

# ── Visual snapshot baseline update ──────────────────────────────────────────
# Regenerates Playwright visual baseline PNGs for wizard-e2e.spec.ts.
# Seeds config/ and cache/ from scripts/seed-data/, starts a Bun server on 7778,
# runs the wizard-e2e project with --update-snapshots, then shuts down the server.
#
# Run this locally whenever the wizard UI changes intentionally:
#   make update-snapshots
# Then commit the PNG files under test/snapshots/wizard/ along with the code change.
# CI fails if the PNGs are stale (pixel diff > maxDiffPixelRatio: 0.02).
update-snapshots:
	@echo "Seeding config/ and cache/ from scripts/seed-data/..."
	@mkdir -p $(CURDIR)/config $(CURDIR)/cache $(CURDIR)/cache/intelligence
	@cp $(CURDIR)/scripts/seed-data/aes.json         $(CURDIR)/config/aes.json
	@cp $(CURDIR)/scripts/seed-data/customers.json   $(CURDIR)/config/customers.json
	@cp $(CURDIR)/scripts/seed-data/settings.json    $(CURDIR)/config/settings.json
	@cp $(CURDIR)/scripts/seed-data/product-intel-config.json $(CURDIR)/config/product-intel-config.json
	@cp $(CURDIR)/scripts/seed-data/data-sources.json $(CURDIR)/config/data-sources.json
	@cp -r $(CURDIR)/scripts/seed-data/cache/. $(CURDIR)/cache/
	@echo "Building dashboard..."
	@cd dashboard && bun run build 2>/dev/null || true
	@echo "Starting Bun server on port 7778..."
	@PORT=7778 BASE_URL=http://localhost:7778 bun run server.ts &
	@SERVER_PID=$$!; \
	trap "kill $$SERVER_PID 2>/dev/null || true" EXIT INT TERM; \
	echo "Waiting for server to be ready on port 7778..."; \
	for i in $$(seq 1 30); do \
	  curl -sf http://localhost:7778/health > /dev/null 2>&1 && echo "Server ready after $$i seconds" && break; \
	  sleep 1; \
	done; \
	curl -sf http://localhost:7778/health > /dev/null || (echo "Server failed to start" && exit 1); \
	echo "Running wizard-e2e with --update-snapshots..."; \
	BASE_URL=http://localhost:7778 bunx playwright test test/wizard-e2e.spec.ts --project=wizard-e2e --update-snapshots --reporter=list; \
	EXIT_CODE=$$?; \
	kill $$SERVER_PID 2>/dev/null || true; \
	if [ $$EXIT_CODE -eq 0 ]; then \
	  echo ""; \
	  echo "Snapshot baselines updated in test/snapshots/wizard/"; \
	  echo "Commit them along with your UI changes."; \
	else \
	  echo "Some tests failed — check output above. Snapshot files may still have been written."; \
	fi; \
	exit $$EXIT_CODE

# ── Install git hooks ────────────────────────────────────────────────────────
# Run once after cloning: make install-hooks
# Installs pre-commit hook that enforces PROJECT-STATE.md updates on new routes/pages.
install-hooks:
	@cp $(CURDIR)/scripts/hooks/pre-commit $(CURDIR)/.git/hooks/pre-commit
	@chmod +x $(CURDIR)/.git/hooks/pre-commit
	@echo "✅  Git hooks installed (.git/hooks/pre-commit)"

# ── Pre-promote gate ──────────────────────────────────────────────────────────
# Runs the full CI suite against real production data in an isolated container.
# All four gates must pass before make rebuild.
#
# Gate 0 (state doc):   PROJECT-STATE.md updated after last src/ change
# Gate 1 (lint):        No silent catch blocks in dashboard/src/
# Gate 2 (real data):   ci suite passes against real data on port 7776
# Gate 3 (destructive): @destructive suite passes against seed data on port 7776
#
# Usage: make pre-promote && make rebuild
pre-promote: lint test-down
	@echo "━━━ Gate 0: PROJECT-STATE.md freshness check..."
	@PROJ_DATE=$$(git log -1 --format="%ct" -- PROJECT-STATE.md 2>/dev/null || echo 0); \
	 SRC_DATE=$$(git log -1 --format="%ct" -- src/ dashboard/src/ 2>/dev/null || echo 0); \
	 if [ "$$SRC_DATE" -gt "$$PROJ_DATE" ]; then \
	   echo "❌  PROJECT-STATE.md is stale."; \
	   echo "   Last src change:    $$(git log -1 --format='%ar' -- src/ dashboard/src/)"; \
	   echo "   Last state update:  $$(git log -1 --format='%ar' -- PROJECT-STATE.md)"; \
	   echo "   Update and commit PROJECT-STATE.md before promoting."; \
	   exit 1; \
	 fi
	@echo "━━━ Gate 0: PROJECT-STATE.md current ✅"
	@echo ""
	@echo "━━━ Gate 1: lint ✅ (passed above)"
	@echo ""
	@echo "━━━ Gate 2: real-data test — copying production data to test container..."
	@mkdir -p $(CURDIR)/data-test/config $(CURDIR)/data-test/cache $(CURDIR)/data-test/rh-profile
	rsync -a --delete $(CURDIR)/data/config/ $(CURDIR)/data-test/config/
	rsync -a --delete $(CURDIR)/data/cache/  $(CURDIR)/data-test/cache/
	podman run -d \
	  -p 7776:7777 \
	  -p 127.0.0.1:6083:6080 \
	  -v $(CURDIR)/data-test:/data:Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard-test \
	  $(IMAGE)
	@echo "Waiting for test container to start..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
	  curl -sf http://localhost:7776/health > /dev/null 2>&1 && echo "Container ready after $$i seconds" && break; \
	  sleep 1; \
	done
	@curl -sf http://localhost:7776/health > /dev/null || (echo "❌  Test container failed to start" && podman logs pai-dashboard-test | tail -10 && exit 1)
	@$(MAKE) test-check
	@echo "Test container ready — running ci suite against real data..."
	BASE_URL=http://localhost:7776 TEST_KNOWN_CUSTOMER="Big Ten Network Services" npx playwright test test/api/ --project=ci --reporter=line || \
	  (echo "❌  Gate 2 FAILED — real-data ci tests failed. Fix before promoting." && $(MAKE) test-down && exit 1)
	@echo "✅  Gate 2 passed — real data looks clean"
	@echo ""
	@echo "━━━ Gate 3: destructive suite — reseeding with fake data..."
	$(MAKE) test-down
	$(MAKE) test-up
	@echo "Waiting for test container to restart..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
	  curl -sf http://localhost:7776/health > /dev/null 2>&1 && echo "Container ready after $$i seconds" && break; \
	  sleep 1; \
	done
	BASE_URL=http://localhost:7776 TEST_URL=http://localhost:7776 TEST_KNOWN_CUSTOMER="Acme Corp" npx playwright test test/api/ test/lifecycle.spec.ts --project=test --reporter=line --workers=1 || \
	  (echo "❌  Gate 3 FAILED — destructive tests failed. Fix before promoting." && $(MAKE) test-down && exit 1)
	@echo "✅  Gate 3 passed"
	$(MAKE) test-down
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✅  All gates passed — safe to run: make rebuild"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# BKL-TEST-P0-05: Synthetic monitor — run once manually (LaunchAgent runs every 15min on Mac Mini)
monitor-once:
	@echo "=== Synthetic Monitor ==="
	SMOKE_URL=http://localhost:7777 bun scripts/synthetic-monitor.ts

# ── Test container pre-flight gate ───────────────────────────────────────────
# Pre-flight gate that validates the test container is current before any test run.
# Enforces the "test container currency check" rule from CLAUDE.md — a test run
# against a stale image or missing container is a false gate, not a real signal.
#
# Checks, in order:
#   1. pai-dashboard-test is running (hard fail if not)
#   2. Image build time >= last git commit time (hard fail if image is older)
#   3. AE count on 7776 is >= 4 (warning only — some specs will skip or mislead
#      with fewer AEs, but the run is still technically valid)
#
# Also invoked inside pre-promote after container start.
# (onboarding-check always calls test-rebuild-live, which builds a fresh image,
# so test-check is redundant there — the fresh rebuild satisfies the currency
# check by construction.)
test-check:
	@if ! podman ps --filter name=pai-dashboard-test --format '{{.Names}}' 2>/dev/null | grep -q '^pai-dashboard-test$$'; then \
	  echo "❌  Test container not running. Run make test-up or make test-rebuild-live first."; \
	  exit 1; \
	fi
	@IMAGE_EPOCH=$$(podman inspect pai-dashboard-test --format '{{.Created.Unix}}' 2>/dev/null); \
	 COMMIT_EPOCH=$$(git log -1 --format='%ct' 2>/dev/null); \
	 if [ -z "$$IMAGE_EPOCH" ] || [ -z "$$COMMIT_EPOCH" ]; then \
	   echo "❌  Could not read image or commit timestamp (image=$$IMAGE_EPOCH commit=$$COMMIT_EPOCH)"; \
	   exit 1; \
	 fi; \
	 if [ "$$IMAGE_EPOCH" -lt "$$COMMIT_EPOCH" ]; then \
	   echo "❌  Test container image is stale. Run make test-rebuild-live first. Image: $$IMAGE_EPOCH, Last commit: $$COMMIT_EPOCH"; \
	   exit 1; \
	 fi; \
	 echo "✅  Test container current (image: $$IMAGE_EPOCH, last commit: $$COMMIT_EPOCH)"
	@AE_COUNT=$$(curl -s http://localhost:7776/api/aes 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0); \
	 if [ "$$AE_COUNT" -lt 4 ]; then \
	   echo "WARNING: Only $$AE_COUNT AE(s) on 7776 — multi-AE tests will skip or give false results"; \
	 else \
	   echo "✅  AE count on 7776: $$AE_COUNT"; \
	 fi

# BKL-BOOT-E2E: Full onboarding smoke test — 6-phase E2E: wipe → 2 AEs → wipe → POD → UI sweep
# Always rebuilds the test image first (live data preserved — no seed wipe).
# Prerequisites: RH/SF/Tableau/Google auth must be active in data-test/rh-profile before running.
onboarding-check: test-rebuild-live
	@echo "=== Onboarding Smoke Test ==="
	@echo "Target: http://localhost:7776 (test container — image rebuilt)"

# onboarding-check-nightly: same suite but assumes image was already pulled/tagged externally.
# Used by the nightly CI workflow on the Mac Mini — avoids building from source on the runner.
onboarding-check-nightly: test-up-live
	@echo "=== Onboarding Smoke Test (nightly — pre-pulled image) ==="
	@echo "Target: http://localhost:7776 (test container — image from ghcr.io)"
	@echo "Waiting for test container to be ready (health + RH session)..."
	@for i in $$(seq 1 90); do \
	  if curl -sf http://localhost:7776/health > /dev/null 2>&1; then \
	    STATUS=$$(curl -s http://localhost:7776/api/auth/redhat/status 2>/dev/null); \
	    HAS=$$(echo "$$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('hasSession',False)).lower())" 2>/dev/null); \
	    EXP=$$(echo "$$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('sessionExpired',True)).lower())" 2>/dev/null); \
	    if [ "$$HAS" = "true" ] && [ "$$EXP" = "false" ]; then \
	      echo "Container ready and RH session confirmed after $$i seconds"; \
	      break; \
	    fi; \
	  fi; \
	  sleep 1; \
	done
	@curl -sf http://localhost:7776/health > /dev/null || (echo "❌  Test container failed to start" && podman logs pai-dashboard-test | tail -20 && exit 1)
	@STATUS=$$(curl -s http://localhost:7776/api/auth/redhat/status 2>/dev/null); \
	 HAS=$$(echo "$$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('hasSession',False)).lower())" 2>/dev/null); \
	 EXP=$$(echo "$$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('sessionExpired',True)).lower())" 2>/dev/null); \
	 if [ "$$HAS" != "true" ] || [ "$$EXP" != "false" ]; then \
	   echo "❌  RH session not valid at test start (hasSession=$$HAS sessionExpired=$$EXP) — reconnect and retry"; \
	   exit 1; \
	 fi
	BASE_URL=http://localhost:7776 CI= npx playwright test \
	  test/bootstrap-onboarding.spec.ts \
	  --project=test --reporter=line --timeout=2400000
	@echo "=== Onboarding check complete ==="

# ── Demo environment (port 7779, frozen) ─────────────────────────────────────
demo-snapshot: demo-down
	@echo "Freezing production data for demo..."
	rsync -a --delete $(CURDIR)/data/ $(CURDIR)/data-demo/
	podman tag $(IMAGE) localhost/daily-brief-dashboard:demo-latest
	@echo "Demo snapshot ready. Image tagged demo-latest. Run 'make demo-up' to start."

demo-up: demo-down
	@test -f $(CURDIR)/data-demo/config/aes.json || (echo "ERROR: Run 'make demo-snapshot' first" && exit 1)
	podman run -d \
	  -p 7779:7777 \
	  -p 6082:6080 \
	  -v $(CURDIR)/data-demo:/data:rw,Z \
	  --env-file .env \
	  -e PORT=7777 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  $(if $(OAUTH_BASE_URL),-e OAUTH_BASE_URL=$(OAUTH_BASE_URL),) \
	  --shm-size=2g \
	  --memory=8g \
	  --name pai-dashboard-demo \
	  localhost/daily-brief-dashboard:demo-latest
	@echo "Demo container running at http://localhost:7779"

demo-down:
	podman stop pai-dashboard-demo 2>/dev/null || true
	podman rm   pai-dashboard-demo 2>/dev/null || true

demo-logs:
	podman logs -f pai-dashboard-demo

# ── Demo export (ship to another machine) ────────────────────────────────────
# Creates demo-export.tar.gz with safe data only (no OAuth tokens, no RH profile).
# On target machine: tar xzf demo-export.tar.gz && podman load -i demo-image.tar && make demo-up
demo-export:
	@echo "Packaging demo data (safe files only — no OAuth tokens or RH profile)..."
	@rm -rf /tmp/pai-demo-export && mkdir -p /tmp/pai-demo-export/config
	@cp $(CURDIR)/data/config/aes.json /tmp/pai-demo-export/config/
	@cp $(CURDIR)/data/config/customers.json /tmp/pai-demo-export/config/
	@cp $(CURDIR)/data/config/settings.json /tmp/pai-demo-export/config/
	@cp $(CURDIR)/data/config/product-intel-config.json /tmp/pai-demo-export/config/
	@cp $(CURDIR)/data/config/product-alerts.json /tmp/pai-demo-export/config/ 2>/dev/null || true
	@cp $(CURDIR)/data/config/bootstrap-history.json /tmp/pai-demo-export/config/ 2>/dev/null || true
	@cp $(CURDIR)/data/config/data-sources.json /tmp/pai-demo-export/config/ 2>/dev/null || true
	@cp -r $(CURDIR)/data/cache /tmp/pai-demo-export/cache
	@tar czf $(CURDIR)/demo-export.tar.gz -C /tmp/pai-demo-export .
	@podman save localhost/daily-brief-dashboard:latest -o $(CURDIR)/demo-image.tar
	@rm -rf /tmp/pai-demo-export
	@echo ""
	@echo "Done. Two files ready to copy to demo machine:"
	@echo "  demo-export.tar.gz  — customer + all cache data (CCSP, pipeline, cases, sheets, intelligence)"
	@echo "  demo-image.tar      — container image"
	@echo ""
	@echo "On demo machine:"
	@echo "  1. Copy both files + this Makefile + .env (with GEMINI_API_KEY)"
	@echo "  2. podman load -i demo-image.tar"
	@echo "  3. mkdir -p data && tar xzf demo-export.tar.gz -C data"
	@echo "  4. make demo-up"
	@echo "  5. Open http://localhost:7779 — go through Google Auth once, then done"

# ── Demo deploy to Mac Mini ──────────────────────────────────────────────────
# Full cycle from main machine: snapshot → export → transfer → load → start on Mac Mini.
# No manual commands on Mac Mini required.
# Usage:
#   make demo-deploy           Full deploy (snapshot + export + push + start on Mac Mini)
#   make demo-status           Check if demo is running on Mac Mini
#   make demo-restart          Restart demo container on Mac Mini (no data refresh)
demo-deploy: demo-snapshot demo-export
	@echo "Transferring to Mac Mini ($(MAC_MINI_HOST))..."
	scp $(CURDIR)/demo-export.tar.gz $(CURDIR)/demo-image.tar $(MAC_MINI_HOST):~/
	scp $(CURDIR)/Makefile $(MAC_MINI_HOST):$(MAC_MINI_DIR)/Makefile
	@echo "Loading image and starting demo on Mac Mini..."
	ssh $(MAC_MINI_HOST) "\
	  podman stop pai-dashboard-demo 2>/dev/null || true && \
	  podman rm   pai-dashboard-demo 2>/dev/null || true && \
	  podman load -i ~/demo-image.tar && \
	  rm -rf $(MAC_MINI_DIR)/data-demo && \
	  mkdir -p $(MAC_MINI_DIR)/data-demo && \
	  tar xzf ~/demo-export.tar.gz -C $(MAC_MINI_DIR)/data-demo && \
	  cd $(MAC_MINI_DIR) && make demo-up \
	"
	@echo ""
	@echo "✓ Demo deployed. Accessible at https://demo.jasonhorn.io"

demo-status:
	@echo "Mac Mini demo status:"
	@ssh $(MAC_MINI_HOST) "podman ps --filter name=pai-dashboard-demo --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' && curl -s http://localhost:7779/health" 2>/dev/null || echo "Demo not running on Mac Mini"

demo-restart:
	@echo "Restarting demo container on Mac Mini..."
	@ssh $(MAC_MINI_HOST) "cd $(MAC_MINI_DIR) && make demo-down && make demo-up"
	@echo "Done."

pai-sync-remote:
	@echo "Syncing PAI memory to Mac Mini..."
	@git -C ~/.claude push 2>&1 || echo "Warning: git push failed — continuing anyway"
	@ssh $(MAC_MINI_HOST) "git -C ~/.claude pull --ff-only 2>&1"
	@echo "✓ PAI synced. Last commit: $$(git -C ~/.claude log -1 --oneline)"

demo-full-refresh: pai-sync-remote demo-deploy
	@echo "✓ Full refresh complete — PAI memory + demo data synced to Mac Mini."

# ── Instatunnel setup (Mac Mini) ─────────────────────────────────────────────
# Installs/reinstalls the instatunnel LaunchAgent + watchdog on Mac Mini.
# Run this after a Mac Mini wipe or first-time setup. Safe to re-run anytime.
# Tunnel URL: https://asa-dashboard.instatunnel.my → localhost:7779
demo-setup-tunnel:
	@echo "Installing instatunnel LaunchAgent + watchdog on $(MAC_MINI_HOST)..."
	@# Write main tunnel plist (instatunnel connect 7779 --subdomain asa-dashboard)
	@printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.pai.instatunnel-asa-dashboard</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/opt/homebrew/bin/instatunnel</string>\n    <string>connect</string>\n    <string>7779</string>\n    <string>--subdomain</string>\n    <string>asa-dashboard</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>/tmp/instatunnel-asa-dashboard.log</string>\n  <key>StandardErrorPath</key>\n  <string>/tmp/instatunnel-asa-dashboard-error.log</string>\n</dict>\n</plist>\n' > /tmp/pai-instatunnel-main.plist
	@# Write watchdog script
	@printf '#!/bin/bash\n# Watchdog: restart instatunnel LaunchAgent if localhost:7779 is unresponsive\n# Runs every 5 minutes via com.pai.instatunnel-watchdog LaunchAgent\nLOG="/tmp/instatunnel-watchdog.log"\nLABEL="com.pai.instatunnel-asa-dashboard"\n\nif ! curl -s --max-time 10 http://localhost:7779/health > /dev/null 2>&1; then\n  echo "$$(date '"'"'+%%Y-%%m-%%d %%H:%%M:%%S'"'"'): tunnel unresponsive -- restarting $$LABEL" >> "$$LOG"\n  launchctl stop "$$LABEL"\n  sleep 3\n  launchctl start "$$LABEL"\n  echo "$$(date '"'"'+%%Y-%%m-%%d %%H:%%M:%%S'"'"'): restart issued" >> "$$LOG"\nfi\n' > /tmp/pai-instatunnel-watchdog.sh
	@# Write watchdog LaunchAgent plist
	@printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.pai.instatunnel-watchdog</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/bin/bash</string>\n    <string>/Users/jasonhorn/Library/Scripts/instatunnel-watchdog.sh</string>\n  </array>\n  <key>StartInterval</key>\n  <integer>300</integer>\n  <key>RunAtLoad</key>\n  <false/>\n  <key>StandardOutPath</key>\n  <string>/tmp/instatunnel-watchdog.log</string>\n  <key>StandardErrorPath</key>\n  <string>/tmp/instatunnel-watchdog-error.log</string>\n</dict>\n</plist>\n' > /tmp/pai-instatunnel-watchdog.plist
	@# Transfer files to Mac Mini
	@scp /tmp/pai-instatunnel-main.plist $(MAC_MINI_HOST):~/Library/LaunchAgents/com.pai.instatunnel-asa-dashboard.plist
	@scp /tmp/pai-instatunnel-watchdog.sh $(MAC_MINI_HOST):~/Library/Scripts/instatunnel-watchdog.sh 2>/dev/null || (ssh $(MAC_MINI_HOST) "mkdir -p ~/Library/Scripts" && scp /tmp/pai-instatunnel-watchdog.sh $(MAC_MINI_HOST):~/Library/Scripts/instatunnel-watchdog.sh)
	@scp /tmp/pai-instatunnel-watchdog.plist $(MAC_MINI_HOST):~/Library/LaunchAgents/com.pai.instatunnel-watchdog.plist
	@# Install and reload on Mac Mini
	@ssh $(MAC_MINI_HOST) "chmod +x ~/Library/Scripts/instatunnel-watchdog.sh && launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-asa-dashboard.plist 2>/dev/null; launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-watchdog.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.pai.instatunnel-asa-dashboard.plist && launchctl load ~/Library/LaunchAgents/com.pai.instatunnel-watchdog.plist && echo 'Loaded:' && launchctl list | grep instatunnel"
	@rm -f /tmp/pai-instatunnel-main.plist /tmp/pai-instatunnel-watchdog.sh /tmp/pai-instatunnel-watchdog.plist
	@echo "Done. Verify: curl -s -o /dev/null -w '%{http_code}' https://asa-dashboard.instatunnel.my/dashboard"

# ── Demo tunnel (Cloudflare) ─────────────────────────────────────────────────
# Requires: brew install cloudflare/cloudflare/cloudflared
# Outputs a temporary *.trycloudflare.com URL — share with stakeholders.
# For permanent subdomain, set up a named tunnel: cloudflared tunnel create daily-brief
demo-tunnel:
	@which cloudflared > /dev/null || (echo "ERROR: cloudflared not found — install with: brew install cloudflare/cloudflare/cloudflared" && exit 1)
	@echo "Starting Cloudflare tunnel for demo container at http://localhost:7779..."
	@echo "Press Ctrl+C or run 'make demo-tunnel-stop' to stop."
	cloudflared tunnel --url http://localhost:7779

demo-tunnel-stop:
	@pkill -f "cloudflared tunnel" || echo "No tunnel process found"
	@echo "Tunnel stopped"

# ── Environment status ────────────────────────────────────────────────────────
env-status:
	@echo "━━━ DailyBriefDashboard Environments ━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@podman ps --filter "name=pai-dashboard" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "(no containers running)"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "Ports: prod=7777 dev=7778 test=7776 demo=7779"
	@echo "Tunnel active: $$(pgrep -f 'cloudflared tunnel' > /dev/null 2>&1 && echo YES || echo NO)"

# ── Sync daemon (Mac Mini primary — long-running, SSO-warm) ──────────────────
SYNC_DATA_DIR ?= $(CURDIR)/data-sync
SYNC_ENV_FILE ?= $(CURDIR)/.env

sync-up: sync-down
	@test -f $(SYNC_DATA_DIR)/config/settings.json || \
	  (echo "ERROR: Bootstrap $(SYNC_DATA_DIR)/config/settings.json first" && exit 1)
	podman run -d \
	  -v $(SYNC_DATA_DIR):/data:rw,Z \
	  --env-file $(SYNC_ENV_FILE) \
	  -e NODE_ROLE=primary \
	  -e SYNC_DAEMON=true \
	  -e TABLEAU_USER_EMAIL=jhorn@redhat.com \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  --shm-size=2g \
	  --memory=4g \
	  --restart=unless-stopped \
	  --name pai-sync-l3 \
	  $(IMAGE_L4)
	@echo "Sync daemon running"

sync-down:
	podman stop pai-sync-l3 2>/dev/null || true
	podman rm   pai-sync-l3 2>/dev/null || true

sync-logs:
	podman logs -f pai-sync-l3

sync-status:
	@podman ps --filter name=pai-sync-l3 --format 'table {{.Names}}\t{{.Status}}'

sync-now:
	@echo "Triggering immediate sync via daemon…"
	podman exec pai-sync-l3 touch /data/cache/sync-trigger
	@echo "Sync queued — watch logs: make sync-logs"

keepalive-now:
	@echo "Triggering immediate keepalive via daemon…"
	podman exec pai-sync-l3 touch /data/cache/keepalive-trigger
	@echo "Keepalive queued — watch logs: make sync-logs"

sync-up-vnc: sync-down
	@test -f $(SYNC_DATA_DIR)/config/settings.json || \
	  (echo "ERROR: Bootstrap $(SYNC_DATA_DIR)/config/settings.json first" && exit 1)
	podman run -d \
	  -p 6082:6080 \
	  -v $(SYNC_DATA_DIR):/data:rw,Z \
	  --env-file $(SYNC_ENV_FILE) \
	  -e NODE_ROLE=primary \
	  -e SYNC_DAEMON=true \
	  -e TABLEAU_USER_EMAIL=jhorn@redhat.com \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
	  --shm-size=2g \
	  --memory=4g \
	  --name pai-sync-l3 \
	  $(IMAGE_L4)
	@echo "Sync daemon running with VNC at http://localhost:6082"

# ── All environments ──────────────────────────────────────────────────────────
all-down: down dev-down demo-down

all-ps:
	@podman ps --filter "name=pai-dashboard" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
