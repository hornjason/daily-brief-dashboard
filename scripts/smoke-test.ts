#!/usr/bin/env bun
/**
 * scripts/smoke-test.ts
 *
 * Real-data smoke test — runs against the live server at localhost:7777.
 * Called by the git pre-push hook and directly via `bun run test:smoke`.
 *
 * Checks:
 *   1. Server reachable
 *   2. /api/kpis returns healthy data (cases, accounts)
 *   3. /api/customers returns a populated list
 *   4. cases.json cache exists and is fresh (< 5h)
 *   5. customers.json config exists with entries
 *   6. RH session file present (session is established)
 *
 * If the server is unreachable the script exits 0 with a warning rather
 * than blocking the push — the container may not be running on every machine.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL  = process.env.SMOKE_URL  ?? 'http://localhost:7777'
const DATA_DIR  = process.env.DATA_DIR   ?? resolve(import.meta.dir, '../data')
const CONFIG_DIR = resolve(DATA_DIR, 'config')
const CACHE_DIR  = resolve(DATA_DIR, 'cache')

const CASES_MAX_AGE_MS = 5 * 60 * 60 * 1000  // 5 hours

let passed = 0
let failed = 0
let warned = 0

function pass(label: string, detail = '') {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  passed++
}

function fail(label: string, detail = '') {
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  failed++
}

function warn(label: string, detail = '') {
  console.log(`  ⚠️  ${label}${detail ? ` — ${detail}` : ''}`)
  warned++
}

async function get(path: string): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(8_000) })
    const body = res.ok ? await res.json().catch(() => null) : null
    return { ok: res.ok, status: res.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

console.log('\n🔍 ASA Command Center — smoke test')
console.log(`   Server: ${BASE_URL}`)
console.log(`   Data:   ${DATA_DIR}\n`)

// ── 1. Server reachability ───────────────────────────────────────────────────
const health = await get('/api/kpis')

if (health.status === 0) {
  warn('Server unreachable — is the container running?', `${BASE_URL} timed out`)
  warn('Skipping API checks — push will proceed')
  console.log('\n⚠️  0 passed, 0 failed, 2 warnings — push allowed (server offline)\n')
  process.exit(0)
}

if (!health.ok) {
  fail('GET /api/kpis', `HTTP ${health.status}`)
} else {
  pass('Server reachable', `HTTP ${health.status}`)
}

// ── 2. KPI data quality ──────────────────────────────────────────────────────
const kpis = health.body
if (kpis) {
  if (typeof kpis.openCasesTotal === 'number' && kpis.openCasesTotal > 0) {
    pass('Open cases present', `openCasesTotal = ${kpis.openCasesTotal}`)
  } else {
    fail('openCasesTotal > 0', `got ${kpis.openCasesTotal} — cache may be stale or session expired`)
  }

  if (typeof kpis.totalAccounts === 'number' && kpis.totalAccounts > 0) {
    pass('Accounts loaded', `totalAccounts = ${kpis.totalAccounts}`)
  } else {
    fail('totalAccounts > 0', `got ${kpis.totalAccounts} — check customers.json`)
  }
} else {
  fail('KPI response body', 'null or unparseable')
}

// ── 3. Customers endpoint ────────────────────────────────────────────────────
const customers = await get('/customers')
if (customers.ok && Array.isArray(customers.body) && customers.body.length > 0) {
  pass('Customers endpoint', `${customers.body.length} customers returned`)
} else if (customers.ok && Array.isArray(customers.body)) {
  fail('Customers endpoint', 'returned empty array — check customers.json')
} else {
  fail('Customers endpoint', `HTTP ${customers.status}`)
}

// ── 4. Cases cache freshness ─────────────────────────────────────────────────
const casesPath = resolve(CACHE_DIR, 'cases.json')
if (existsSync(casesPath)) {
  try {
    const cache = JSON.parse(readFileSync(casesPath, 'utf-8'))
    const age = Date.now() - new Date(cache.scrapedAt ?? 0).getTime()
    const ageMin = Math.round(age / 60_000)
    if (age < CASES_MAX_AGE_MS) {
      pass('Cases cache fresh', `scraped ${ageMin}m ago`)
    } else {
      warn('Cases cache stale', `last scraped ${ageMin}m ago — consider running a manual sync`)
    }
  } catch {
    fail('Cases cache readable', 'JSON parse error')
  }
} else {
  fail('Cases cache exists', `${casesPath} not found`)
}

// ── 5. Config files ──────────────────────────────────────────────────────────
const customersPath = resolve(CONFIG_DIR, 'customers.json')
if (existsSync(customersPath)) {
  try {
    const cfg = JSON.parse(readFileSync(customersPath, 'utf-8'))
    const count = (cfg.customers ?? []).length
    if (count > 0) {
      pass('customers.json present', `${count} customers configured`)
    } else {
      fail('customers.json has entries', 'customers array is empty')
    }
  } catch {
    fail('customers.json readable', 'JSON parse error')
  }
} else {
  fail('customers.json exists', customersPath)
}

// ── 6. RH session ────────────────────────────────────────────────────────────
const rhSessionPath = resolve(CONFIG_DIR, '.rh-session.json')
if (existsSync(rhSessionPath)) {
  pass('RH session established', '.rh-session.json present')
} else {
  warn('RH session missing', 'portal not connected — run Connect Red Hat in dashboard')
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log()
if (failed === 0) {
  console.log(`✅ ${passed} passed${warned > 0 ? `, ${warned} warnings` : ''} — push proceeding\n`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} failed, ${passed} passed${warned > 0 ? `, ${warned} warnings` : ''} — push blocked`)
  console.log('   Fix the issues above or use git push --no-verify to skip\n')
  process.exit(1)
}
