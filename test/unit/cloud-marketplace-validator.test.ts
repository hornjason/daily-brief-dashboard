/**
 * Unit tests for cloud-marketplace-validator.ts
 */

import { describe, it, expect } from 'bun:test'
import { cloudMarketplaceValidator } from '../../src/quality-validators/cloud-marketplace-validator.ts'

// ── Good extraction fixture ────────────────────────────────────────────────

const GOOD_EXTRACTION = JSON.stringify({
  clouds: [
    {
      provider: 'AWS',
      offerings: [
        { name: 'RHEL 9.5 AMI', description: 'Latest RHEL 9.5 for AWS with SELinux.', pricing: '$0.10/hr', sourceUrl: 'https://docs.google.com/presentation/d/abc123' },
        { name: 'OpenShift on ROSA', description: 'Managed OpenShift via ROSA.', availability: 'GA in all regions' },
      ],
      programs: [
        { name: 'CPPO Program', description: 'Channel Partner Private Offer.', eligibility: 'AWS Partners', sourceUrl: 'https://docs.google.com/presentation/d/abc123' },
      ],
      incentives: [
        { name: 'AWS SPIFF Q2', description: 'Sales SPIFF for marketplace.', value: '$500-$2500 RH Reward Points', validThrough: '2026-06-30' },
      ],
      newCountries: ['India'],
      partnerships: ['AWS + Red Hat joint solution'],
    },
    {
      provider: 'Google',
      offerings: [
        { name: 'RHEL on GCP', description: 'RHEL for Google Cloud.', availability: 'Available Today' },
        { name: 'OpenShift Dedicated', description: 'Managed OpenShift on GCP.' },
      ],
      programs: [
        { name: 'GCP Marketplace Program', description: 'Access to GCP marketplace.' },
      ],
      incentives: [
        { name: 'GCP Credits', description: 'Free credits for new customers.', value: '$1000 credits' },
      ],
      newCountries: [],
      partnerships: [],
    },
    {
      provider: 'Microsoft',
      offerings: [
        { name: 'RHEL on Azure', description: 'RHEL for Azure marketplace.' },
      ],
      programs: [
        { name: 'MACC Program', description: 'Azure consumption commit.', eligibility: 'Enterprise customers' },
      ],
      incentives: [
        { name: 'Azure SPIFF', description: 'Q2 Azure marketplace SPIFF.', value: '$300 per deal' },
      ],
      newCountries: ['Brazil'],
      partnerships: ['Microsoft co-sell partnership'],
    },
  ],
})

const BAD_EXTRACTION = JSON.stringify({
  clouds: [
    {
      provider: 'AWS',
      offerings: [
        { name: '', description: '' },
      ],
      programs: [],
      incentives: [
        { name: 'Some incentive', description: 'A'.repeat(350), value: '' },
      ],
      newCountries: [],
      partnerships: [],
    },
  ],
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('cloudMarketplaceValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(cloudMarketplaceValidator.contentType).toBe('cloud-marketplace')
    expect(cloudMarketplaceValidator.passThreshold).toBe(50)
  })

  it('passes good extraction', () => {
    const scorecard = cloudMarketplaceValidator.validate(GOOD_EXTRACTION)
    expect(scorecard.passed).toBe(true)
    expect(scorecard.score).toBeGreaterThanOrEqual(70)
    expect(scorecard.failures.length).toBe(0)
  })

  it('fails bad extraction with specific checks', () => {
    const scorecard = cloudMarketplaceValidator.validate(BAD_EXTRACTION)
    expect(scorecard.passed).toBe(false)
    const failNames = scorecard.failures.map(f => f.name)
    expect(failNames).toContain('min-providers')
    expect(failNames).toContain('min-total-offerings')
    expect(failNames).toContain('required-fields-populated')
    expect(failNames).toContain('incentive-value-populated')
    expect(failNames).toContain('incentive-description-length')
  })

  it('fails invalid JSON', () => {
    const scorecard = cloudMarketplaceValidator.validate('not json at all')
    expect(scorecard.passed).toBe(false)
    expect(scorecard.failures[0].name).toBe('valid-json')
  })

  it('detects duplicate offering names within a provider', () => {
    const withDupes = JSON.stringify({
      clouds: [
        {
          provider: 'AWS',
          offerings: [
            { name: 'RHEL 9.5', description: 'First entry.' },
            { name: 'RHEL 9.5', description: 'Duplicate entry.' },
            { name: 'OpenShift', description: 'Different.' },
          ],
          programs: [{ name: 'P1', description: 'Prog.' }],
          incentives: [{ name: 'I1', description: 'Inc.', value: '$100' }],
          newCountries: [], partnerships: [],
        },
        {
          provider: 'Google',
          offerings: [{ name: 'RHEL GCP', description: 'OK.' }],
          programs: [{ name: 'P2', description: 'Prog.' }],
          incentives: [{ name: 'I2', description: 'Inc.', value: '$200' }],
          newCountries: [], partnerships: [],
        },
        {
          provider: 'Microsoft',
          offerings: [{ name: 'RHEL Azure', description: 'OK.' }],
          programs: [{ name: 'P3', description: 'Prog.' }],
          incentives: [{ name: 'I3', description: 'Inc.', value: '$300' }],
          newCountries: [], partnerships: [],
        },
      ],
    })
    const scorecard = cloudMarketplaceValidator.validate(withDupes)
    const dupCheck = scorecard.checks.find(c => c.name === 'no-duplicate-offerings')
    expect(dupCheck).toBeDefined()
    expect(dupCheck!.passed).toBe(false)
  })

  it('flags offering parity when one provider has far fewer offerings than the richest', () => {
    const imbalanced = JSON.stringify({
      clouds: [
        {
          provider: 'AWS',
          offerings: [
            { name: 'RHEL 9.5', description: 'AWS RHEL.' },
            { name: 'OpenShift ROSA', description: 'Managed OpenShift.' },
            { name: 'Ansible AAP', description: 'Automation.' },
            { name: 'RHEL AI', description: 'AI platform.' },
            { name: 'RHACM', description: 'Advanced Cluster Mgmt.' },
            { name: 'RHEL for SAP', description: 'SAP optimized.' },
          ],
          programs: [{ name: 'P1', description: 'Prog.' }],
          incentives: [], newCountries: [], partnerships: [],
        },
        {
          provider: 'Google',
          offerings: [],
          programs: [{ name: 'P2', description: 'Prog.' }],
          incentives: [], newCountries: [], partnerships: [],
        },
        {
          provider: 'Microsoft',
          offerings: [
            { name: 'RHEL Azure', description: 'OK.' },
          ],
          programs: [{ name: 'P3', description: 'Prog.' }],
          incentives: [], newCountries: [], partnerships: [],
        },
      ],
    })
    const scorecard = cloudMarketplaceValidator.validate(imbalanced)
    const parityCheck = scorecard.checks.find(c => c.name === 'offering-parity')
    expect(parityCheck).toBeDefined()
    expect(parityCheck!.passed).toBe(false)
    expect(parityCheck!.actual).toContain('Google=0')
  })

  it('passes parity check when offerings are roughly balanced', () => {
    const scorecard = cloudMarketplaceValidator.validate(GOOD_EXTRACTION)
    const parityCheck = scorecard.checks.find(c => c.name === 'offering-parity')
    expect(parityCheck).toBeDefined()
    expect(parityCheck!.passed).toBe(true)
  })

  it('checks program description length', () => {
    const longProgDesc = JSON.stringify({
      clouds: [
        {
          provider: 'AWS',
          offerings: [{ name: 'O1', description: 'OK.' }, { name: 'O2', description: 'OK.' }],
          programs: [{ name: 'Long Prog', description: 'X'.repeat(350) }],
          incentives: [{ name: 'I1', description: 'Inc.', value: '$100' }],
          newCountries: [], partnerships: [],
        },
        {
          provider: 'Google',
          offerings: [{ name: 'O3', description: 'OK.' }, { name: 'O4', description: 'OK.' }],
          programs: [], incentives: [{ name: 'I2', description: 'Inc.', value: '$200' }],
          newCountries: [], partnerships: [],
        },
        {
          provider: 'Microsoft',
          offerings: [{ name: 'O5', description: 'OK.' }],
          programs: [], incentives: [{ name: 'I3', description: 'Inc.', value: '$300' }],
          newCountries: [], partnerships: [],
        },
      ],
    })
    const scorecard = cloudMarketplaceValidator.validate(longProgDesc)
    const progCheck = scorecard.checks.find(c => c.name === 'program-description-length')
    expect(progCheck).toBeDefined()
    expect(progCheck!.passed).toBe(false)
  })
})
