// BKL-SYNC-L3-02: Regression tests for NODE_ROLE=primary scheduler gate.
//
// Hero installs (NODE_ROLE unset) must never register L4 writer schedulers or
// run the late-startup catch-up block. Both throw on hero installs because L4
// credentials (Tableau session, SF Lightning session) are absent.
//
// These are source-grep tests — they verify the structural guards stay in place.

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const BG_SCHED = readFileSync(resolve(ROOT, 'src/background-scheduler.ts'), 'utf-8')

// Extract the isPrimary gate block to test its contents
// The block starts at 'if (isPrimary) {\n    // Territory syncs' and ends at its closing brace
function extractIsPrimaryBlock(): string {
  const marker = 'if (isPrimary) {'
  const markerIdx = BG_SCHED.lastIndexOf(marker + '\n    // Territory syncs')
  if (markerIdx === -1) return ''
  // Find the matching closing brace (next '\n  }' after the block start)
  const closeIdx = BG_SCHED.indexOf('\n  }', markerIdx + marker.length)
  return BG_SCHED.slice(markerIdx, closeIdx + 4)
}

describe('BKL-SYNC-L3-02: isPrimary predicate declared', () => {
  // After issue #10, the predicate is sourced from src/lib/node-role.ts via
  // `nodeIsPrimary()`. The local `const isPrimary` binding is preserved so all
  // downstream gating sites read a single boolean.
  test('isPrimary predicate is declared before initBackgroundScheduler', () => {
    const predicateIdx = BG_SCHED.indexOf('const isPrimary = nodeIsPrimary()')
    const schedulerIdx = BG_SCHED.indexOf('function initBackgroundScheduler')
    expect(predicateIdx).toBeGreaterThan(-1)
    expect(schedulerIdx).toBeGreaterThan(-1)
    expect(predicateIdx).toBeLessThan(schedulerIdx)
  })

  test('background-scheduler imports isPrimary from node-role module', () => {
    expect(BG_SCHED).toContain("from './lib/node-role.ts'")
    expect(BG_SCHED).toContain('isPrimary as nodeIsPrimary')
  })

  test('background-scheduler does not read process.env.NODE_ROLE directly', () => {
    expect(BG_SCHED).not.toContain('process.env.NODE_ROLE')
  })
})

describe('BKL-SYNC-L3-02: L4 writer schedulers gated behind isPrimary', () => {
  test('isPrimary block contains scheduleTerritorySync()', () => {
    const block = extractIsPrimaryBlock()
    expect(block.length).toBeGreaterThan(0)
    expect(block).toContain('scheduleTerritorySync()')
  })

  test('isPrimary block contains schedulePipelineSync(', () => {
    const block = extractIsPrimaryBlock()
    expect(block).toContain('schedulePipelineSync(')
  })

  test('isPrimary block contains scheduleCcspSync()', () => {
    const block = extractIsPrimaryBlock()
    expect(block).toContain('scheduleCcspSync()')
  })
})

describe('BKL-SYNC-L3-02: Late startup catch-up gated behind isPrimary', () => {
  test('catch-up block requires isPrimary AND !todaySyncRan()', () => {
    expect(BG_SCHED).toContain('if (isPrimary && !todaySyncRan())')
  })

  test('old ungated catch-up pattern is gone', () => {
    // The old form was a standalone: if (!todaySyncRan()) with no isPrimary guard
    // It must not appear outside of a comment
    const lines = BG_SCHED.split('\n')
    const ungated = lines.filter(l =>
      l.match(/^\s+if \(!todaySyncRan\(\)\)/) && !l.trimStart().startsWith('//')
    )
    expect(ungated.length).toBe(0)
  })
})

describe('BKL-SYNC-L3-02: L3 reader paths NOT gated (must still run on hero)', () => {
  test('scheduleKpiSnapshot() is not inside the isPrimary L4 block', () => {
    const block = extractIsPrimaryBlock()
    expect(block).not.toContain('scheduleKpiSnapshot()')
  })

  test('scheduleEmailDelivery() is not inside the isPrimary L4 block', () => {
    const block = extractIsPrimaryBlock()
    expect(block).not.toContain('scheduleEmailDelivery()')
  })
})
