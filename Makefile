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

IMAGE  := localhost/daily-brief-dashboard:latest
REMOTE := ghcr.io/hornjason/daily-brief-dashboard:latest
DATA   := $(CURDIR)/data

.PHONY: up down logs build push rebuild ps setup release-patch release-minor release-major version

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
