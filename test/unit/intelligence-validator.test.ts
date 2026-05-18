/**
 * Unit tests for intelligence-validator.ts
 */

import { describe, it, expect } from 'bun:test'
import { intelligenceValidator } from '../../src/quality-validators/intelligence-validator.ts'

// ── Good intelligence fixture ───────────────────────────────────────────────

const GOOD_INTELLIGENCE = `
## Executive Summary
Taylor Fresh Foods is a leading US-based fresh produce company with annual revenue of approximately $4.2 billion and over 15,000 employees across North America and Europe. The company operates in the highly competitive fresh food processing and distribution industry, serving major grocery chains, food service operators, and institutional buyers. Taylor Fresh Foods has been investing heavily in automation and digital transformation to maintain its competitive edge in an industry characterized by thin margins and strict food safety compliance requirements. The company's technology modernization efforts present significant opportunities for Red Hat solutions across infrastructure, automation, and edge computing.

## Company Overview
Taylor Fresh Foods, headquartered in Salinas, California, is one of the largest fresh-cut produce processors in North America. Founded in 1995, the company has grown through organic expansion and strategic acquisitions to become a $4.2 billion revenue enterprise. With approximately 15,000 employees across 25+ manufacturing facilities, Taylor Fresh Foods processes over 1 billion pounds of produce annually. The company's customer base includes major retailers such as Walmart, Kroger, and Costco, as well as food service distributors like Sysco and US Foods. Taylor Fresh Foods has invested over $200 million in technology modernization over the past three years, including ERP upgrades, IoT sensor deployments, and initial container platform pilots.

## Industry Structure and Market Landscape
The global fresh-cut produce market is valued at approximately $28.5 billion (TAM) and growing at a CAGR of 6.2% according to industry research [1]. The US market represents roughly 40% of global demand, driven by consumer preference for convenience and health-conscious eating. Key market dynamics include increasing automation requirements, stringent FDA food safety regulations (FSMA), and growing demand for supply chain traceability.

## Technology Landscape
Taylor Fresh Foods operates a hybrid technology environment spanning legacy on-premises systems and emerging cloud-native workloads. Their core ERP runs on SAP S/4HANA with plans to migrate to a hybrid cloud deployment by 2027. The company has deployed Red Hat Enterprise Linux across approximately 2,400 production nodes, Kubernetes pilots in 2 data centers, and IoT edge sensors at 12 manufacturing plants. Key technology initiatives include container platform standardization, DevSecOps pipeline implementation, and edge computing for real-time quality monitoring.

## Competitive Signals
- **VMware/Broadcom**: Taylor currently uses VMware for virtualization; Broadcom's acquisition and licensing changes have created dissatisfaction and an opportunity for OpenShift as an alternative
- **AWS**: The company has a growing AWS footprint for development workloads; risk of AWS becoming the default container platform without Red Hat engagement
- **Microsoft Azure**: Taylor's SAP partnership could pull them toward Azure for hybrid cloud; Red Hat's SAP on OpenShift positioning is critical
- **SUSE/Rancher**: SUSE has been actively pursuing Taylor's container platform decision with Rancher pricing that undercuts OpenShift
- **HashiCorp**: Terraform is used for infrastructure-as-code; Ansible opportunity to consolidate automation tooling

## Risk Signals
- CFO-driven cost reduction initiative could delay infrastructure spending in Q3-Q4 2026
- New CTO (Maria Chen) joined 6 months ago — still evaluating vendor relationships and may reset previous commitments
- Food safety recall in Q1 2026 consumed IT resources and delayed digital transformation timeline by approximately 3 months
- Broadcom VMware licensing increase of 40% may accelerate platform decisions but could also trigger a broader cost-cutting response

## Geographic and Regional Presence
Taylor Fresh Foods operates primarily in North America with 20 manufacturing facilities across the United States and 5 facilities in Mexico. The company has recently expanded into Europe through the acquisition of FreshPack Ltd in the United Kingdom, adding 3 processing plants. Their Asia-Pacific distribution network serves customers in Japan and Australia through partner agreements. This multi-region presence creates opportunities for consistent infrastructure management across geographies.

## Sources and References
[1] Grand View Research, "Fresh-Cut Produce Market Report 2025"
[2] Taylor Fresh Foods Annual Report 2025
[3] FDA FSMA Compliance Requirements, updated 2025
[4] Gartner, "Magic Quadrant for Container Management Platforms 2025"
According to industry analysts, the fresh produce sector is among the most active in edge computing adoption.
`

// ── Bad intelligence fixture ────────────────────────────────────────────────

const BAD_INTELLIGENCE = `
## Summary
Taylor Fresh Foods is a company.

## Overview
They do food things.
`

// ── Tests ───────────────────────────────────────────────────────────────────

describe('intelligenceValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(intelligenceValidator.contentType).toBe('intelligence')
    expect(intelligenceValidator.passThreshold).toBe(80)
  })

  describe('good intelligence fixture', () => {
    const scorecard = intelligenceValidator.validate(GOOD_INTELLIGENCE)

    it('passes overall', () => {
      expect(scorecard.passed).toBe(true)
      expect(scorecard.score).toBeGreaterThanOrEqual(80)
    })

    it('detects executive summary', () => {
      const check = scorecard.checks.find(c => c.name === 'executive-summary')
      expect(check?.passed).toBe(true)
    })

    it('detects industry structure with market size', () => {
      const check = scorecard.checks.find(c => c.name === 'industry-structure')
      expect(check?.passed).toBe(true)
    })

    it('detects technology landscape', () => {
      const check = scorecard.checks.find(c => c.name === 'technology-landscape')
      expect(check?.passed).toBe(true)
    })

    it('detects competitive signals (>= 3)', () => {
      const check = scorecard.checks.find(c => c.name === 'competitive-signals')
      expect(check?.passed).toBe(true)
    })

    it('detects company overview (>= 200 chars)', () => {
      const check = scorecard.checks.find(c => c.name === 'company-overview')
      expect(check?.passed).toBe(true)
    })

    it('detects revenue data', () => {
      const check = scorecard.checks.find(c => c.name === 'revenue-data')
      expect(check?.passed).toBe(true)
    })

    it('detects employee data', () => {
      const check = scorecard.checks.find(c => c.name === 'employee-data')
      expect(check?.passed).toBe(true)
    })

    it('detects risk signals section', () => {
      const check = scorecard.checks.find(c => c.name === 'risk-signals')
      expect(check?.passed).toBe(true)
    })

    it('detects regional coverage (>= 2 regions)', () => {
      const check = scorecard.checks.find(c => c.name === 'regional-coverage')
      expect(check?.passed).toBe(true)
    })

    it('detects source citations (>= 3)', () => {
      const check = scorecard.checks.find(c => c.name === 'source-citations')
      expect(check?.passed).toBe(true)
    })
  })

  describe('bad intelligence fixture', () => {
    const scorecard = intelligenceValidator.validate(BAD_INTELLIGENCE)

    it('fails overall', () => {
      expect(scorecard.passed).toBe(false)
    })

    it('identifies failures', () => {
      expect(scorecard.failures.length).toBeGreaterThan(5)
    })

    it('flags missing executive summary (too short)', () => {
      const check = scorecard.checks.find(c => c.name === 'executive-summary')
      expect(check?.passed).toBe(false)
    })

    it('flags missing revenue data', () => {
      const check = scorecard.checks.find(c => c.name === 'revenue-data')
      expect(check?.passed).toBe(false)
    })

    it('flags missing employee data', () => {
      const check = scorecard.checks.find(c => c.name === 'employee-data')
      expect(check?.passed).toBe(false)
    })
  })
})
