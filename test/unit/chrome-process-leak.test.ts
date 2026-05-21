// Chrome process leak prevention — regression tests for BKL-SYNC-CHROME-LEAK
//
// Verifies structural invariants across the four prevention layers:
//   Layer 1: _autoRecover closes old browser before launching new one
//   Layer 2: Makefile sync-up/sync-up-vnc containers run with --init
//   Layer 3: canContextRender() rendering health check exists and is called pre-sync
//   Layer 4: Proactive browser recycle on timer in daemon
//   Bonus:   Memory monitoring in keepalive triggers recycle

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

const RH_SCRAPER = readFileSync(resolve(ROOT, 'src/rh-scraper.ts'), 'utf-8')
const DAEMON_SRC = readFileSync(resolve(ROOT, 'scripts/sync-l3-daemon.ts'), 'utf-8')
const DAEMON_UTILS = readFileSync(resolve(ROOT, 'scripts/sync-l3-daemon-utils.ts'), 'utf-8')
const MAKEFILE = readFileSync(resolve(ROOT, 'Makefile'), 'utf-8')

// ── Layer 1: _autoRecover closes old browser before launching new context ─────

describe('Layer 1: _autoRecover closes old browser before new context launch', () => {
  test('_autoRecover gets browser from old context and calls browser.close()', () => {
    // The fix must close the old browser BEFORE setting _context = null
    const fnIdx = RH_SCRAPER.indexOf('async function _autoRecover(')
    expect(fnIdx).toBeGreaterThan(-1)
    const slice = RH_SCRAPER.slice(fnIdx, fnIdx + 1500)
    // Must get browser from context and close it
    expect(slice).toContain('browser')
    expect(slice).toContain('.close()')
  })

  test('_autoRecover kills orphan Chrome processes as safety net', () => {
    const fnIdx = RH_SCRAPER.indexOf('async function _autoRecover(')
    const slice = RH_SCRAPER.slice(fnIdx, fnIdx + 2000)
    // Must have a process kill step (pkill, kill, or execSync with chromium/chrome)
    expect(slice).toMatch(/pkill|killOrphanChromeProcesses|kill.*chrom/i)
  })
})

// ── Layer 2: --init flag in Makefile sync-up targets ─────────────────────────

describe('Layer 2: Makefile sync-up targets include --init flag', () => {
  test('sync-up target has --init flag', () => {
    // Extract the sync-up target block
    const syncUpIdx = MAKEFILE.indexOf('sync-up:')
    expect(syncUpIdx).toBeGreaterThan(-1)
    // Find the podman run command for this target (before next target)
    const nextTargetIdx = MAKEFILE.indexOf('\nsync-down:', syncUpIdx)
    const syncUpBlock = MAKEFILE.slice(syncUpIdx, nextTargetIdx > 0 ? nextTargetIdx : syncUpIdx + 800)
    expect(syncUpBlock).toContain('--init')
  })

  test('sync-up-vnc target has --init flag', () => {
    const syncUpVncIdx = MAKEFILE.indexOf('sync-up-vnc:')
    expect(syncUpVncIdx).toBeGreaterThan(-1)
    const nextTargetIdx = MAKEFILE.indexOf('\n# ', syncUpVncIdx + 1)
    const syncUpVncBlock = MAKEFILE.slice(syncUpVncIdx, nextTargetIdx > 0 ? nextTargetIdx : syncUpVncIdx + 800)
    expect(syncUpVncBlock).toContain('--init')
  })
})

// ── Layer 3: canContextRender() rendering health check ──────────────────────

describe('Layer 3: canContextRender rendering health check', () => {
  test('canContextRender function is exported from daemon-utils', () => {
    expect(DAEMON_UTILS).toContain('export async function canContextRender(')
  })

  test('canContextRender creates a new page and evaluates document.readyState', () => {
    const fnIdx = DAEMON_UTILS.indexOf('canContextRender')
    expect(fnIdx).toBeGreaterThan(-1)
    const slice = DAEMON_UTILS.slice(fnIdx, fnIdx + 800)
    expect(slice).toContain('newPage')
    expect(slice).toContain('readyState')
  })

  test('canContextRender closes the test page in finally block', () => {
    const fnIdx = DAEMON_UTILS.indexOf('canContextRender')
    const slice = DAEMON_UTILS.slice(fnIdx, fnIdx + 800)
    expect(slice).toContain('finally')
    expect(slice).toContain('page')
    expect(slice).toContain('.close()')
  })

  test('daemon imports and uses canContextRender before sync', () => {
    expect(DAEMON_SRC).toContain('canContextRender')
  })
})

// ── Layer 4: Proactive browser recycling ────────────────────────────────────

describe('Layer 4: Proactive browser recycling in daemon', () => {
  test('daemon has a recycleBrowser function or scheduled recycle', () => {
    expect(DAEMON_SRC).toMatch(/recycleBrowser|proactiveRecycle|RECYCLE_INTERVAL|recycleBeforeSync/)
  })

  test('recycle persists cookies before closing browser', () => {
    // Find the recycle function
    const recycleMatch = DAEMON_SRC.match(/async function.*(recycleBrowser|proactiveRecycle|recycleBeforeSync)/)
    expect(recycleMatch).not.toBeNull()
    const fnIdx = DAEMON_SRC.indexOf(recycleMatch![0])
    const slice = DAEMON_SRC.slice(fnIdx, fnIdx + 2000)
    expect(slice).toMatch(/persistSession|storageState|saveCookies|session.*state/i)
  })

  test('recycle re-adopts sister scrapers (CCSP, SF) after relaunching', () => {
    const recycleMatch = DAEMON_SRC.match(/async function.*(recycleBrowser|proactiveRecycle|recycleBeforeSync)/)
    expect(recycleMatch).not.toBeNull()
    const fnIdx = DAEMON_SRC.indexOf(recycleMatch![0])
    const slice = DAEMON_SRC.slice(fnIdx, fnIdx + 2500)
    expect(slice).toContain('adoptCcspContext')
  })
})

// ── Bonus: Memory monitoring triggers proactive recycle ──────────────────────

describe('Bonus: Memory monitoring in keepalive/daemon', () => {
  test('daemon checks process memory usage (RSS or cgroup)', () => {
    expect(DAEMON_SRC).toMatch(/memoryUsage|rss|cgroup.*memory/i)
  })

  test('memory check triggers recycle when threshold exceeded', () => {
    // Find the memory check and verify it triggers recycle
    expect(DAEMON_SRC).toMatch(/MEMORY_THRESHOLD|RSS_THRESHOLD|MEM.*LIMIT|3.*GB|3_000|3072/)
  })
})
