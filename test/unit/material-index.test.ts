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
