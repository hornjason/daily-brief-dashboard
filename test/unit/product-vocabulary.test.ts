/**
 * Product Vocabulary Resolver — Unit Tests
 * GitHub Issue #676
 *
 * Tests resolution between product slugs, display names, short names,
 * subscription patterns, and case product patterns.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  resolveToSlug,
  resolveToDisplayName,
  resolveToShortName,
  getAliases,
  getAllSlugs,
  getAllProductNames,
  resetCache,
} from '../../src/lib/product-vocabulary.ts'

describe('product-vocabulary', () => {
  beforeEach(() => {
    resetCache()
  })

  describe('resolveToSlug()', () => {
    it('resolves slug identity', () => {
      expect(resolveToSlug('aap')).toBe('aap')
      expect(resolveToSlug('rhel')).toBe('rhel')
      expect(resolveToSlug('ocp')).toBe('ocp')
    })

    it('resolves displayName to slug (case-insensitive)', () => {
      expect(resolveToSlug('Red Hat Ansible Automation Platform')).toBe('aap')
      expect(resolveToSlug('red hat ansible automation platform')).toBe('aap')
      expect(resolveToSlug('Red Hat Enterprise Linux')).toBe('rhel')
      expect(resolveToSlug('Red Hat OpenShift Container Platform')).toBe('ocp')
    })

    it('resolves shortName to slug (case-insensitive)', () => {
      expect(resolveToSlug('AAP')).toBe('aap')
      expect(resolveToSlug('aap')).toBe('aap')
      expect(resolveToSlug('RHEL')).toBe('rhel')
      expect(resolveToSlug('rhel')).toBe('rhel')
      expect(resolveToSlug('OpenShift')).toBe('ocp')
    })

    it('resolves subscriptionPatterns to slug (case-insensitive)', () => {
      expect(resolveToSlug('Ansible')).toBe('aap')
      expect(resolveToSlug('RHAAP')).toBe('aap')
      expect(resolveToSlug('ansible')).toBe('aap')
      expect(resolveToSlug('OCP')).toBe('ocp')
      expect(resolveToSlug('RHOCP')).toBe('ocp')
    })

    it('resolves caseProductPatterns to slug (case-insensitive)', () => {
      expect(resolveToSlug('Red Hat Ansible')).toBe('aap')
      expect(resolveToSlug('red hat ansible')).toBe('aap')
      expect(resolveToSlug('Red Hat OpenShift')).toBe('ocp')
    })

    it('returns null for unknown products', () => {
      expect(resolveToSlug('Cisco')).toBeNull()
      expect(resolveToSlug('VMware')).toBeNull()
      expect(resolveToSlug('')).toBeNull()
      expect(resolveToSlug('nonexistent')).toBeNull()
    })

    it('case insensitive for slug identity', () => {
      expect(resolveToSlug('RHEL')).toBe('rhel')
      expect(resolveToSlug('Rhel')).toBe('rhel')
    })
  })

  describe('resolveToDisplayName()', () => {
    it('resolves slug to display name', () => {
      expect(resolveToDisplayName('ocp')).toBe('Red Hat OpenShift Container Platform')
      expect(resolveToDisplayName('aap')).toBe('Red Hat Ansible Automation Platform')
      expect(resolveToDisplayName('rhel')).toBe('Red Hat Enterprise Linux')
    })

    it('returns null for unknown slug', () => {
      expect(resolveToDisplayName('unknown')).toBeNull()
    })
  })

  describe('resolveToShortName()', () => {
    it('resolves slug to short name', () => {
      expect(resolveToShortName('aap')).toBe('AAP')
      expect(resolveToShortName('rhel')).toBe('RHEL')
      expect(resolveToShortName('ocp')).toBe('OpenShift')
    })

    it('returns null for unknown slug', () => {
      expect(resolveToShortName('unknown')).toBeNull()
    })
  })

  describe('getAliases()', () => {
    it('returns all aliases for a product', () => {
      const aliases = getAliases('aap')
      expect(aliases).toContain('aap')
      expect(aliases).toContain('Red Hat Ansible Automation Platform')
      expect(aliases).toContain('AAP')
      expect(aliases).toContain('Ansible')
      expect(aliases).toContain('RHAAP')
      expect(aliases).toContain('Red Hat Ansible')
    })

    it('returns empty array for unknown slug', () => {
      expect(getAliases('unknown')).toEqual([])
    })

    it('deduplicates aliases', () => {
      const aliases = getAliases('rhel')
      const uniqueCheck = new Set(aliases)
      expect(aliases.length).toBe(uniqueCheck.size)
    })
  })

  describe('getAllSlugs()', () => {
    it('returns all product slugs', () => {
      const slugs = getAllSlugs()
      expect(slugs).toContain('rhel')
      expect(slugs).toContain('ocp')
      expect(slugs).toContain('aap')
      expect(slugs).toContain('ocp-virt')
      expect(slugs.length).toBeGreaterThanOrEqual(7)
    })
  })

  describe('getAllProductNames()', () => {
    it('returns all display names', () => {
      const names = getAllProductNames()
      expect(names).toContain('Red Hat Enterprise Linux')
      expect(names).toContain('Red Hat OpenShift Container Platform')
      expect(names).toContain('Red Hat Ansible Automation Platform')
      expect(names.length).toBeGreaterThanOrEqual(7)
    })
  })
})
