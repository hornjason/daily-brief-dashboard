#!/usr/bin/env bun
/**
 * scripts/preflight.ts
 *
 * Startup preflight validator — runs at container boot before the server starts.
 * Called by entrypoint.sh before `exec bun run server.ts`.
 *
 * Checks:
 *   1. .env file exists
 *   2. REDHAT_OFFLINE_TOKEN is set and not the placeholder value
 *   3. gcp-oauth.keys.json exists in CONFIG_DIR
 *   4. data/config directory exists
 *   5. data/cache directory exists
 *
 * Always exits 0 — warns about missing config but never blocks startup.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../data/config')
const CACHE_DIR  = process.env.CACHE_DIR  ?? resolve(import.meta.dir, '../data/cache')

const PLACEHOLDER_TOKEN = 'your_offline_token_here'

let passed = 0
let warned = 0

function pass(label: string, detail = '') {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  passed++
}

function warn(label: string, detail = '') {
  console.log(`  ⚠️  ${label}${detail ? ` — ${detail}` : ''}`)
  warned++
}

console.log('\n🔍 PAI Dashboard — preflight check')

// ── 1. .env file exists ───────────────────────────────────────────────────────
if (existsSync('.env') || existsSync('/data/.env')) {
  pass('.env file present')
} else {
  warn('.env file missing', 'copy .env.example to .env and set REDHAT_OFFLINE_TOKEN')
}

// ── 2a. REDHAT_OFFLINE_TOKEN is set ──────────────────────────────────────────
if (!process.env.REDHAT_OFFLINE_TOKEN) {
  warn('REDHAT_OFFLINE_TOKEN not set', 'portal scraping will fail — set token in .env')
} else if (process.env.REDHAT_OFFLINE_TOKEN === PLACEHOLDER_TOKEN) {
  // ── 2b. Not the placeholder value ─────────────────────────────────────────
  warn('REDHAT_OFFLINE_TOKEN is still the placeholder', 'get your token at https://access.redhat.com/management/api')
} else {
  pass('REDHAT_OFFLINE_TOKEN configured')
}

// ── 3. gcp-oauth.keys.json exists ────────────────────────────────────────────
const oauthKeysPath = resolve(CONFIG_DIR, 'gcp-oauth.keys.json')
if (existsSync(oauthKeysPath)) {
  pass('Google OAuth keys present', oauthKeysPath)
} else {
  warn('gcp-oauth.keys.json missing', 'upload via setup wizard at http://localhost:7777')
}

// ── 4. data/config directory exists ──────────────────────────────────────────
if (existsSync(CONFIG_DIR)) {
  pass('Config directory exists', CONFIG_DIR)
} else {
  warn('Config directory missing', `expected ${CONFIG_DIR} — run 'make setup' on host`)
}

// ── 5. data/cache directory exists ───────────────────────────────────────────
if (existsSync(CACHE_DIR)) {
  pass('Cache directory exists', CACHE_DIR)
} else {
  warn('Cache directory missing', `expected ${CACHE_DIR} — run 'make setup' on host`)
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log()
if (warned === 0) {
  console.log('✅ All preflight checks passed\n')
} else {
  console.log('⚠️  SETUP INCOMPLETE — see warnings above')
  console.log('   The server will start but some features may not work until setup is complete.\n')
}

process.exit(0)
