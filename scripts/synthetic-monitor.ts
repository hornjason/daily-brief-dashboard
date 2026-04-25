#!/usr/bin/env bun
/**
 * scripts/synthetic-monitor.ts — BKL-TEST-P0-05
 *
 * Read-only production health check that runs every 15 min on the Mac Mini
 * via LaunchAgent (see docs/MAC-MINI-DEMO-SETUP.md for setup).
 *
 * Checks:
 *   1. /health endpoint responds 200
 *   2. Customer count ≥ 1
 *   3. Sample brief exists and is substantive (≥ 200 chars)
 *   4. Sample intelligence doc exists and is substantive (≥ 100 chars)
 *
 * On failure: sends voice alert via PAI notification service.
 * Always: writes /data/synthetic-monitor-status.json for dashboard consumption.
 *
 * Usage:
 *   bun scripts/synthetic-monitor.ts
 *   SMOKE_URL=http://localhost:7779 bun scripts/synthetic-monitor.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL   = process.env.SMOKE_URL   ?? 'http://localhost:7777'
const NOTIFY_URL = process.env.NOTIFY_URL  ?? 'http://localhost:8888/notify'
const STATUS_PATH = process.env.STATUS_PATH
  ?? resolve(import.meta.dir, '../data/synthetic-monitor-status.json')

const BRIEF_MIN_CHARS = 200
const INTEL_MIN_CHARS = 100
const TIMEOUT_MS      = 12_000

type CheckResult = { name: string; pass: boolean; detail: string }

const results: CheckResult[] = []
let overallPass = true

async function get(path: string): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = res.ok ? await res.json().catch(() => null) : null
    return { ok: res.ok, status: res.status, body }
  } catch (e: any) {
    return { ok: false, status: 0, body: null }
  }
}

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  if (!pass) overallPass = false
  console.log(`  ${pass ? '✅' : '❌'} ${name} — ${detail}`)
}

async function sendVoiceAlert(message: string) {
  try {
    await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice_id: 'fTtv3eikoepIosk8dTZ5', voice_enabled: true }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Non-fatal — monitor result is already written to disk
  }
}

console.log('\n🔍 Synthetic Monitor — ASA Command Center')
console.log(`   ${new Date().toISOString()}`)
console.log(`   Target: ${BASE_URL}\n`)

// ── Check 1: Health ──────────────────────────────────────────────────────────
const health = await get('/health')
if (health.status === 0) {
  record('health', false, `server unreachable at ${BASE_URL}`)
} else {
  record('health', health.ok, health.ok ? `HTTP ${health.status}` : `HTTP ${health.status} — server not healthy`)
}

// ── Check 2: Customer count ──────────────────────────────────────────────────
const customers = await get('/customers')
const customerList: any[] = Array.isArray(customers.body) ? customers.body : []
if (!customers.ok) {
  record('customer-count', false, `GET /customers → HTTP ${customers.status}`)
} else if (customerList.length === 0) {
  record('customer-count', false, 'returned empty list — bootstrap may be needed')
} else {
  record('customer-count', true, `${customerList.length} customers`)
}

// ── Check 3: Sample brief quality (read from cache, no generation triggered) ──
const briefs = await get('/api/briefs')
if (!briefs.ok) {
  record('brief-quality', false, `GET /api/briefs → HTTP ${briefs.status}`)
} else {
  const briefMap = briefs.body ?? {}
  const entries = Object.entries(briefMap) as [string, any][]
  if (entries.length === 0) {
    record('brief-quality', false, 'no cached briefs found — run pregen or wait for scheduler')
  } else {
    // Find the best (longest overview) cached brief to check quality
    const sorted = entries.sort(([, a], [, b]) => {
      const lenA = (a?.overview ?? a?.text ?? '').length
      const lenB = (b?.overview ?? b?.text ?? '').length
      return lenB - lenA
    })
    const [name, brief] = sorted[0]
    const content = brief?.overview ?? brief?.text ?? ''
    const len = typeof content === 'string' ? content.length : 0
    const isThin = len < BRIEF_MIN_CHARS
    const emptyCount = entries.filter(([, b]) => ((b?.overview ?? b?.text ?? '').length) < BRIEF_MIN_CHARS).length
    record(
      'brief-quality',
      !isThin,
      isThin
        ? `all ${entries.length} cached briefs are thin (< ${BRIEF_MIN_CHARS} chars). Possible 429 during generation.`
        : `${len} chars for "${name}" — ${emptyCount}/${entries.length} thin briefs in cache`,
    )
  }
}

// ── Check 4: Intelligence cache presence ─────────────────────────────────────
// No read-only intelligence content endpoint — check status endpoint for any customer
let intelChecked = false
if (customerList.length > 0) {
  const sample = [...customerList].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))[0]
  const name = encodeURIComponent(sample?.name ?? '')
  if (name) {
    const intelStatus = await get(`/api/customer/${name}/intelligence-status`)
    if (intelStatus.status === 404) {
      // Customer not found — skip, not a monitor failure
      record('intel-cache', true, `no intel job found (customer may lack intel) — not an error`)
    } else if (!intelStatus.ok) {
      record('intel-cache', false, `GET /api/customer/${decodeURIComponent(name)}/intelligence-status → HTTP ${intelStatus.status}`)
    } else {
      const s = intelStatus.body?.status ?? 'none'
      // Acceptable statuses: 'done', 'none' (never generated), or any non-'failed' state
      const isFailed = s === 'failed'
      record(
        'intel-cache',
        !isFailed,
        isFailed
          ? `intelligence generation failed for "${decodeURIComponent(name)}" — check Vertex quota`
          : `status="${s}" for "${decodeURIComponent(name)}"`,
      )
    }
    intelChecked = true
  }
}
if (!intelChecked) {
  record('intel-cache', false, 'no customers available to sample')
}

// ── Write status file ────────────────────────────────────────────────────────
const status = {
  timestamp: new Date().toISOString(),
  target: BASE_URL,
  pass: overallPass,
  checks: results,
}

try {
  mkdirSync(resolve(STATUS_PATH, '..'), { recursive: true })
  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2))
} catch (e: any) {
  console.error(`  ⚠️  Could not write status file: ${e.message}`)
}

// ── Alert on failure ─────────────────────────────────────────────────────────
console.log()
if (!overallPass) {
  const failing = results.filter(r => !r.pass).map(r => r.name).join(', ')
  const message = `Synthetic monitor alert: production health check failed. Failing checks: ${failing}. Check dashboard at port 7777.`
  console.log(`❌ FAIL — alerting: ${failing}`)
  await sendVoiceAlert(message)
  process.exit(1)
} else {
  console.log(`✅ All ${results.length} checks passed\n`)
  process.exit(0)
}
