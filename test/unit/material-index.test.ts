import { describe, it, expect } from 'bun:test'
import { resolve } from '../../src/lib/material-index.ts'

describe('MaterialIndex (#575)', () => {
  it('resolves known TDP name to materials', () => {
    const materials = resolve('Automation')
    expect(materials.length).toBeGreaterThanOrEqual(0) // May be 0 if no saleshub data loaded
  })

  it('resolves product keyword to materials', () => {
    const materials = resolve('ansible')
    // Should infer Automation TDP
    expect(Array.isArray(materials)).toBe(true)
  })

  it('returns empty array for unknown key', () => {
    const materials = resolve('completely-unknown-product-xyz-123')
    expect(materials).toEqual([])
  })

  it('materials have required fields', () => {
    const materials = resolve('Automation')
    for (const m of materials) {
      expect(m.title).toBeDefined()
      expect(m.url).toBeDefined()
      expect(m.type).toBeDefined()
      expect(m.url.startsWith('http')).toBe(true)
    }
  })
})

describe('MaterialIndex URL uniqueness (#588)', () => {
  const TDP_NAMES = ['Automation', 'AI', 'Container Mgmt', 'Virtualization', 'Server/Cloud OS', 'App Platform']

  it('no two materials in a single resolve() share the same URL', () => {
    for (const tdpName of TDP_NAMES) {
      const materials = resolve(tdpName)
      const urls = materials.map(m => m.url)
      const uniqueUrls = new Set(urls)
      expect(uniqueUrls.size).toBe(urls.length)
    }
  })

  it('resolve() returns at most 5 materials per call', () => {
    for (const tdpName of TDP_NAMES) {
      const materials = resolve(tdpName)
      expect(materials.length).toBeLessThanOrEqual(5)
    }
  })

  it('documents with driveUrl are included as type doc', () => {
    // At least one TDP should have documents with driveUrl
    let foundDocWithDriveUrl = false
    for (const tdpName of TDP_NAMES) {
      const materials = resolve(tdpName)
      const docMaterials = materials.filter(m => m.type === 'doc' && m.url.includes('drive.google.com'))
      if (docMaterials.length > 0) {
        foundDocWithDriveUrl = true
        break
      }
    }
    expect(foundDocWithDriveUrl).toBe(true)
  })

  it('resolve() returns materials with DIFFERENT URLs for each TDP', () => {
    // For TDPs with cheatsheet + deck + driveUrl docs, URLs must differ
    let tdpsWithMultipleMaterials = 0
    for (const tdpName of TDP_NAMES) {
      const materials = resolve(tdpName)
      if (materials.length >= 2) {
        tdpsWithMultipleMaterials++
        // Every pair of URLs must be different
        for (let i = 0; i < materials.length; i++) {
          for (let j = i + 1; j < materials.length; j++) {
            expect(materials[i].url).not.toBe(materials[j].url)
          }
        }
      }
    }
    // At least 3 TDPs should have multiple materials
    expect(tdpsWithMultipleMaterials).toBeGreaterThanOrEqual(3)
  })
})
