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

The AE should schedule a pilot-to-production planning session with David by end of month to review the scaling path.

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

Your team's Kubernetes pilot showed strong DevOps practices and the three-times deployment frequency improvement suggests good CI/CD fundamentals that can serve as a foundation for enterprise scale. As you scale to production, adding automated security scanning and compliance gates at the pipeline level prevents the bottleneck of manual security reviews that typically slow container adoption at this stage.

Manufacturing environments like yours face additional complexity. FDA and ISO audit requirements mean every container image deployed to production needs a verified provenance chain. Manual security reviews create a two to three week backlog that erodes the deployment speed gains your team worked hard to achieve. The gap between developer velocity and security review capacity widens with each new microservice.

Red Hat OpenShift integrates directly into your existing CI/CD pipelines with capabilities designed for regulated environments:
- Automated vulnerability scanning at build time with policy-based deployment gates
- Compliance evidence generation that satisfies audit requirements automatically
- Image signing and provenance verification for regulated manufacturing workloads

Acme Corp reduced their security review cycle from three weeks to two days after implementing OpenShift pipeline automation. Your DevOps team can maintain the deployment frequency gains while adding the compliance layer manufacturing requires.

Context: Mike leads the DevOps team that ran the Kubernetes pilot and is advocating for OpenShift internally.

## Sr. Manager Cloud Ops — Manager Tier
Subject: Hybrid infrastructure visibility gaps multiply at enterprise scale

Hi Rachel,

Your cloud operations team manages workloads across on-premise data centers and AWS, and the Kubernetes pilot added a third infrastructure paradigm that requires unified observability. Most cloud ops teams discover that their existing monitoring tools create blind spots when container workloads interact with traditional VMs and cloud services. The result is longer incident resolution times and difficulty performing root cause analysis across infrastructure boundaries.

Manufacturing uptime requirements make these visibility gaps particularly costly. When a containerized quality control application depends on an on-premise database and an AWS message queue, a single point of failure can cascade across all three environments. Your team needs correlated telemetry that connects container events to infrastructure metrics to application health in a single view.

Red Hat Advanced Cluster Management with OpenShift provides the cross-environment visibility your operations team needs:
- Unified dashboards spanning containers, VMs, and cloud infrastructure
- Automated fleet management with policy-based governance across clusters
- Integrated alerting that correlates events across hybrid infrastructure boundaries

Beta Inc consolidated their monitoring from five separate tools to a single Advanced Cluster Management deployment and reduced mean time to resolution by forty percent across their hybrid environment. Your cloud ops team can achieve similar consolidation.

Context: Rachel manages cloud operations and has flagged tooling fragmentation as a top concern for the infrastructure review.

## Director Platform Engineering — Manager Tier
Subject: Developer self-service eliminates the provisioning queue your engineers hate

Hi Sarah,

Your platform engineering team handles provisioning requests from development teams across five locations, and the current request-based workflow creates a bottleneck that frustrates developers and overloads your team. Each new environment request requires manual review, configuration, and validation before developers can start working. This queue-based approach made sense with traditional infrastructure but does not scale with container-native development practices.

The Kubernetes pilot demonstrated that developers are ready for self-service capabilities. Your team saw three times faster deployments because developers could iterate without waiting in a provisioning queue. Scaling that experience enterprise-wide requires guardrails that give developers freedom while maintaining security and compliance boundaries that satisfy your governance requirements.

Red Hat Developer Hub combined with OpenShift provides a platform engineering toolkit designed for regulated enterprises:
- Golden path templates that enforce organizational standards while enabling developer self-service
- Software catalog with automated documentation and dependency tracking
- Built-in compliance controls that make secure-by-default the path of least resistance

Acme Corp shifted from a two-week provisioning cycle to same-day developer self-service after implementing Developer Hub templates. Your platform engineering team can focus on building internal capabilities rather than processing provisioning tickets. The productivity gains compound as more development teams adopt the self-service workflow.

Context: Sarah is building the internal developer platform and has been researching portal solutions for standardizing development workflows.
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
          body: 'Your teams are building strong container fundamentals with the Kubernetes pilot success. As Acme scales from pilot to production the security and compliance requirements for regulated manufacturing create challenges that managed Kubernetes does not address. Based on your existing Red Hat Enterprise Linux foundation OpenShift provides a natural extension with built-in security scanning and compliance automation. Three capabilities are particularly relevant for regulated manufacturing environments where audit trails and policy enforcement are non-negotiable.',
          peerProof: 'Acme Corp reduced deployment time by 60% after consolidating on OpenShift',
          actionStep: 'Carolanne Farrell should schedule a briefing with their infrastructure team by next Friday to discuss the pilot-to-production transition plan',
        },
        {
          persona: 'VP Infrastructure',
          tier: 'executive',
          subject: 'Infrastructure costs double when container sprawl goes unmanaged',
          body: 'Preparing infrastructure for enterprise container adoption requires planning that goes beyond the pilot phase. Your existing Red Hat Enterprise Linux deployment provides a stable foundation. OpenShift extends this with multi-cluster management automated certificate rotation and resource quotas that prevent the cost overruns seen in unmanaged container environments across hybrid cloud deployments.',
          peerProof: null,
          actionStep: 'Carolanne should connect our specialist team with David Park by end of week to review their hybrid cloud architecture requirements',
        },
        {
          persona: 'VP Operations',
          tier: 'executive',
          subject: 'Operational costs spike when container monitoring fragments across tools',
          body: 'Your operations team manages workloads across on-premise and cloud environments. As Acme scales container adoption the monitoring fragmentation across these environments creates blind spots during incidents. Your existing Red Hat Enterprise Linux foundation provides consistency that OpenShift extends with unified observability across hybrid infrastructure. Correlated telemetry connecting container events to infrastructure metrics enables faster root cause analysis.',
          peerProof: 'Delta Manufacturing cut incident resolution time by 45% with unified OpenShift observability',
          actionStep: 'Carolanne should schedule an operations review with Jennifer by next week to assess monitoring consolidation opportunities',
        },
        {
          persona: 'Director of IT',
          tier: 'manager',
          subject: 'From manual compliance audits to automated evidence generation',
          body: 'Managing separate compliance workflows for containerized and traditional workloads doubles audit preparation time and creates gaps that auditors flag during reviews. Your operations team currently spends significant effort on manual compliance evidence collection across multiple tools and platforms that were never designed to work together. Each new containerized workload adds another compliance surface that requires documentation and verification before it can move to production environments. The manual overhead compounds as your container footprint grows and audit frequency increases with regulatory changes in manufacturing. Given your foundation on Red Hat Enterprise Linux OpenShift unifies compliance reporting across both container and VM workloads with a single policy engine that applies consistent rules everywhere. Automated evidence generation captures every deployment decision and configuration change without requiring manual documentation from your engineering teams. Policy-as-code enforcement ensures that compliance requirements are met before containers reach production rather than discovered during quarterly audits when remediation is expensive and disruptive. Continuous compliance monitoring replaces the quarterly scramble with continuous assurance that auditors can verify in real time through standardized dashboards. The gap between development velocity and compliance verification narrows significantly when evidence generation is automated at the platform level rather than bolted on as a separate workflow that your team must maintain independently. Your IT team can shift from reactive audit preparation to proactive compliance governance that scales naturally with container adoption across all five locations.',
          peerProof: 'Beta Inc consolidated 3 separate compliance tools into a single OpenShift-based workflow',
          actionStep: 'Carolanne should organize a compliance automation workshop this month focused on their FDA and ISO requirements',
        },
        {
          persona: 'Sr. Manager Cloud Operations',
          tier: 'manager',
          subject: 'Hybrid visibility gaps multiply with each new cluster deployment',
          body: 'Your cloud operations team manages workloads spanning on-premise data centers and AWS and the Kubernetes pilot introduced a third infrastructure paradigm requiring unified observability and centralized management across all environments. Most cloud ops teams discover that existing monitoring tools create blind spots when container workloads interact with traditional VMs and cloud services creating longer incident resolution times and difficulty tracing root causes across infrastructure boundaries that span multiple technology stacks. Manufacturing uptime requirements make these visibility gaps particularly costly when production depends on interconnected systems. When a containerized quality control application depends on an on-premise database and an AWS message queue a single point of failure cascades across all three environments without warning. Your team needs correlated telemetry that connects container events to infrastructure metrics to application health in one unified view that operators can navigate quickly during incidents. Red Hat Advanced Cluster Management with OpenShift provides the cross-environment visibility and governance your operations team needs to maintain manufacturing uptime guarantees. Unified dashboards spanning containers VMs and cloud infrastructure give operators a single pane of glass for all managed environments. Automated fleet management with policy-based governance ensures consistent configuration across clusters while integrated alerting correlates events across hybrid infrastructure boundaries to surface root causes faster than fragmented monitoring ever could. Your cloud ops team can reduce monitoring tool sprawl and achieve consolidated hybrid infrastructure management with fewer operational overhead costs.',
          peerProof: null,
          actionStep: 'Carolanne should arrange a hybrid infrastructure review with Rachel by end of month to assess monitoring consolidation needs',
        },
        {
          persona: 'Director of Platform Engineering',
          tier: 'manager',
          subject: 'Developer self-service eliminates the provisioning queue engineers hate',
          body: 'Your platform engineering team handles provisioning requests from development teams across five locations and the current request-based workflow creates a bottleneck that frustrates developers and overloads your team with repetitive manual configuration work that consumes engineering hours better spent on platform improvements. Each new environment request requires manual review configuration and validation before developers can begin working on their assigned projects. This queue-based provisioning approach made sense with traditional infrastructure but does not scale with container-native development practices that demand rapid iteration cycles and fast feedback loops. The Kubernetes pilot demonstrated that developers are ready for self-service capabilities and will adopt them eagerly when available. Your team saw three times faster deployments because developers could iterate without waiting in a provisioning queue that averaged two weeks for standard requests. Scaling that experience enterprise-wide requires guardrails that give developers freedom while maintaining security and compliance boundaries that satisfy governance requirements across all business units. Red Hat Developer Hub combined with OpenShift provides a platform engineering toolkit specifically designed for regulated enterprises that need both speed and control. Golden path templates enforce organizational standards while enabling developer self-service through approved patterns. The software catalog provides automated documentation and dependency tracking while built-in compliance controls make the secure path the easiest path for every developer. Your platform team can shift focus from processing provisioning tickets to building internal capabilities that accelerate delivery velocity.',
          peerProof: 'Gamma Corp shifted from two-week provisioning to same-day developer self-service after implementing Developer Hub templates',
          actionStep: 'Carolanne should set up a platform engineering workshop within two weeks to review golden path template requirements for their development teams',
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
