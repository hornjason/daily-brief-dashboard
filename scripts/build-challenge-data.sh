#!/usr/bin/env bash
# build-challenge-data.sh — Validates data-challenge/ has no credential files
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CHALLENGE_DIR="$PROJECT_DIR/data-challenge"

if [ ! -d "$CHALLENGE_DIR" ]; then
  echo "ERROR: data-challenge/ directory not found at $CHALLENGE_DIR"
  exit 1
fi

FOUND=$(find "$CHALLENGE_DIR" -type f \( -name "*.token" -o -name "*.session" -o -name "*.key" -o -name ".rh-token" -o -name "gcp-oauth.keys.json" \) 2>/dev/null)

if [ -n "$FOUND" ]; then
  echo "ERROR: Credential files found in data-challenge/:"
  echo "$FOUND"
  echo "Remove these files before building the challenge image."
  exit 1
fi

echo "data-challenge/ credential check passed — no token/session/key files found."
