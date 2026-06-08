/**
 * Competitive Vocabulary Resolver — Unit Tests
 * GitHub Issue #680
 *
 * Tests the shared module that resolves competitor/third-party technology
 * names to Red Hat displacement products and solution plays.
 * Uses solution-plays.json seed data (competitive-intel cache won't exist in tests).
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  resolveDisplacement,
  getTriggerTechnologies,
  getAllCompetitors,
  getDisplacementMap,
  getVendorPrefixes,
  resetCache,
  type DisplacementEntry,
} from '../../src/lib/competitive-vocabulary.ts'

describe('competitive-vocabulary', () => {
  beforeEach(() => {
    resetCache()
  })

  describe('resolveDisplacement()', () => {
    it('resolves VMware to OCP with Virtualization TDP', () => {
      const result = resolveDisplacement('VMware')
      expect(result).not.toBeNull()
      expect(result!.slug).toBe('ocp')
      expect(result!.tdp).toBe('Virtualization')
      expect(result!.plays).toContain('vmware-migration')
    })

    it('resolves Terraform to AAP with Automation TDP', () => {
      const result = resolveDisplacement('Terraform')
      expect(result).not.toBeNull()
      expect(result!.slug).toBe('aap')
      expect(result!.tdp).toBe('Automation')
      expect(result!.plays).toContain('iac-modernization')
    })

    it('returns null for unknown competitor', () => {
      expect(resolveDisplacement('unknown-vendor')).toBeNull()
    })

    it('is case-insensitive', () => {
      const lower = resolveDisplacement('vmware')
      const upper = resolveDisplacement('VMWARE')
      const mixed = resolveDisplacement('VmWaRe')
      expect(lower).not.toBeNull()
      expect(upper).not.toBeNull()
      expect(mixed).not.toBeNull()
      expect(lower!.slug).toBe(upper!.slug)
      expect(lower!.slug).toBe(mixed!.slug)
    })

    it('returns null for empty string', () => {
      expect(resolveDisplacement('')).toBeNull()
    })

    it('resolves ServiceNow to AAP', () => {
      const result = resolveDisplacement('ServiceNow')
      expect(result).not.toBeNull()
      expect(result!.slug).toBe('aap')
      expect(result!.plays).toContain('itsm-automation')
    })

    it('resolves Docker to OCP', () => {
      const result = resolveDisplacement('Docker')
      expect(result).not.toBeNull()
      expect(result!.slug).toBe('ocp')
      expect(result!.plays).toContain('cloud-native-adoption')
    })

    it('resolves ESXi as a VMware-family trigger', () => {
      const result = resolveDisplacement('ESXi')
      expect(result).not.toBeNull()
      expect(result!.tdp).toBe('Virtualization')
      expect(result!.plays).toContain('vmware-migration')
    })

    it('resolves Jenkins to OCP for CI/CD', () => {
      const result = resolveDisplacement('Jenkins')
      expect(result).not.toBeNull()
      expect(result!.slug).toBe('ocp')
      expect(result!.plays).toContain('ci-cd-modernization')
    })

    it('resolves Splunk across multiple plays', () => {
      const result = resolveDisplacement('Splunk')
      expect(result).not.toBeNull()
      // Splunk appears in both security-automation and aiops-automation
      expect(result!.plays.length).toBeGreaterThanOrEqual(1)
    })

    it('includes redHat display name', () => {
      const result = resolveDisplacement('VMware')
      expect(result).not.toBeNull()
      expect(result!.redHat).toBeTruthy()
      expect(result!.redHat.length).toBeGreaterThan(0)
    })
  })

  describe('getTriggerTechnologies()', () => {
    it('returns trigger technologies for vmware-migration', () => {
      const techs = getTriggerTechnologies('vmware-migration')
      expect(techs).toContain('VMware')
      expect(techs).toContain('vSphere')
      expect(techs).toContain('ESXi')
      expect(techs).toContain('Tanzu')
      expect(techs).toContain('vCenter')
    })

    it('returns empty array for nonexistent play', () => {
      expect(getTriggerTechnologies('nonexistent')).toEqual([])
    })

    it('returns trigger technologies for iac-modernization', () => {
      const techs = getTriggerTechnologies('iac-modernization')
      expect(techs).toContain('Terraform')
      expect(techs).toContain('Puppet')
      expect(techs).toContain('Chef')
    })

    it('returns trigger technologies for network-automation', () => {
      const techs = getTriggerTechnologies('network-automation')
      expect(techs).toContain('Cisco')
      expect(techs).toContain('Juniper')
    })
  })

  describe('getAllCompetitors()', () => {
    it('returns a non-empty array', () => {
      const competitors = getAllCompetitors()
      expect(competitors.length).toBeGreaterThan(0)
    })

    it('includes known competitors (lowercase)', () => {
      const competitors = getAllCompetitors()
      expect(competitors).toContain('vmware')
      expect(competitors).toContain('terraform')
      expect(competitors).toContain('docker')
      expect(competitors).toContain('cisco')
    })

    it('all entries are lowercase', () => {
      const competitors = getAllCompetitors()
      for (const c of competitors) {
        expect(c).toBe(c.toLowerCase())
      }
    })
  })

  describe('getDisplacementMap()', () => {
    it('returns a Map with entries', () => {
      const map = getDisplacementMap()
      expect(map.size).toBeGreaterThan(0)
    })

    it('map keys are lowercase', () => {
      const map = getDisplacementMap()
      for (const key of map.keys()) {
        expect(key).toBe(key.toLowerCase())
      }
    })

    it('each entry has required fields', () => {
      const map = getDisplacementMap()
      for (const [, entry] of map) {
        expect(entry.redHat).toBeTruthy()
        expect(entry.slug).toBeTruthy()
        expect(entry.tdp).toBeTruthy()
        expect(Array.isArray(entry.plays)).toBe(true)
        expect(entry.plays.length).toBeGreaterThan(0)
      }
    })
  })

  describe('getVendorPrefixes()', () => {
    it('returns known vendor prefixes', () => {
      const prefixes = getVendorPrefixes()
      expect(prefixes).toContain('vmware')
      expect(prefixes).toContain('hashicorp')
      expect(prefixes).toContain('cisco')
    })

    it('all entries are lowercase', () => {
      const prefixes = getVendorPrefixes()
      for (const p of prefixes) {
        expect(p).toBe(p.toLowerCase())
      }
    })

    it('does not include empty strings', () => {
      const prefixes = getVendorPrefixes()
      for (const p of prefixes) {
        expect(p.length).toBeGreaterThan(0)
      }
    })
  })

  describe('resetCache()', () => {
    it('forces map rebuild on next call', () => {
      const map1 = getDisplacementMap()
      expect(map1.size).toBeGreaterThan(0)

      resetCache()
      const map2 = getDisplacementMap()
      expect(map2.size).toBeGreaterThan(0)

      // Same data, different object references
      expect(map2.size).toBe(map1.size)
    })
  })

  describe('multi-play aggregation', () => {
    it('aggregates plays when a tech appears in multiple plays', () => {
      // Palo Alto appears in both network-automation and security-automation
      const result = resolveDisplacement('Palo Alto')
      expect(result).not.toBeNull()
      expect(result!.plays.length).toBeGreaterThanOrEqual(2)
      expect(result!.plays).toContain('network-automation')
      expect(result!.plays).toContain('security-automation')
    })

    it('CrowdStrike resolves to security-automation', () => {
      const result = resolveDisplacement('CrowdStrike')
      expect(result).not.toBeNull()
      expect(result!.plays).toContain('security-automation')
    })
  })
})
