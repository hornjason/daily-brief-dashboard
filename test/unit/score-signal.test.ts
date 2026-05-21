/**
 * Unit tests for scoreSignal() in feature-module-registry.ts — GitHub Issue #338
 *
 * Tests centralized signal scoring logic: specificity detection, boosters, and clamping.
 * ADR-027 §3-4 — modules provide rawRelevance + metadata, registry applies scoring.
 */

import { describe, test, expect } from 'bun:test'
import { scoreSignal } from '../../src/feature-module-registry.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: 'test-module',
    type: 'intelligence',
    headline: 'Test Signal',
    detail: 'Test detail',
    timestamp: new Date().toISOString(),
    rawRelevance: 0.5,
    ...overrides,
  }
}

// ── Specificity Detection Tests ─────────────────────────────────────────────

describe('scoreSignal - specificity detection', () => {
  test('customer signal (has customerSlug) gets floor 0.50', () => {
    const signal = makeSignal({
      rawRelevance: 0.0,
      metadata: { customerSlug: 'acme-corp' },
    })
    const scored = scoreSignal(signal)
    expect(scored.score).toBeGreaterThanOrEqual(0.50)
  })

  test('customer signal (has accountNumber) gets floor 0.50', () => {
    const signal = makeSignal({
      rawRelevance: 0.0,
      metadata: { accountNumber: '12345' },
    })
    const scored = scoreSignal(signal)
    expect(scored.score).toBeGreaterThanOrEqual(0.50)
  })

  test('customer signal (has severity) gets floor 0.50', () => {
    const signal = makeSignal({
      rawRelevance: 0.0,
      metadata: { severity: 2 },
    })
    const scored = scoreSignal(signal)
    expect(scored.score).toBeGreaterThanOrEqual(0.50)
  })

  test('industry signal (has industryMatch) gets floor 0.35, ceiling 0.69', () => {
    const signal = makeSignal({
      rawRelevance: 0.0,
      metadata: { industryMatch: true },
    })
    const scored = scoreSignal(signal)
    expect(scored.score).toBeGreaterThanOrEqual(0.35)
    expect(scored.score).toBeLessThanOrEqual(0.69)
  })

  test('general signal gets floor 0.10, ceiling 0.35', () => {
    const signal = makeSignal({
      rawRelevance: 0.0,
      metadata: {},
    })
    const scored = scoreSignal(signal)
    expect(scored.score).toBeGreaterThanOrEqual(0.10)
    expect(scored.score).toBeLessThanOrEqual(0.35)
  })
})

// ── Booster Tests ────────────────────────────────────────────────────────────

describe('scoreSignal - boosters', () => {
  test('redHatProducts adds +0.10', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { redHatProducts: ['OpenShift', 'RHEL'] },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })

  test('acvPlus > 0 adds +0.10', () => {
    // Note: acvPlus triggers customer specificity, so we need to compare within same specificity
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { customerSlug: 'test' }, // Force customer specificity without booster
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { customerSlug: 'test', acvPlus: 50000 },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })

  test('amount > 0 adds +0.10', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { amount: 25000 },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })

  test('confidence HIGH adds +0.05', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { confidence: 'HIGH' },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.05, 2)
  })

  test('confidence LOW subtracts -0.10', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { confidence: 'LOW' },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) - 0.10, 2)
  })

  test('hasCloudSpend adds +0.10', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { hasCloudSpend: true },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })

  test('severity 1 adds +0.15', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { customerSlug: 'test' }, // needed for customer specificity
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { customerSlug: 'test', severity: 1 },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.15, 2)
  })

  test('severity 2 adds +0.10', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { customerSlug: 'test' },
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { customerSlug: 'test', severity: 2 },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })

  test('endDate within 90 days adds +0.10', () => {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 45) // 45 days from now

    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { endDate: futureDate.toISOString() },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })

  test('endDate beyond 90 days does not add boost', () => {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 120) // 120 days from now

    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { endDate: futureDate.toISOString() },
    }))

    expect(withBooster.score).toBeCloseTo(withoutBooster.score ?? 0, 2)
  })

  test('context evaluating adds +0.10', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { context: 'evaluating' },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })

  test('context migrating_from adds +0.10', () => {
    const withoutBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    }))

    const withBooster = scoreSignal(makeSignal({
      rawRelevance: 0.5,
      metadata: { context: 'migrating_from' },
    }))

    expect(withBooster.score).toBeCloseTo((withoutBooster.score ?? 0) + 0.10, 2)
  })
})

// ── Stacking and Clamping Tests ──────────────────────────────────────────────

describe('scoreSignal - booster stacking and clamping', () => {
  test('multiple boosters stack correctly', () => {
    const signal = makeSignal({
      rawRelevance: 0.5,
      metadata: {
        customerSlug: 'test',         // customer specificity (0.50 + 0.5*0.50 = 0.75)
        redHatProducts: ['OpenShift'], // +0.10
        acvPlus: 50000,                // +0.10
        confidence: 'HIGH',            // +0.05
        hasCloudSpend: true,           // +0.10
        severity: 1,                   // +0.15
      },
    })

    const scored = scoreSignal(signal)

    // Base: 0.75 (customer floor + 0.5 * 0.50 range)
    // Boosters: +0.10 + 0.10 + 0.05 + 0.10 + 0.15 = +0.50
    // Total: 1.25, clamped to customer ceiling of 1.00
    expect(scored.score).toBe(1.00)
  })

  test('customer signal score is clamped to specificity range (cannot go below 0.50)', () => {
    const signal = makeSignal({
      rawRelevance: 0.0, // Try to go to floor
      metadata: {
        customerSlug: 'test',
        confidence: 'LOW', // -0.10 penalty
      },
    })

    const scored = scoreSignal(signal)

    // Base would be 0.50 (customer floor)
    // Penalty: -0.10
    // Result: 0.40, but clamped to customer floor of 0.50
    expect(scored.score).toBe(0.50)
  })

  test('industry signal is clamped to ceiling 0.69', () => {
    // Note: acvPlus triggers customer specificity, so we don't include it here
    const signal = makeSignal({
      rawRelevance: 1.0,
      metadata: {
        industryMatch: true,
        redHatProducts: ['RHEL'],
        confidence: 'HIGH',
        hasCloudSpend: true,
      },
    })

    const scored = scoreSignal(signal)

    // Base: 0.35 + (1.0 * 0.34) = 0.69
    // Boosters: +0.10 + 0.05 + 0.10 = +0.25
    // Total: 0.94, clamped to industry ceiling of 0.69
    expect(scored.score).toBe(0.69)
  })

  test('general signal is clamped to ceiling 0.35', () => {
    const signal = makeSignal({
      rawRelevance: 1.0,
      metadata: {
        redHatProducts: ['Ansible'],
        confidence: 'HIGH',
      },
    })

    const scored = scoreSignal(signal)

    // Base: 0.10 + (1.0 * 0.25) = 0.35
    // Boosters: +0.10 + 0.05 = +0.15
    // Total: 0.50, clamped to general ceiling of 0.35
    expect(scored.score).toBe(0.35)
  })
})

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe('scoreSignal - edge cases', () => {
  test('signal without rawRelevance defaults to 0.5', () => {
    const signal = makeSignal({
      rawRelevance: undefined,
      metadata: { customerSlug: 'test' },
    })

    const scored = scoreSignal(signal)

    // Customer floor 0.50 + (0.5 * 0.50 range) = 0.75
    expect(scored.score).toBe(0.75)
  })

  test('signal without metadata gets general scoring', () => {
    const signal = makeSignal({
      rawRelevance: 0.5,
      metadata: undefined,
    })

    const scored = scoreSignal(signal)

    // General: 0.10 + (0.5 * 0.25) = 0.225
    expect(scored.score).toBeCloseTo(0.225, 2)
  })

  test('empty metadata object gets general scoring', () => {
    const signal = makeSignal({
      rawRelevance: 0.5,
      metadata: {},
    })

    const scored = scoreSignal(signal)

    // General: 0.10 + (0.5 * 0.25) = 0.225
    expect(scored.score).toBeCloseTo(0.225, 2)
  })
})
