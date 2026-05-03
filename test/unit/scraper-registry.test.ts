/**
 * test/unit/scraper-registry.test.ts
 * BKL-ARCH-02 Phase 1 — unit tests for ScraperRegistry.
 *
 * The registry is a pure singleton, so each test that mutates its contents
 * must restore prior state in afterEach to avoid cross-test bleed. We do this
 * by snapshotting list() before each test and re-registering the snapshot
 * after each test (registry has no `unregister` API by design — descriptors
 * are immutable for the life of the process in production).
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { ScraperRegistry, type ScraperDescriptor } from '../../src/scraper-registry.ts'
import type { ScraperName } from '../../src/scraper-status-store.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDescriptor(
  name: ScraperName,
  opts: { retired?: boolean; onAdopt?: () => void } = {},
): ScraperDescriptor {
  return {
    name,
    adopt: () => { opts.onAdopt?.() },
    getInMemoryLastSync: () => null,
    getInMemoryLastError: () => null,
    getInMemoryIsRunning: () => false,
    retired: opts.retired,
  }
}

// Snapshot existing descriptors so production registrations (loaded by
// importing scraper-status-store.ts via the descriptor's type import path)
// don't bleed between tests.
let _snapshot: ScraperDescriptor[] = []

beforeEach(() => {
  _snapshot = ScraperRegistry.list().map(d => ({ ...d }))
})

afterEach(() => {
  // Restore snapshot — overwrite anything tests added/replaced.
  for (const d of _snapshot) ScraperRegistry.register(d)
})

// ── register() + get() round-trip ─────────────────────────────────────────────

describe('ScraperRegistry.register + get', () => {
  test('round-trip for rh-cases', () => {
    const d = makeDescriptor('rh-cases')
    ScraperRegistry.register(d)
    expect(ScraperRegistry.get('rh-cases')).toBe(d)
  })

  test('round-trip for ccsp', () => {
    const d = makeDescriptor('ccsp')
    ScraperRegistry.register(d)
    expect(ScraperRegistry.get('ccsp')).toBe(d)
  })

  test('round-trip for sf-pipeline', () => {
    const d = makeDescriptor('sf-pipeline')
    ScraperRegistry.register(d)
    expect(ScraperRegistry.get('sf-pipeline')).toBe(d)
  })

  test('round-trip for supportable (retired)', () => {
    const d = makeDescriptor('supportable', { retired: true })
    ScraperRegistry.register(d)
    const got = ScraperRegistry.get('supportable')
    expect(got).toBe(d)
    expect(got!.retired).toBe(true)
  })

  test('register() replaces an existing descriptor under the same name', () => {
    const first = makeDescriptor('ccsp')
    const second = makeDescriptor('ccsp')
    ScraperRegistry.register(first)
    ScraperRegistry.register(second)
    expect(ScraperRegistry.get('ccsp')).toBe(second)
  })
})

// ── adoptAll() — calls every non-retired descriptor exactly once ──────────────

describe('ScraperRegistry.adoptAll', () => {
  test('calls adopt on every non-retired descriptor exactly once', () => {
    let rhCount = 0
    let ccspCount = 0
    let sfCount = 0
    let supCount = 0
    ScraperRegistry.register(makeDescriptor('rh-cases',    { onAdopt: () => { rhCount++ } }))
    ScraperRegistry.register(makeDescriptor('ccsp',        { onAdopt: () => { ccspCount++ } }))
    ScraperRegistry.register(makeDescriptor('sf-pipeline', { onAdopt: () => { sfCount++ } }))
    ScraperRegistry.register(makeDescriptor('supportable', { retired: true, onAdopt: () => { supCount++ } }))

    // Cast: our test descriptors don't need a real BrowserContext
    ScraperRegistry.adoptAll({} as any, '/tmp/profile')

    expect(rhCount).toBe(1)
    expect(ccspCount).toBe(1)
    expect(sfCount).toBe(1)
    expect(supCount).toBe(0) // retired — must be skipped
  })

  test('skips descriptors with retired: true', () => {
    let count = 0
    ScraperRegistry.register(makeDescriptor('supportable', { retired: true, onAdopt: () => { count++ } }))
    ScraperRegistry.adoptAll({} as any, '/tmp/profile')
    expect(count).toBe(0)
  })

  test('is idempotent — repeated calls do not throw', () => {
    let count = 0
    ScraperRegistry.register(makeDescriptor('rh-cases', { onAdopt: () => { count++ } }))
    expect(() => {
      ScraperRegistry.adoptAll({} as any, '/tmp/profile')
      ScraperRegistry.adoptAll({} as any, '/tmp/profile')
      ScraperRegistry.adoptAll({} as any, '/tmp/profile')
    }).not.toThrow()
    expect(count).toBe(3) // adopted 3x — idempotent in the "safe to repeat" sense
  })

  test('continues when one descriptor adopt throws', () => {
    let goodCount = 0
    ScraperRegistry.register({
      name: 'rh-cases',
      adopt: () => { throw new Error('boom') },
      getInMemoryLastSync: () => null,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
    })
    ScraperRegistry.register(makeDescriptor('ccsp', { onAdopt: () => { goodCount++ } }))
    // Must not throw — sister adoptions still proceed
    expect(() => ScraperRegistry.adoptAll({} as any, '/tmp/profile')).not.toThrow()
    expect(goodCount).toBe(1)
  })

  test('passes livePage through to descriptor.adopt when provided', () => {
    let receivedLivePage: any = 'untouched'
    ScraperRegistry.register({
      name: 'rh-cases',
      adopt: (_ctx, _profileDir, livePage) => { receivedLivePage = livePage },
      getInMemoryLastSync: () => null,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
    })
    const fakeLivePage = { tag: 'live-page' }
    ScraperRegistry.adoptAll({} as any, '/tmp/profile', fakeLivePage as any)
    expect(receivedLivePage).toBe(fakeLivePage)
  })
})

// ── list() ────────────────────────────────────────────────────────────────────

describe('ScraperRegistry.list', () => {
  test('returns all registered descriptors', () => {
    ScraperRegistry.register(makeDescriptor('rh-cases'))
    ScraperRegistry.register(makeDescriptor('ccsp'))
    const names = ScraperRegistry.list().map(d => d.name)
    expect(names).toContain('rh-cases')
    expect(names).toContain('ccsp')
  })
})
