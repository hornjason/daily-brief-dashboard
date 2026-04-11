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
#   make rebuild   Full cycle: build → push → restart container
#   make ps        Show container status
#   make seed         Populate data-test/ with known fixture data
#   make test-up      Start test container on port 7776 (ALLOW_RESET=true)
#   make test-down    Stop test container
#   make demo-snapshot Freeze prod data + image for demo
#   make demo-up      Start demo container on port 7779 (read-only)
#   make demo-tunnel  Share demo via Cloudflare tunnel (temporary URL)
#   make env-status   Show which containers are running
#   make pre-promote  Run all gates before make rebuild
#   make lint         Check for empty catch blocks in dashboard/src/

IMAGE  := localhost/daily-brief-dashboard:latest
REMOTE := ghcr.io/hornjason/daily-brief-dashboard:latest
DATA   := $(CURDIR)/data

.PHONY: up down logs build push rebuild ps setup release-patch release-minor release-major version \
       dev-snapshot dev-up dev-down dev-logs \
       seed test-up test-down test-logs lint \
       pre-promote \
       demo-snapshot demo-up demo-down demo-logs \
       all-down all-ps

up: down
	podman run -d \
	  -p 7777:7777 \
	  -p 127.0.0.1:6080:6080 \
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

logs:
	podman logs -f pai-dashboard

build:
	@if echo "$(CURDIR)" | grep -q '\.claude/worktrees'; then \
	  echo "❌  make rebuild must be run from the project root, not a git worktree"; \
	  echo "   Current dir: $(CURDIR)"; \
	  echo "   Run from: $(shell git worktree list 2>/dev/null | head -1 | awk '{print $$1}')"; \
	  exit 1; \
	fi
	podman build -t $(IMAGE) -t $(REMOTE) .

push:
	podman push $(REMOTE)

rebuild: build push up

ps:
	podman ps --filter name=pai-dashboard --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# ── Release Management ────────────────────────────────────────────────────────
# Bumps package.json, commits, tags, and pushes — triggers release.yml in CI.
# Use patch for bug fixes, minor for new features, major for breaking changes.

version:
	@node -p "require('./package.json').version"

release-patch:
	npm version patch -m "chore: release v%s"
	git push && git push --tags

release-minor:
	npm version minor -m "chore: release v%s"
	git push && git push --tags

release-major:
	npm version major -m "chore: release v%s"
	git push && git push --tags

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
	@mkdir -p $(CURDIR)/data-test/config $(CURDIR)/data-test/cache/intelligence $(CURDIR)/data-test/rh-profile
	@cp $(CURDIR)/scripts/seed-data/aes.json         $(CURDIR)/data-test/config/aes.json
	@cp $(CURDIR)/scripts/seed-data/customers.json   $(CURDIR)/data-test/config/customers.json
	@cp $(CURDIR)/scripts/seed-data/settings.json    $(CURDIR)/data-test/config/settings.json
	@cp $(CURDIR)/scripts/seed-data/product-intel-config.json $(CURDIR)/data-test/config/product-intel-config.json
	@echo '{"history":[]}' > $(CURDIR)/data-test/config/bootstrap-history.json
	@echo '{"folders":{},"lastChecked":null}' > $(CURDIR)/data-test/config/drive-watcher-state.json
	@cp -r $(CURDIR)/scripts/seed-data/cache/. $(CURDIR)/data-test/cache/
	@echo "✅  Test data seeded at data-test/"

test-up: test-down seed
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
	  --shm-size=1g \
	  --memory=4g \
	  --name pai-dashboard-test \
	  $(IMAGE)
	@echo "Test container running at http://localhost:7776 (ALLOW_RESET=true)"

test-down:
	podman stop pai-dashboard-test 2>/dev/null || true
	podman rm   pai-dashboard-test 2>/dev/null || true

test-logs:
	podman logs -f pai-dashboard-test

lint:
	@echo "Checking for empty catch blocks in dashboard/src/..."
	@bash $(CURDIR)/scripts/check-empty-catches.sh

# ── Pre-promote gate ──────────────────────────────────────────────────────────
# Runs the full CI suite against real production data in an isolated container.
# All three gates must pass before make rebuild.
#
# Gate 1 (lint):        No silent catch blocks in dashboard/src/
# Gate 2 (real data):   ci suite passes against real data on port 7776
# Gate 3 (destructive): @destructive suite passes against seed data on port 7776
#
# Usage: make pre-promote && make rebuild
pre-promote: lint test-down
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
	  --shm-size=1g \
	  --memory=4g \
	  --name pai-dashboard-test \
	  $(IMAGE)
	@echo "Waiting for test container to start..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
	  curl -sf http://localhost:7776/health > /dev/null 2>&1 && echo "Container ready after $$i seconds" && break; \
	  sleep 1; \
	done
	@curl -sf http://localhost:7776/health > /dev/null || (echo "❌  Test container failed to start" && podman logs pai-dashboard-test | tail -10 && exit 1)
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
	  -p 127.0.0.1:6082:6080 \
	  -v $(CURDIR)/data-demo:/data:ro,Z \
	  --tmpfs /data/cache:size=512m \
	  --tmpfs /data/rh-profile:size=256m \
	  --env-file .env \
	  -e PORT=7777 \
	  -e CONFIG_DIR=/data/config \
	  -e CACHE_DIR=/data/cache \
	  -e RH_PROFILE_DIR=/data/rh-profile \
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

# ── All environments ──────────────────────────────────────────────────────────
all-down: down dev-down demo-down

all-ps:
	@podman ps --filter "name=pai-dashboard" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
