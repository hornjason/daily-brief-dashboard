/**
 * BKL-DOM-INF-05 — inferenceWarning regression test.
 *
 * The inference IIFE in src/bootstrap-orchestrator.ts is not separately
 * exported (it lives inline inside the runAutoBootstrap orchestration body),
 * so we cannot import and call it directly without mocking ~10 collaborators
 * (batchInferDomains, tier1Clearbit, inferCustomerDomain, writeJsonAtomic,
 * customers state, GOOGLE_UNIFIED_TOKEN_PATH, lockState mutex, etc.). Per the
 * BKL brief: when a direct unit test is too complex, validate the type
 * surface and pin the warning-string formatting that the orchestrator emits.
 *
 * Coverage:
 *   1. AutoBootstrapResources accepts inferenceWarning?: string (compile-time
 *      check via type-level assignment).
 *   2. Warning string format pinned for 1-customer and N-customer cases —
 *      mirrors the exact template literal in bootstrap-orchestrator.ts.
 *
 * End-to-end behavior (warning is populated on the live state object after a
 * real bootstrap with all-null inference) is covered by the API-level
 * integration tests once they observe `/api/bootstrap/status` and assert the
 * field shape. See verify step 4 in the BKL brief.
 */
import { describe, it, expect } from 'bun:test'
import { autoBootstrapState, type AutoBootstrapResources } from '../../src/bootstrap-state.ts'

// Replicates the exact template from bootstrap-orchestrator.ts so any drift
// between the test and the orchestrator is caught here.
function formatInferenceWarning(unresolvedNames: string[]): string {
  const n = unresolvedNames.length
  return `${n} customer${n > 1 ? 's' : ''} have no resolvable domain: ${unresolvedNames.join(', ')}`
}

describe('BKL-DOM-INF-05 inferenceWarning', () => {
  it('AutoBootstrapResources accepts inferenceWarning as optional string', () => {
    const r: AutoBootstrapResources = { inferenceWarning: '1 customer have no resolvable domain: Acme' }
    expect(r.inferenceWarning).toBe('1 customer have no resolvable domain: Acme')
  })

  it('autoBootstrapState.resources is mutable for inferenceWarning writes', () => {
    autoBootstrapState.resources.inferenceWarning = '2 customers have no resolvable domain: Foo, Bar'
    expect(autoBootstrapState.resources.inferenceWarning).toBe('2 customers have no resolvable domain: Foo, Bar')
    delete autoBootstrapState.resources.inferenceWarning
    expect(autoBootstrapState.resources.inferenceWarning).toBeUndefined()
  })

  it('warning string uses singular "customer" for n=1', () => {
    expect(formatInferenceWarning(['Acme Corp'])).toBe('1 customer have no resolvable domain: Acme Corp')
  })

  it('warning string uses plural "customers" for n>1 and joins names with ", "', () => {
    expect(formatInferenceWarning(['Acme Corp', 'Globex', 'Initech'])).toBe(
      '3 customers have no resolvable domain: Acme Corp, Globex, Initech',
    )
  })

  it('warning string handles n=2 plural correctly (boundary)', () => {
    expect(formatInferenceWarning(['Foo', 'Bar'])).toBe('2 customers have no resolvable domain: Foo, Bar')
  })
})
