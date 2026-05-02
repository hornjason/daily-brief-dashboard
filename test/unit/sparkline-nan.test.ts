// BKL-UX-SPARKLINE-01: guard against NaN in sparkline point calculations.
// Tests the pure math used by InlineSparkline + SparklineKPI — no React
// rendering required. Verifies that the Number.isFinite filter prevents
// NaN y-values that caused "<polyline> attribute points: Expected number,
// '0.0,NaN'" console errors when a series had no finite data.

import { test, expect, describe } from 'bun:test'

/** Mirrors the InlineSparkline points calculation (after the NaN fix). */
function inlineSparklinePoints(values: number[], w: number, h: number): string[] | null {
  const safe = values.filter(Number.isFinite)
  if (safe.length < 2) return null
  const max = Math.max(...safe, 1)
  const min = Math.min(...safe, 0)
  const range = max - min || 1
  return safe.map((v, i) => {
    const x = (i / (safe.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 2) - 1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
}

/** Mirrors the SparklineKPI points calculation (after the NaN fix). */
function sparklineKpiPoints(data: number[], width: number, height: number): string[] | null {
  const safe = (data ?? []).filter(Number.isFinite)
  if (safe.length < 2) return null
  const min = Math.min(...safe)
  const max = Math.max(...safe)
  const range = max - min || 1
  const padding = 2
  const plotW = width - padding * 2
  const plotH = height - padding * 2
  return safe.map((v, i) => {
    const x = padding + (i / (safe.length - 1)) * plotW
    const y = padding + plotH - ((v - min) / range) * plotH
    return `${x},${y}`
  })
}

describe('BKL-UX-SPARKLINE-01: InlineSparkline NaN guard', () => {
  test('empty array → returns null (no polyline rendered)', () => {
    expect(inlineSparklinePoints([], 32, 12)).toBeNull()
  })

  test('single-item array → returns null', () => {
    expect(inlineSparklinePoints([42], 32, 12)).toBeNull()
  })

  test('array of NaN values → returns null (all filtered)', () => {
    expect(inlineSparklinePoints([NaN, NaN, NaN], 32, 12)).toBeNull()
  })

  test('mixed NaN + finite → only finite values used; no NaN in output', () => {
    const pts = inlineSparklinePoints([NaN, 10, NaN, 20], 40, 12)
    expect(pts).not.toBeNull()
    for (const pt of pts!) {
      expect(pt).not.toMatch(/NaN/)
      const [x, y] = pt.split(',').map(Number)
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  test('valid series → no NaN in output points', () => {
    const pts = inlineSparklinePoints([0, 5, 3, 8, 6], 40, 12)
    expect(pts).not.toBeNull()
    expect(pts!.length).toBe(5)
    for (const pt of pts!) {
      expect(pt).not.toMatch(/NaN/)
    }
  })
})

describe('BKL-UX-SPARKLINE-01: SparklineKPI NaN guard', () => {
  test('empty array → returns null', () => {
    expect(sparklineKpiPoints([], 80, 24)).toBeNull()
  })

  test('undefined treated as empty → returns null', () => {
    expect(sparklineKpiPoints(undefined as unknown as number[], 80, 24)).toBeNull()
  })

  test('all-NaN array → returns null', () => {
    expect(sparklineKpiPoints([NaN, NaN], 80, 24)).toBeNull()
  })

  test('mixed NaN + finite → no NaN in rendered points', () => {
    const pts = sparklineKpiPoints([NaN, 100, 200, NaN, 150], 80, 24)
    expect(pts).not.toBeNull()
    for (const pt of pts!) {
      const [x, y] = pt.split(',').map(Number)
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  test('constant-value series (range=0) → no NaN via range-or-1 guard', () => {
    const pts = sparklineKpiPoints([5, 5, 5, 5], 80, 24)
    expect(pts).not.toBeNull()
    for (const pt of pts!) expect(pt).not.toMatch(/NaN/)
  })
})
