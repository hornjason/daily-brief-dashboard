/**
 * Quality gate garbage-in tests — verifies that severity: 'required' checks
 * actually cause auto-fail (score 0), and that passThreshold is respected.
 *
 * Regression tests for:
 * - Bug: required severity not enforced (score capped at 0 on required failure)
 * - Bug: passThreshold hardcoded to 60 (should use validator's own threshold)
 */

import { describe, test, expect } from 'bun:test'
import { documentIntelligenceValidator } from '../../src/quality-validators/document-intelligence-validator.ts'

describe('Quality gate garbage-in tests', () => {
  test('document with 0 products fails even if other checks pass', () => {
    const output = JSON.stringify({
      documentCategory: 'other',
      summary: 'This is a test summary that is at least twenty characters long.',
      productsReferenced: [],
      integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
      useCases: ['automation'],
      competitorsReferenced: null,
      partnerSolutions: null,
      cloudProviders: null,
      audience: 'internal',
      keyPoints: ['test point'],
      talkTracks: null,
      links: [{ name: 'test', url: 'https://example.com' }],
      actionableSteps: null,
    })
    const result = documentIntelligenceValidator.validate(output)
    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
  })

  test('document with 0 classifications fails even if products present', () => {
    const output = JSON.stringify({
      documentCategory: 'other',
      summary: 'This is a test summary that is at least twenty characters long.',
      productsReferenced: [{ name: 'Red Hat OpenShift' }],
      integrationsReferenced: null,
      useCases: null,
      competitorsReferenced: null,
      partnerSolutions: null,
      cloudProviders: null,
      audience: 'customer',
      keyPoints: ['test point'],
      talkTracks: null,
      links: [{ name: 'test', url: 'https://example.com' }],
      actionableSteps: null,
    })
    const result = documentIntelligenceValidator.validate(output)
    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
  })

  test('document with all required fields passes', () => {
    const output = JSON.stringify({
      documentCategory: 'solution-brief',
      summary: 'This is a test summary that describes how ServiceNow integrates with Red Hat for IT automation.',
      productsReferenced: [{ name: 'Red Hat Ansible Automation Platform' }],
      integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
      useCases: ['IT automation'],
      competitorsReferenced: null,
      partnerSolutions: null,
      cloudProviders: null,
      audience: 'customer',
      keyPoints: ['Automate ServiceNow workflows'],
      talkTracks: ['Reduce MTTR by 60% with automated incident response'],
      links: [{ name: 'Learn more', url: 'https://redhat.com' }],
      actionableSteps: null,
    })
    const result = documentIntelligenceValidator.validate(output)
    expect(result.passed).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(85)
  })

  test('validator uses passThreshold of 85, not hardcoded 60', () => {
    expect(documentIntelligenceValidator.passThreshold).toBe(85)
    const output = JSON.stringify({
      documentCategory: 'other',
      summary: 'Short but valid summary for testing purposes here.',
      productsReferenced: [{ name: 'RHEL' }],
      integrationsReferenced: [{ technology: 'Test', category: 'Other' }],
      useCases: null,
      competitorsReferenced: null,
      partnerSolutions: null,
      cloudProviders: null,
      audience: 'internal',
      keyPoints: ['point'],
      talkTracks: null,
      links: [],
      actionableSteps: null,
    })
    const result = documentIntelligenceValidator.validate(output)
    // Verify the scorecard carries the validator's threshold, not 60
    expect(result.passThreshold).toBe(85)
  })

  test('required failure caps score at 0 even when most checks pass', () => {
    // All checks pass EXCEPT has-products (required) — score must be 0, not 87
    const output = JSON.stringify({
      documentCategory: 'solution-brief',
      summary: 'This is a comprehensive summary about IT automation and infrastructure.',
      productsReferenced: [], // required check fails
      integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
      useCases: ['IT automation'],
      competitorsReferenced: null,
      partnerSolutions: null,
      cloudProviders: null,
      audience: 'customer',
      keyPoints: ['Automate workflows'],
      talkTracks: null,
      links: [{ name: 'Learn more', url: 'https://redhat.com' }],
      actionableSteps: null,
    })
    const result = documentIntelligenceValidator.validate(output)
    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    // Verify the failure is correctly identified
    const productCheck = result.checks.find(c => c.name === 'has-products')
    expect(productCheck?.passed).toBe(false)
    expect(productCheck?.severity).toBe('required')
  })

  test('only recommended failures do not cap score at 0', () => {
    // All required checks pass, one recommended (has-links) fails
    const output = JSON.stringify({
      documentCategory: 'solution-brief',
      summary: 'This is a substantive summary about how Red Hat Ansible Automation Platform integrates with ServiceNow for IT automation. It covers how organizations can automate ITSM workflows, reduce mean time to resolution, and improve operational efficiency through event-driven automation and closed-loop remediation processes.',
      productsReferenced: [{ name: 'Red Hat Ansible Automation Platform' }],
      integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
      useCases: ['IT automation'],
      competitorsReferenced: null,
      partnerSolutions: null,
      cloudProviders: null,
      audience: 'customer',
      keyPoints: ['Automate workflows'],
      talkTracks: ['Reduce MTTR by 60% with automated incident response'],
      links: [], // recommended check fails (no links)
      actionableSteps: null,
    })
    const result = documentIntelligenceValidator.validate(output)
    // Score should NOT be 0 — only the recommended check failed
    expect(result.score).toBeGreaterThan(0)
    // 10/11 checks pass = 91%, which is > 85 threshold
    expect(result.passed).toBe(true)
  })
})
