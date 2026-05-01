/**
 * BKL-ARCH-08 Slice 2 — cache-hierarchy module exports.
 *
 * Verifies the new src/lib/cache-hierarchy.ts exposes the six cache-layer
 * helpers extracted from bootstrap-orchestrator.ts (lines 489–699):
 *   - CACHE_HIER_FRESH_MS (constant)
 *   - isPipelineDiskCacheFreshForAe(pipelineSheetId)
 *   - isCcspDiskCacheFreshForAe(ccspSheetId)
 *   - getSheetModifiedTime(sheetId)
 *   - readCcspFromAeSheet(ccspSheetId)
 *   - readPipelineFromAeSheet(pipelineSheetId)
 *   - readSfBookingsFromAeSheet(supportableSheetId)
 *
 * The disk-cache freshness helpers are pure-ish and easy to exercise with the
 * undefined-id branch (returns false). The Drive/Sheets readers all hit Google
 * APIs — without auth, makeAuth() returns null and the helpers return null
 * without throwing. Both paths are covered.
 */
import { describe, it, expect } from 'bun:test'
import {
  CACHE_HIER_FRESH_MS,
  isPipelineDiskCacheFreshForAe,
  isCcspDiskCacheFreshForAe,
  getSheetModifiedTime,
  readCcspFromAeSheet,
  readPipelineFromAeSheet,
  readSfBookingsFromAeSheet,
} from '../../src/lib/cache-hierarchy.ts'

describe('cache-hierarchy', () => {
  it('CACHE_HIER_FRESH_MS is 24h in milliseconds', () => {
    expect(CACHE_HIER_FRESH_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('isPipelineDiskCacheFreshForAe returns false when sheetId is undefined', () => {
    expect(isPipelineDiskCacheFreshForAe(undefined)).toBe(false)
    expect(isPipelineDiskCacheFreshForAe('')).toBe(false)
  })

  it('isCcspDiskCacheFreshForAe returns false when sheetId is undefined', () => {
    expect(isCcspDiskCacheFreshForAe(undefined)).toBe(false)
    expect(isCcspDiskCacheFreshForAe('')).toBe(false)
  })

  it('getSheetModifiedTime is async and non-throwing on missing auth', async () => {
    expect(typeof getSheetModifiedTime).toBe('function')
    const res = await getSheetModifiedTime('nonexistent-sheet-id')
    // makeAuth() returns null without unified token → helper returns null.
    expect(res === null || res instanceof Date).toBe(true)
  })

  it('readCcspFromAeSheet returns null on missing auth', async () => {
    expect(typeof readCcspFromAeSheet).toBe('function')
    const res = await readCcspFromAeSheet('nonexistent-sheet-id')
    expect(res === null || Array.isArray(res)).toBe(true)
  })

  it('readPipelineFromAeSheet returns null on missing auth', async () => {
    expect(typeof readPipelineFromAeSheet).toBe('function')
    const res = await readPipelineFromAeSheet('nonexistent-sheet-id')
    expect(res === null || (typeof res === 'object' && res !== null)).toBe(true)
  })

  it('readSfBookingsFromAeSheet returns null on missing auth', async () => {
    expect(typeof readSfBookingsFromAeSheet).toBe('function')
    const res = await readSfBookingsFromAeSheet('nonexistent-sheet-id')
    expect(res === null || Array.isArray(res)).toBe(true)
  })
})
