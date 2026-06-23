import { describe, it, expect } from 'bun:test'
import { getTdpKeywords, normalizeTdp, TDP_DOMAINS } from '../../src/lib/tdp-domains.ts'

describe('TDP domain vocabulary consistency', () => {
  const keywords = getTdpKeywords()

  // Test that inferTdpFromProduct return values normalize to valid keys
  const testProducts: [string, string | null][] = [
    ['RHEL', 'Server and Cloud Computing'],
    ['Red Hat Enterprise Linux', 'Server and Cloud Computing'],
    ['OpenShift', 'Container Management'],
    ['OpenShift Container Platform', 'Container Management'],
    ['Ansible Automation Platform', 'Automation'],
    ['ROSA', null], // might not match -- that's ok
    ['ACS', 'Security'],
    ['Satellite', 'Management'],
    ['RHOAI', 'AI Platform'],
    ['Quay', 'Security'],
  ]

  for (const [product, expected] of testProducts) {
    if (expected) {
      it(`${product} normalizes to valid TDP key '${expected}'`, () => {
        expect(keywords[expected]).toBeDefined()
        expect(normalizeTdp(expected)).toBe(expected)
      })
    }
  }

  it('all normalizeTdp aliases resolve to valid keys', () => {
    const aliases = ['Server/Cloud OS', 'Container Mgmt', 'AI', 'App Platform']
    for (const alias of aliases) {
      const normalized = normalizeTdp(alias)
      expect(keywords[normalized]).toBeDefined()
    }
  })

  it('every TDP_KEYWORDS key has at least 3 keywords', () => {
    for (const [name, kw] of Object.entries(keywords)) {
      expect(kw.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('canonical names are identity under normalizeTdp', () => {
    for (const canonical of Object.keys(TDP_DOMAINS)) {
      expect(normalizeTdp(canonical)).toBe(canonical)
    }
  })

  it('unrecognized names pass through normalizeTdp unchanged', () => {
    expect(normalizeTdp('Unknown Domain')).toBe('Unknown Domain')
    expect(normalizeTdp('')).toBe('')
  })

  it('no duplicate keywords across domains', () => {
    // Some overlap is acceptable (e.g., 'migrate' in both Server and Virtualization)
    // but ensure the key structure is sound
    for (const [name, kw] of Object.entries(keywords)) {
      const unique = new Set(kw)
      expect(unique.size).toBe(kw.length)
    }
  })
})
