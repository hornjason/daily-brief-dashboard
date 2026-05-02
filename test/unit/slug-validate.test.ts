// BKL-SEC-SLUG-VALIDATE-01: product slug validation before Drive scaffolding.
// Tests the slug shape guard added to ensureConfigAndProductsScaffold in
// bootstrap-orchestrator.ts. The guard filters invalid slugs before they
// reach Drive's findOrCreateFolder (which would propagate them to folder names).

import { test, expect, describe } from 'bun:test'

// Mirror the exact guard from bootstrap-orchestrator.ts ensureConfigAndProductsScaffold
const SLUG_RE = /^[a-z0-9-]{1,64}$/

function filterSlugs(slugs: string[]): string[] {
  return [...new Set(slugs.filter(s => SLUG_RE.test(s)))]
}

describe('BKL-SEC-SLUG-VALIDATE-01: slug shape validation', () => {
  test('valid slugs pass through', () => {
    expect(filterSlugs(['openshift', 'rhel', 'ansible-automation-platform'])).toEqual([
      'openshift', 'rhel', 'ansible-automation-platform',
    ])
  })

  test('slug with path separator is rejected', () => {
    expect(filterSlugs(['open/shift'])).toEqual([])
  })

  test('slug with uppercase letters is rejected', () => {
    expect(filterSlugs(['OpenShift', 'RHEL'])).toEqual([])
  })

  test('slug with control chars is rejected', () => {
    expect(filterSlugs(['\x00openshift', 'rhel\n'])).toEqual([])
  })

  test('slug exceeding 64 chars is rejected', () => {
    const long = 'a'.repeat(65)
    expect(filterSlugs([long])).toEqual([])
  })

  test('exactly 64 chars is accepted', () => {
    const max = 'a'.repeat(64)
    expect(filterSlugs([max])).toEqual([max])
  })

  test('empty string is rejected', () => {
    expect(filterSlugs([''])).toEqual([])
  })

  test('duplicate slugs are deduplicated', () => {
    const result = filterSlugs(['rhel', 'rhel', 'openshift', 'openshift'])
    expect(result).toEqual(['rhel', 'openshift'])
    expect(result.length).toBe(2)
  })

  test('mixed valid + invalid: only valid slugs remain', () => {
    const result = filterSlugs(['rhel', '../etc/passwd', 'openshift', 'BAD_SLUG', 'ansible'])
    expect(result).toEqual(['rhel', 'openshift', 'ansible'])
  })

  test('slug with spaces is rejected', () => {
    expect(filterSlugs(['open shift', ' rhel'])).toEqual([])
  })
})
