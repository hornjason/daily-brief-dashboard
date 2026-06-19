/**
 * Unit tests for campaign-validator.ts
 */

import { describe, it, expect } from 'bun:test'
import { campaignValidator } from '../../src/quality-validators/campaign-validator.ts'

// ── Good campaign fixture ───────────────────────────────────────────────────

const GOOD_CAMPAIGN = `
## Campaign Summary
This campaign positions Red Hat OpenShift as the ideal container orchestration platform for Acme Corp's cloud-native transformation, leveraging their recent Kubernetes pilot success and upcoming infrastructure refresh cycle.

## Customer Context
Acme Corp is a $2.1B manufacturing company undergoing a significant digital transformation. They have recently completed a successful Kubernetes pilot with 50 containers and are looking to scale enterprise-wide. Their VP of Infrastructure, David Park, has publicly spoken about moving to a hybrid cloud architecture by 2027. The company has 8,000 employees across 5 locations.

## Positioning
- OpenShift provides enterprise-grade Kubernetes with built-in security and compliance features that address Acme's regulated manufacturing environment
- Ansible Automation Platform integrates seamlessly with OpenShift for Day 2 operations, reducing their current 40-hour monthly maintenance to under 10 hours
- Red Hat's hybrid cloud strategy aligns with Acme's multi-cloud roadmap, providing consistent operations across AWS and on-premise data centers

## VP Infrastructure — Executive Tier
Subject: Your Kubernetes pilot results caught my attention

Hi David,

I noticed Acme's recent Kubernetes pilot achieved a 3x improvement in deployment frequency — that's a strong signal your team has real container expertise developing. Based on our work with similar manufacturing companies scaling from pilot to production Kubernetes, the transition from 50 to 5,000+ containers introduces challenges around security scanning, multi-cluster management, and compliance automation that are worth planning for early.

Red Hat OpenShift addresses these scale-up concerns with:
- Built-in container security scanning and compliance reporting
- Multi-cluster management across hybrid environments
- Integrated CI/CD pipelines with security gates

Would it be helpful to see how a company in your industry handled the pilot-to-production transition? I can share a specific case study from a food manufacturing company of similar size.

Context: David has been vocal about hybrid cloud at industry events and has a relationship with our partner CloudWorks.

## VP Operations — Executive Tier
Subject: The operational cost of scaling containers without automation

Hi Jennifer,

As Acme scales from pilot Kubernetes to enterprise-wide container adoption, operations teams typically see a 4x increase in incident volume before automation catches up. Manufacturing environments add complexity with uptime requirements and audit compliance that make manual container management unsustainable.

Ansible Automation Platform can help your operations team by:
- Automating Day 2 operations across container and traditional infrastructure
- Providing self-service provisioning with built-in guardrails
- Reducing compliance audit preparation from weeks to hours

I'd value the chance to discuss how automation can help your team manage the transition without scaling headcount proportionally.

Context: Jennifer oversees infrastructure operations and has expressed concern about team capacity during the transformation.

## CIO — Executive Tier
Subject: Aligning your cloud-native strategy with manufacturing compliance requirements

Hi Robert,

Acme's digital transformation vision is ambitious and well-conceived — the Kubernetes pilot success demonstrates strong technical leadership. As you move from pilot to production, the intersection of cloud-native architecture and manufacturing compliance (FDA, ISO) creates unique requirements that generic cloud platforms don't address.

Red Hat's approach provides:
- Consistent security and compliance across hybrid cloud environments
- Enterprise support for regulated industries with SLA guarantees
- Open source innovation without vendor lock-in risk

Would a brief conversation about how other regulated manufacturers have navigated this transition be valuable?

Context: Robert joined as CIO 18 months ago with a mandate to modernize IT infrastructure while maintaining compliance.

## Director DevOps — Manager Tier
Subject: Automating security gates in your container pipeline

Hi Mike,

Your team's Kubernetes pilot showed strong DevOps practices — the 3x deployment frequency improvement suggests good CI/CD fundamentals. As you scale to production, adding automated security scanning and compliance gates at the pipeline level prevents the bottleneck of manual security reviews.

OpenShift's integrated pipelines with:
- Automated vulnerability scanning at build time
- Policy-based deployment gates
- Compliance evidence generation for audits

Can eliminate the security review bottleneck that typically slows container adoption at scale.

Context: Mike leads the DevOps team that ran the Kubernetes pilot and is advocating for OpenShift internally.
`

// ── Bad campaign fixture ────────────────────────────────────────────────────

const BAD_CAMPAIGN = `
## Summary
Short.

Some text about the customer.

## Email
Subject: Hi

Hello, here is some info.
`

// ── Tests ───────────────────────────────────────────────────────────────────

describe('campaignValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(campaignValidator.contentType).toBe('campaign')
    expect(campaignValidator.passThreshold).toBe(80)
  })

  describe('good campaign fixture', () => {
    const scorecard = campaignValidator.validate(GOOD_CAMPAIGN)

    it('passes overall', () => {
      expect(scorecard.passed).toBe(true)
      expect(scorecard.score).toBeGreaterThanOrEqual(80)
    })

    it('detects campaign summary', () => {
      const check = scorecard.checks.find(c => c.name === 'campaign-summary')
      expect(check?.passed).toBe(true)
    })

    it('detects customer context', () => {
      const check = scorecard.checks.find(c => c.name === 'customer-context')
      expect(check?.passed).toBe(true)
    })

    it('detects positioning points', () => {
      const check = scorecard.checks.find(c => c.name === 'positioning')
      expect(check?.passed).toBe(true)
    })

    it('detects email templates', () => {
      const check = scorecard.checks.find(c => c.name === 'email-templates-count')
      expect(check?.passed).toBe(true)
    })

    it('detects subject lines', () => {
      const check = scorecard.checks.find(c => c.name === 'email-subject-lines')
      expect(check?.passed).toBe(true)
    })

    it('detects sufficient email body length', () => {
      const check = scorecard.checks.find(c => c.name === 'email-body-length')
      expect(check?.passed).toBe(true)
    })

    it('detects no internal data leakage', () => {
      const check = scorecard.checks.find(c => c.name === 'no-internal-data')
      expect(check?.passed).toBe(true)
    })
  })

  describe('bad campaign fixture', () => {
    const scorecard = campaignValidator.validate(BAD_CAMPAIGN)

    it('fails overall', () => {
      expect(scorecard.passed).toBe(false)
    })

    it('flags missing campaign summary (wrong header name)', () => {
      const check = scorecard.checks.find(c => c.name === 'campaign-summary')
      expect(check?.passed).toBe(false)
    })

    it('flags insufficient email templates', () => {
      const check = scorecard.checks.find(c => c.name === 'email-templates-count')
      expect(check?.passed).toBe(false)
    })
  })

  describe('internal data detection', () => {
    it('flags subscription counts in email bodies', () => {
      const output = GOOD_CAMPAIGN.replace(
        'deployment frequency',
        'deployment frequency across their 2,400 nodes with 150 subscriptions'
      )
      const scorecard = campaignValidator.validate(output)
      const check = scorecard.checks.find(c => c.name === 'no-internal-data')
      expect(check?.passed).toBe(false)
    })
  })

  // ── ADR-040: Structured JSON output validation ───────────────────────────

  describe('structured JSON output (ADR-040)', () => {
    const goodStructured = JSON.stringify({
      campaignSummary: 'This campaign targets Acme Corp with Red Hat OpenShift positioning for their cloud-native transformation initiative spanning multiple business units.',
      customerContext: 'The customer is actively evaluating container orchestration platforms after a successful Kubernetes pilot. Their VP of Infrastructure presented at KubeCon about hybrid cloud goals, and they have a $2.1M pipeline renewal coming in Q3.',
      positioning: 'Challenger Insight: There is a hidden gap in their container security posture that becomes critical at scale. Red Hat OpenShift addresses enterprise Kubernetes needs with built-in compliance automation that generic managed Kubernetes services lack.',
      emails: [
        {
          persona: 'CIO',
          tier: 'executive',
          subject: 'AI workload readiness depends on your container foundation',
          body: 'Your teams are building strong container fundamentals with the Kubernetes pilot success. As Acme scales from pilot to production, the security and compliance requirements for regulated manufacturing create requirements that managed Kubernetes does not address. Based on your existing Red Hat Enterprise Linux foundation, OpenShift provides a natural extension with built-in security scanning and compliance automation. Three capabilities are particularly relevant for regulated manufacturing environments where audit trails and consistent policy enforcement are non-negotiable.',
          peerProof: 'Acme Corp reduced deployment time by 60% after consolidating on OpenShift',
          actionStep: 'Carolanne Farrell should schedule a briefing with their infrastructure team by next Friday to discuss the pilot-to-production transition plan',
        },
        {
          persona: 'VP Infra',
          tier: 'executive',
          subject: 'Infrastructure costs double when container sprawl goes unmanaged',
          body: 'Preparing infrastructure for enterprise container adoption requires planning that goes beyond the pilot phase. Your existing Red Hat Enterprise Linux deployment provides a stable foundation. OpenShift extends this with multi-cluster management, automated certificate rotation, and resource quotas that prevent the cost overruns seen in unmanaged container environments across hybrid cloud deployments.',
          peerProof: null,
          actionStep: 'Carolanne should connect our specialist team with David Park by end of week to review their hybrid cloud architecture requirements',
        },
        {
          persona: 'Director IT',
          tier: 'manager',
          subject: 'From manual compliance audits to automated evidence generation',
          body: 'Managing separate compliance workflows for containerized and traditional workloads doubles audit preparation time. Your operations team currently spends significant effort on manual compliance evidence collection. Given your foundation on Red Hat Enterprise Linux, OpenShift unifies compliance reporting across both container and VM workloads. Automated evidence generation, policy-as-code enforcement, and continuous compliance monitoring replace the quarterly scramble with continuous assurance that auditors can verify in real time.',
          peerProof: 'Beta Inc consolidated 3 separate compliance tools into a single OpenShift-based workflow',
          actionStep: 'Carolanne should organize a compliance automation workshop this month focused on their FDA and ISO requirements',
        },
        {
          persona: 'Director Ops',
          tier: 'manager',
          subject: 'Automated remediation eliminates the 3am incident response pattern',
          body: 'Your ops team is handling incident response across container and traditional infrastructure with separate tools and runbooks. This dual-stack approach creates blind spots during incidents where container issues cascade into traditional systems. Building on your Red Hat Enterprise Linux environment, Event-Driven Ansible integrated with OpenShift provides automated remediation workflows that detect, diagnose, and resolve common infrastructure issues before they page your on-call team. Self-healing infrastructure patterns reduce mean time to resolution from hours to minutes.',
          peerProof: null,
          actionStep: 'Carolanne should arrange a demo within two weeks showing automated remediation in a hybrid environment similar to theirs',
        },
      ],
    })

    it('passes on good structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      expect(scorecard.passed).toBe(true)
      expect(scorecard.score).toBeGreaterThanOrEqual(80)
    })

    it('detects campaign summary in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'campaign-summary')
      expect(check?.passed).toBe(true)
    })

    it('detects customer context in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'customer-context')
      expect(check?.passed).toBe(true)
    })

    it('detects positioning in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'positioning')
      expect(check?.passed).toBe(true)
    })

    it('detects email template count in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'email-templates-count')
      expect(check?.passed).toBe(true)
    })

    it('detects email subject lines in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'email-subject-lines')
      expect(check?.passed).toBe(true)
    })

    it('detects email body length in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'email-body-length')
      expect(check?.passed).toBe(true)
    })

    it('detects action steps in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'action-step-present')
      expect(check?.passed).toBe(true)
    })

    it('fails on all-nulls peerProof', () => {
      const allNulls = JSON.parse(goodStructured)
      allNulls.emails.forEach((e: any) => { e.peerProof = null })
      const scorecard = campaignValidator.validate(JSON.stringify(allNulls))
      expect(scorecard.checks.find((c: any) => c.name === 'not-all-nulls')?.passed).toBe(false)
    })

    it('fails on fabricated peer references', () => {
      const fabricated = JSON.parse(goodStructured)
      fabricated.emails[0].peerProof = 'A major insurer improved their operations significantly'
      const scorecard = campaignValidator.validate(JSON.stringify(fabricated))
      expect(scorecard.checks.find((c: any) => c.name === 'no-fabricated-peers')?.passed).toBe(false)
    })

    it('fails on too few emails', () => {
      const fewEmails = JSON.parse(goodStructured)
      fewEmails.emails = fewEmails.emails.slice(0, 2)
      const scorecard = campaignValidator.validate(JSON.stringify(fewEmails))
      const check = scorecard.checks.find((c: any) => c.name === 'email-templates-count')
      expect(check?.passed).toBe(false)
    })

    it('fails on missing campaign summary', () => {
      const noSummary = JSON.parse(goodStructured)
      noSummary.campaignSummary = 'Short'
      const scorecard = campaignValidator.validate(JSON.stringify(noSummary))
      const check = scorecard.checks.find((c: any) => c.name === 'campaign-summary')
      expect(check?.passed).toBe(false)
    })

    it('detects no internal data leakage in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'no-internal-data')
      expect(check?.passed).toBe(true)
    })

    it('flags internal data in structured email bodies', () => {
      const leaky = JSON.parse(goodStructured)
      leaky.emails[0].body = leaky.emails[0].body + ' across their 2,400 nodes with 150 subscriptions'
      const scorecard = campaignValidator.validate(JSON.stringify(leaky))
      const check = scorecard.checks.find((c: any) => c.name === 'no-internal-data')
      expect(check?.passed).toBe(false)
    })

    it('detects money connection in structured output', () => {
      const scorecard = campaignValidator.validate(goodStructured)
      const check = scorecard.checks.find((c: any) => c.name === 'money-connection')
      expect(check?.passed).toBe(true)
    })
  })
})
