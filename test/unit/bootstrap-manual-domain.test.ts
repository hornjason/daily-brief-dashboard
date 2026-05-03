// BKL-DOM-INF-13: customers whose name produces no domain across every
// inference tier should be flagged needsManualDomain so the UI can render a
// "Domain needed" badge. Conversely, once a domain resolves, the flag must be
// cleared.
//
// These are pure data-shape tests against the same logic the inference IIFE
// runs in src/bootstrap-orchestrator.ts. Live network paths are covered by
// existing infer-domains specs.

import { test, expect, describe } from 'bun:test'
import type { Customer } from '../../src/types.ts'

// Local copy of the lock-block logic — kept in sync with the orchestrator.
// If this drifts, the orchestrator's behavior is what matters; this test
// merely guards the contract that:
//   - resolved customers get domain set + needsManualDomain cleared
//   - unresolved customers get needsManualDomain=true
//   - inactive / wrong-AE customers are never touched
function applyInferenceWrites(
  customers: Customer[],
  aeName: string,
  highConfidenceSaves: { name: string; domain: string; ae: string }[],
  unresolvedNames: Set<string>,
): Customer[] {
  for (const { name, domain, ae } of highConfidenceSaves) {
    const cu = customers.find(cx => cx.name === name && cx.ae === ae && !cx.inactive)
    if (cu && !cu.domain) cu.domain = domain
    if (cu && cu.needsManualDomain) cu.needsManualDomain = false
  }
  for (const name of unresolvedNames) {
    const cu = customers.find(cx => cx.name === name && cx.ae === aeName && !cx.inactive)
    if (cu && !cu.domain && !cu.needsManualDomain) cu.needsManualDomain = true
  }
  return customers
}

describe('BKL-DOM-INF-13: needsManualDomain flag', () => {
  test('unresolvable customer gets needsManualDomain=true', () => {
    const customers: Customer[] = [
      { name: 'Mystery Holdings', accountNumbers: [], ae: 'Carolanne' } as Customer,
    ]
    const result = applyInferenceWrites(customers, 'Carolanne', [], new Set(['Mystery Holdings']))
    expect(result[0].needsManualDomain).toBe(true)
    expect(result[0].domain).toBeUndefined()
  })

  test('resolved customer does not get needsManualDomain set', () => {
    const customers: Customer[] = [
      { name: 'REI', accountNumbers: [], ae: 'Carolanne' } as Customer,
    ]
    const result = applyInferenceWrites(
      customers,
      'Carolanne',
      [{ name: 'REI', domain: 'rei.com', ae: 'Carolanne' }],
      new Set(),
    )
    expect(result[0].domain).toBe('rei.com')
    expect(result[0].needsManualDomain).toBeFalsy()
  })

  test('customer that was previously flagged gets cleared once domain resolves', () => {
    const customers: Customer[] = [
      { name: 'REI', accountNumbers: [], ae: 'Carolanne', needsManualDomain: true } as Customer,
    ]
    const result = applyInferenceWrites(
      customers,
      'Carolanne',
      [{ name: 'REI', domain: 'rei.com', ae: 'Carolanne' }],
      new Set(),
    )
    expect(result[0].needsManualDomain).toBe(false)
    expect(result[0].domain).toBe('rei.com')
  })

  test('does not flag customers under a different AE', () => {
    const customers: Customer[] = [
      { name: 'Acme', accountNumbers: [], ae: 'Carolanne' } as Customer,
      { name: 'Acme', accountNumbers: [], ae: 'Marcus' } as Customer,
    ]
    const result = applyInferenceWrites(customers, 'Carolanne', [], new Set(['Acme']))
    expect(result[0].needsManualDomain).toBe(true)
    expect(result[1].needsManualDomain).toBeUndefined()
  })

  test('does not flag inactive customers', () => {
    const customers: Customer[] = [
      { name: 'Old Co', accountNumbers: [], ae: 'Carolanne', inactive: true } as Customer,
    ]
    const result = applyInferenceWrites(customers, 'Carolanne', [], new Set(['Old Co']))
    expect(result[0].needsManualDomain).toBeUndefined()
  })

  test('mixed batch: some resolved, some flagged', () => {
    const customers: Customer[] = [
      { name: 'REI', accountNumbers: [], ae: 'Carolanne' } as Customer,
      { name: 'Mystery Holdings', accountNumbers: [], ae: 'Carolanne' } as Customer,
      { name: 'Big Ten Network Services', accountNumbers: [], ae: 'Carolanne' } as Customer,
    ]
    const result = applyInferenceWrites(
      customers,
      'Carolanne',
      [
        { name: 'REI', domain: 'rei.com', ae: 'Carolanne' },
        { name: 'Big Ten Network Services', domain: 'bigten.org', ae: 'Carolanne' },
      ],
      new Set(['Mystery Holdings']),
    )
    expect(result[0].domain).toBe('rei.com')
    expect(result[0].needsManualDomain).toBeFalsy()
    expect(result[1].needsManualDomain).toBe(true)
    expect(result[1].domain).toBeUndefined()
    expect(result[2].domain).toBe('bigten.org')
    expect(result[2].needsManualDomain).toBeFalsy()
  })

  test('does not overwrite an existing domain', () => {
    const customers: Customer[] = [
      { name: 'REI', accountNumbers: [], ae: 'Carolanne', domain: 'rei.com' } as Customer,
    ]
    const result = applyInferenceWrites(
      customers,
      'Carolanne',
      [{ name: 'REI', domain: 'wrong.com', ae: 'Carolanne' }],
      new Set(),
    )
    expect(result[0].domain).toBe('rei.com')
  })
})
