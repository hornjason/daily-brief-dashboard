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

.PHONY: up down logs build push rebuild ps

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
