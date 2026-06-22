/**
 * Document Intelligence Validator — Unit Tests (ADR-041)
 */

import { describe, test, expect } from 'bun:test'
import { documentIntelligenceValidator } from '../../src/quality-validators/document-intelligence-validator.ts'

describe('documentIntelligenceValidator', () => {
  test('passes valid document with all required fields', () => {
    const valid = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'A comprehensive guide to integrating ServiceNow with Ansible Automation Platform for ITSM workflows.',
      productsReferenced: [{ name: 'Ansible Automation Platform' }],
      integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
      useCases: ['ITSM automation'],
      competitorsReferenced: null,
      partnerSolutions: null,
      audience: 'customer',
      keyPoints: ['Automate incident response', 'Reduce MTTR by 60%'],
      links: [{ name: 'Content Kit', url: 'https://saleshub.redhat.com/kit' }],
    })

    const result = documentIntelligenceValidator.validate(valid)
    expect(result.score).toBeGreaterThanOrEqual(65)
    expect(result.checks.filter(c => !c.passed && c.severity === 'required')).toHaveLength(0)
  })

  test('fails when productsReferenced is empty', () => {
    const noProducts = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'A guide to something without products mentioned.',
      productsReferenced: [],
      integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
      audience: 'internal',
      keyPoints: ['Point 1'],
      links: [{ name: 'Link', url: 'https://example.com' }],
    })

    const result = documentIntelligenceValidator.validate(noProducts)
    const productCheck = result.checks.find(c => c.name === 'has-products')
    expect(productCheck?.passed).toBe(false)
  })

  test('fails when no classification fields populated', () => {
    const noClassification = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'A guide with products but no integrations or use cases.',
      productsReferenced: [{ name: 'OpenShift' }],
      integrationsReferenced: null,
      useCases: null,
      competitorsReferenced: null,
      partnerSolutions: null,
      audience: 'internal',
      keyPoints: ['Point 1'],
      links: [{ name: 'Link', url: 'https://example.com' }],
    })

    const result = documentIntelligenceValidator.validate(noClassification)
    const classCheck = result.checks.find(c => c.name === 'has-classification')
    expect(classCheck?.passed).toBe(false)
  })

  test('fails with invalid document category', () => {
    const badCategory = JSON.stringify({
      documentCategory: 'invalid-category',
      summary: 'A sufficiently long summary for validation here.',
      productsReferenced: [{ name: 'RHEL' }],
      useCases: ['Infrastructure management'],
      audience: 'customer',
      keyPoints: ['Point 1'],
      links: [],
    })

    const result = documentIntelligenceValidator.validate(badCategory)
    const catCheck = result.checks.find(c => c.name === 'valid-category')
    expect(catCheck?.passed).toBe(false)
  })

  test('fails with invalid audience', () => {
    const badAudience = JSON.stringify({
      documentCategory: 'battlecard',
      summary: 'A sufficiently long summary for validation here.',
      productsReferenced: [{ name: 'OpenShift' }],
      competitorsReferenced: [{ name: 'VMware', context: 'displacement' }],
      audience: 'executives',
      keyPoints: ['Point 1'],
      links: [],
    })

    const result = documentIntelligenceValidator.validate(badAudience)
    const audCheck = result.checks.find(c => c.name === 'valid-audience')
    expect(audCheck?.passed).toBe(false)
  })

  test('fails with invalid JSON', () => {
    const result = documentIntelligenceValidator.validate('not json at all')
    expect(result.score).toBe(0)
    const jsonCheck = result.checks.find(c => c.name === 'valid-json')
    expect(jsonCheck?.passed).toBe(false)
  })

  test('links check is recommended not required', () => {
    const noLinks = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'A comprehensive guide to something important enough.',
      productsReferenced: [{ name: 'Ansible' }],
      integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
      audience: 'customer',
      keyPoints: ['Point 1'],
      links: [],
    })

    const result = documentIntelligenceValidator.validate(noLinks)
    const linksCheck = result.checks.find(c => c.name === 'has-links')
    expect(linksCheck?.severity).toBe('recommended')
  })

  test('pass threshold is 65', () => {
    expect(documentIntelligenceValidator.passThreshold).toBe(65)
  })
})
