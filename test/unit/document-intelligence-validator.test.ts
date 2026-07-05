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

  test('pass threshold is 85', () => {
    expect(documentIntelligenceValidator.passThreshold).toBe(85)
  })

  // ── Issue #963: Generic opener quality gate ──────────────────────────────

  test('opener-not-generic fails for "Are you looking to..." pattern', () => {
    const doc = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'A comprehensive guide to automating network configurations with Ansible.',
      productsReferenced: [{ name: 'Ansible Automation Platform' }],
      integrationsReferenced: [{ technology: 'Cisco ACI', category: 'Networking' }],
      audience: 'customer',
      keyPoints: ['Automate network config'],
      links: [{ name: 'Kit', url: 'https://example.com' }],
      conversationOpener: 'Are you looking to streamline your automation workflows?',
    })
    const result = documentIntelligenceValidator.validate(doc)
    const openerCheck = result.checks.find(c => c.name === 'opener-not-generic')
    expect(openerCheck).toBeDefined()
    expect(openerCheck?.passed).toBe(false)
    expect(openerCheck?.severity).toBe('recommended')
  })

  test('opener-not-generic fails for "Is your team..." pattern', () => {
    const doc = JSON.stringify({
      documentCategory: 'solution-brief',
      summary: 'A comprehensive guide to container platform management across hybrid cloud.',
      productsReferenced: [{ name: 'OpenShift' }],
      useCases: ['Container management'],
      audience: 'customer',
      keyPoints: ['Unified control plane'],
      links: [{ name: 'Brief', url: 'https://example.com' }],
      conversationOpener: 'Is your team struggling with container sprawl across multiple clouds?',
    })
    const result = documentIntelligenceValidator.validate(doc)
    const openerCheck = result.checks.find(c => c.name === 'opener-not-generic')
    expect(openerCheck?.passed).toBe(false)
  })

  test('opener-not-generic fails for all banned prefixes', () => {
    const banned = [
      'Have you considered migrating to a unified platform?',
      'Do you currently manage your infrastructure manually?',
      'Would you like to reduce your operational costs?',
      'Could you benefit from automated security scanning?',
      'Can you imagine a world without manual deployments?',
    ]
    for (const opener of banned) {
      const doc = JSON.stringify({
        documentCategory: 'content-kit',
        summary: 'A comprehensive guide to Red Hat product capabilities.',
        productsReferenced: [{ name: 'RHEL' }],
        useCases: ['Infrastructure'],
        audience: 'customer',
        keyPoints: ['Point'],
        links: [{ name: 'Link', url: 'https://example.com' }],
        conversationOpener: opener,
      })
      const result = documentIntelligenceValidator.validate(doc)
      const check = result.checks.find(c => c.name === 'opener-not-generic')
      expect(check?.passed).toBe(false)
    }
  })

  test('opener-not-generic passes for observation-based opener', () => {
    const doc = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'A comprehensive guide to automating network configurations with Ansible.',
      productsReferenced: [{ name: 'Ansible Automation Platform' }],
      integrationsReferenced: [{ technology: 'Cisco ACI', category: 'Networking' }],
      audience: 'customer',
      keyPoints: ['Automate network config'],
      links: [{ name: 'Kit', url: 'https://example.com' }],
      conversationOpener: 'I noticed this joint Ansible-Cisco playbook collection automates 80% of common switch configurations.',
    })
    const result = documentIntelligenceValidator.validate(doc)
    const openerCheck = result.checks.find(c => c.name === 'opener-not-generic')
    expect(openerCheck).toBeDefined()
    expect(openerCheck?.passed).toBe(true)
  })

  test('opener-not-null fails for null opener on customer-facing docs', () => {
    const doc = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'A comprehensive guide to container security with ACS.',
      productsReferenced: [{ name: 'Advanced Cluster Security' }],
      useCases: ['Container security'],
      audience: 'customer',
      keyPoints: ['Shift-left security'],
      links: [{ name: 'Kit', url: 'https://example.com' }],
      conversationOpener: null,
    })
    const result = documentIntelligenceValidator.validate(doc)
    const nullCheck = result.checks.find(c => c.name === 'opener-not-null')
    expect(nullCheck).toBeDefined()
    expect(nullCheck?.passed).toBe(false)
    expect(nullCheck?.severity).toBe('recommended')
  })

  test('opener-not-null fails for null opener on mixed-audience docs', () => {
    const doc = JSON.stringify({
      documentCategory: 'solution-brief',
      summary: 'A comprehensive guide for partners and customers on RHEL deployment.',
      productsReferenced: [{ name: 'RHEL' }],
      useCases: ['OS deployment'],
      audience: 'mixed',
      keyPoints: ['Stable platform'],
      links: [{ name: 'Brief', url: 'https://example.com' }],
      conversationOpener: null,
    })
    const result = documentIntelligenceValidator.validate(doc)
    const nullCheck = result.checks.find(c => c.name === 'opener-not-null')
    expect(nullCheck?.passed).toBe(false)
  })

  test('opener-not-null passes for null opener on internal docs', () => {
    const doc = JSON.stringify({
      documentCategory: 'content-kit',
      summary: 'Internal training material for sales team enablement.',
      productsReferenced: [{ name: 'Ansible' }],
      useCases: ['Enablement'],
      audience: 'internal',
      keyPoints: ['Training'],
      links: [{ name: 'Link', url: 'https://example.com' }],
      conversationOpener: null,
    })
    const result = documentIntelligenceValidator.validate(doc)
    const nullCheck = result.checks.find(c => c.name === 'opener-not-null')
    expect(nullCheck).toBeDefined()
    expect(nullCheck?.passed).toBe(true)
  })
})
