/**
 * Product Slug Normalization — Regression Tests
 * GitHub Issue #869
 *
 * Verifies that resolveToSlug (product-vocabulary.ts) handles the product
 * name variants that callers actually pass in, after the deletion of the
 * duplicate PRODUCT_SLUG_MAP + normalizeProductSlug from
 * customer-product-context.ts.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { resolveToSlug, resetCache } from '../../src/lib/product-vocabulary.ts'

describe('#869 — product-slug normalization via resolveToSlug', () => {
  beforeEach(() => {
    resetCache()
  })

  describe('former PRODUCT_SLUG_MAP entries that resolve via vocabulary', () => {
    const resolvedCases: [string, string][] = [
      ['openshift', 'ocp'],
      ['openshift ai', 'rhoai'],
      ['rhel', 'rhel'],
      ['ansible', 'aap'],
      ['quay', 'quay'],
      ['developer hub', 'rhdh'],
      ['satellite', 'satellite'],
    ]

    for (const [input, expected] of resolvedCases) {
      it(`"${input}" → ${expected}`, () => {
        expect(resolveToSlug(input)).toBe(expected)
      })
    }
  })

  describe('entries not in vocabulary (callers handle null as no-match)', () => {
    const nullCases = [
      'openshift container platform',
      'enterprise linux',
      'ansible automation platform',
      'advanced cluster security',
      'advanced cluster management',
      'insights',
    ]

    for (const input of nullCases) {
      it(`"${input}" → null (not in vocabulary, callers skip)`, () => {
        expect(resolveToSlug(input)).toBeNull()
      })
    }
  })

  describe('case-insensitive matching', () => {
    it('handles uppercase inputs', () => {
      expect(resolveToSlug('RHEL')).toBe('rhel')
      expect(resolveToSlug('ANSIBLE')).toBe('aap')
      expect(resolveToSlug('QUAY')).toBe('quay')
      expect(resolveToSlug('SATELLITE')).toBe('satellite')
    })

    it('handles mixed case inputs', () => {
      expect(resolveToSlug('OpenShift')).toBe('ocp')
      expect(resolveToSlug('Ansible')).toBe('aap')
      expect(resolveToSlug('Developer Hub')).toBe('rhdh')
    })
  })

  describe('full display name resolution', () => {
    it('resolves full Red Hat product names', () => {
      expect(resolveToSlug('Red Hat OpenShift Container Platform')).toBe('ocp')
      expect(resolveToSlug('Red Hat Enterprise Linux')).toBe('rhel')
      expect(resolveToSlug('Red Hat Ansible Automation Platform')).toBe('aap')
      expect(resolveToSlug('Red Hat OpenShift AI')).toBe('rhoai')
      expect(resolveToSlug('Red Hat Quay')).toBe('quay')
      expect(resolveToSlug('Red Hat Developer Hub')).toBe('rhdh')
      expect(resolveToSlug('Red Hat Satellite')).toBe('satellite')
    })
  })

  describe('subscription pattern resolution', () => {
    it('resolves subscription-style inputs', () => {
      expect(resolveToSlug('OCP')).toBe('ocp')
      expect(resolveToSlug('RHOCP')).toBe('ocp')
      expect(resolveToSlug('AAP')).toBe('aap')
      expect(resolveToSlug('RHAAP')).toBe('aap')
      expect(resolveToSlug('RHOAI')).toBe('rhoai')
      expect(resolveToSlug('RHACM')).toBe('rhacm')
      expect(resolveToSlug('RHACS')).toBe('rhacs')
      expect(resolveToSlug('RHDH')).toBe('rhdh')
    })
  })

  describe('case product patterns', () => {
    it('resolves case product pattern inputs', () => {
      expect(resolveToSlug('Advanced Cluster Security for Kubernetes')).toBe('rhacs')
      expect(resolveToSlug('Advanced Cluster Management for Kubernetes')).toBe('rhacm')
      expect(resolveToSlug('Red Hat Ansible')).toBe('aap')
      expect(resolveToSlug('Red Hat OpenShift')).toBe('ocp')
    })
  })

  describe('returns null for unknown inputs', () => {
    it('returns null for unrecognized names', () => {
      expect(resolveToSlug('VMware vSphere')).toBeNull()
      expect(resolveToSlug('Kubernetes')).toBeNull()
      expect(resolveToSlug('')).toBeNull()
      expect(resolveToSlug('random-string')).toBeNull()
    })
  })
})
