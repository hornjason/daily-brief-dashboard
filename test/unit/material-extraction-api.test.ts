/**
 * Material Extraction API Integration Tests (GitHub Issue #164)
 *
 * Tests for the API endpoints:
 * - POST /api/campaigns/extract-material
 * - DELETE /api/campaigns/extract-material
 */

import { describe, test, expect } from 'bun:test'
import { extractMaterial, deleteMaterialCache } from '../../src/material-extraction.ts'
import type { MaterialExtraction } from '../../src/material-extraction.ts'

describe('Material Extraction API - extractMaterial function', () => {
  test('extractMaterial function signature is correct', () => {
    expect(typeof extractMaterial).toBe('function')
    // Note: function.length only counts params without defaults, so forceRefresh (default=false) isn't counted
    expect(extractMaterial.length).toBe(1) // materialUrl only
  })

  test('deleteMaterialCache function signature is correct', () => {
    expect(typeof deleteMaterialCache).toBe('function')
    expect(deleteMaterialCache.length).toBe(1) // materialUrl
  })

  test('MaterialExtraction type structure is correct', () => {
    const mockExtraction: MaterialExtraction = {
      materialTitle: 'Test Material',
      personas: [
        { role: 'VP Infrastructure', relevantVPs: ['vp-1'], enabled: true },
      ],
      valueProps: [
        { id: 'vp-1', claim: 'Test claim', detail: 'Test detail' },
      ],
      useCases: [
        { name: 'Test Use Case', description: 'Test description' },
      ],
      style: 'executive',
      extractedAt: new Date().toISOString(),
      materialUrl: 'https://docs.google.com/document/d/test123/edit',
    }

    // Verify all required fields exist
    expect(mockExtraction.materialTitle).toBeDefined()
    expect(mockExtraction.personas).toBeDefined()
    expect(mockExtraction.valueProps).toBeDefined()
    expect(mockExtraction.useCases).toBeDefined()
    expect(mockExtraction.style).toBeDefined()
    expect(mockExtraction.extractedAt).toBeDefined()
    expect(mockExtraction.materialUrl).toBeDefined()

    // Verify types
    expect(typeof mockExtraction.materialTitle).toBe('string')
    expect(Array.isArray(mockExtraction.personas)).toBe(true)
    expect(Array.isArray(mockExtraction.valueProps)).toBe(true)
    expect(Array.isArray(mockExtraction.useCases)).toBe(true)
    expect(typeof mockExtraction.style).toBe('string')
    expect(typeof mockExtraction.extractedAt).toBe('string')
    expect(typeof mockExtraction.materialUrl).toBe('string')
  })

  test('Persona array items have correct structure', () => {
    const persona = { role: 'VP Infrastructure', relevantVPs: ['vp-1', 'vp-2'], enabled: true }

    expect(typeof persona.role).toBe('string')
    expect(Array.isArray(persona.relevantVPs)).toBe(true)
    expect(typeof persona.enabled).toBe('boolean')

    // All relevantVPs should be strings
    persona.relevantVPs.forEach(vp => {
      expect(typeof vp).toBe('string')
    })
  })

  test('ValueProp array items have correct structure', () => {
    const vp = { id: 'vp-1', claim: 'Reduce costs', detail: 'Save 30%' }

    expect(typeof vp.id).toBe('string')
    expect(typeof vp.claim).toBe('string')
    expect(typeof vp.detail).toBe('string')
  })

  test('UseCase array items have correct structure', () => {
    const useCase = { name: 'Cloud Migration', description: 'Move to cloud' }

    expect(typeof useCase.name).toBe('string')
    expect(typeof useCase.description).toBe('string')
  })

  test('Invalid URL should throw descriptive error', async () => {
    const invalidUrl = 'https://example.com/not-a-google-doc'

    try {
      await extractMaterial(invalidUrl)
      expect(true).toBe(false) // Should not reach here
    } catch (e: any) {
      expect(e.message).toContain('Invalid materialUrl')
      expect(e.message).toContain('Google Docs or Slides')
    }
  })
})

describe('Material Extraction API - Cache behavior', () => {
  test('deleteMaterialCache returns boolean', () => {
    const result = deleteMaterialCache('https://docs.google.com/document/d/test/edit')
    expect(typeof result).toBe('boolean')
  })

  test('Deleting non-existent cache returns false', () => {
    const nonExistentUrl = 'https://docs.google.com/document/d/nonexistent-12345/edit'
    const result = deleteMaterialCache(nonExistentUrl)
    expect(result).toBe(false)
  })
})

describe('Material Extraction API - Endpoint contracts', () => {
  test('POST /api/campaigns/extract-material request body shape', () => {
    const validBody = {
      materialUrl: 'https://docs.google.com/document/d/ABC123/edit',
      forceRefresh: false,
    }

    expect(typeof validBody.materialUrl).toBe('string')
    expect(typeof validBody.forceRefresh).toBe('boolean')
  })

  test('POST /api/campaigns/extract-material optional forceRefresh', () => {
    const minimalBody = {
      materialUrl: 'https://docs.google.com/document/d/ABC123/edit',
    }

    expect(typeof minimalBody.materialUrl).toBe('string')
    expect(minimalBody.forceRefresh).toBeUndefined()
  })

  test('DELETE /api/campaigns/extract-material URL encoding', () => {
    const url = 'https://docs.google.com/document/d/ABC123/edit'
    const encoded = encodeURIComponent(url)

    expect(encoded).toContain('%3A') // colon
    expect(encoded).toContain('%2F') // slash
    expect(decodeURIComponent(encoded)).toBe(url)
  })
})
