/**
 * Regression test for #854 — campaign positioning check must accept
 * paragraph-format positioning in addition to bullet/numbered lists.
 */

import { describe, it, expect } from 'bun:test'
import { campaignValidator } from '../../src/quality-validators/campaign-validator.ts'

const EMAIL_BLOCK = `
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

As Acme scales from pilot Kubernetes to enterprise-wide container adoption, operations teams typically see a 4x increase in incident volume before automation catches up. Manufacturing environments add complexity with uptime requirements and audit compliance.

Ansible Automation Platform can help your operations team by:
- Automating Day 2 operations across container and traditional infrastructure
- Providing self-service provisioning with built-in guardrails

I'd value the chance to discuss how automation can help your team manage the transition. You should schedule a call by next Friday.

Context: Jennifer oversees infrastructure operations.

## CIO — Executive Tier
Subject: Aligning your cloud-native strategy with manufacturing compliance

Hi Robert,

Acme's digital transformation vision is ambitious. The Kubernetes pilot demonstrates strong technical leadership. As you move to production, the intersection of cloud-native and manufacturing compliance creates unique challenges.

Red Hat provides:
- Consistent security and compliance across hybrid cloud
- Enterprise support for regulated industries
- Open source innovation without vendor lock-in

Context: Robert joined as CIO 18 months ago with a mandate to modernize.

## Director DevOps — Manager Tier
Subject: Automating security gates in your container pipeline

Hi Mike,

Your team's pilot showed strong DevOps practices. As you scale, automated security scanning and policy-based deployment gates prevent bottlenecks.

OpenShift integrates:
- Automated vulnerability scanning at build time
- Policy-based deployment gates
- Compliance evidence generation

Context: Mike leads the DevOps team that ran the pilot.

## Sr. Manager Cloud Ops — Manager Tier
Subject: Hybrid infrastructure visibility gaps multiply at enterprise scale

Hi Rachel,

Your cloud operations team manages workloads across on-premise data centers and AWS and the Kubernetes pilot introduced a third infrastructure paradigm requiring unified observability. Most cloud ops teams discover that existing monitoring tools create blind spots when container workloads interact with traditional VMs and cloud services creating longer incident resolution times and difficulty tracing root causes across infrastructure boundaries that span multiple technology stacks. Manufacturing uptime requirements make these visibility gaps particularly costly when production systems depend on interconnected services. When a containerized quality control application depends on an on-premise database and an AWS message queue a single point of failure cascades across environments. Your team needs correlated telemetry that connects container events to infrastructure metrics to application health in one unified view that operators can navigate quickly during incidents. Red Hat Advanced Cluster Management with OpenShift provides the cross-environment visibility and governance your operations team needs to maintain manufacturing uptime requirements. Unified dashboards spanning containers VMs and cloud infrastructure give operators a single pane of glass for all managed environments. Automated fleet management with policy-based governance ensures consistent configuration across clusters while integrated alerting correlates events across hybrid infrastructure boundaries to surface root causes faster. Rachel should schedule a hybrid infrastructure review by end of month.

Context: Rachel manages cloud operations.

## Director Platform Engineering — Manager Tier
Subject: Developer self-service eliminates the provisioning queue engineers hate

Hi Sarah,

Your platform engineering team handles provisioning requests from development teams across five locations and the current request-based workflow creates a bottleneck that frustrates developers and overloads your team with repetitive manual configuration work that consumes engineering hours. Each new environment request requires manual review configuration and validation before developers can begin working on their assigned projects. This queue-based provisioning approach made sense with traditional infrastructure but does not scale with container-native development practices that demand rapid iteration cycles and fast feedback loops. The Kubernetes pilot demonstrated that developers are ready for self-service capabilities and will adopt them eagerly. Your team saw three times faster deployments because developers could iterate without waiting in a provisioning queue that averaged two weeks. Scaling that experience enterprise-wide requires guardrails that give developers freedom while maintaining security and compliance boundaries that satisfy governance requirements across all business units. Red Hat Developer Hub combined with OpenShift provides a platform engineering toolkit designed for regulated enterprises that need both speed and control. Golden path templates enforce organizational standards while enabling developer self-service through approved patterns and workflows. The software catalog provides automated documentation and dependency tracking while built-in compliance controls make the secure path the easiest path for every developer. Sarah should set up a platform engineering workshop within two weeks.

Context: Sarah is building the internal developer platform.
`

function makeCampaign(positioningSection: string): string {
  return `## Campaign Summary
This campaign positions Red Hat OpenShift as the ideal container orchestration platform for Acme Corp's cloud-native transformation. Their $2.1M pipeline renewal and recent Kubernetes pilot success create a strong expansion opportunity.

## Customer Context
Acme Corp is a $2.1B manufacturing company undergoing a significant digital transformation. They have recently completed a successful Kubernetes pilot with 50 containers and are looking to scale enterprise-wide. Their VP of Infrastructure has publicly spoken about moving to a hybrid cloud architecture by 2027. The company has 8,000 employees across 5 locations.

## Positioning
${positioningSection}
${EMAIL_BLOCK}`
}

describe('#854 — paragraph-format positioning', () => {
  it('passes positioning check with bullet-format points (no regression)', () => {
    const bullets = `- OpenShift provides enterprise-grade Kubernetes with built-in security
- Ansible Automation Platform integrates seamlessly for Day 2 operations
- Red Hat hybrid cloud strategy aligns with Acme multi-cloud roadmap`

    const scorecard = campaignValidator.validate(makeCampaign(bullets))
    const check = scorecard.checks.find(c => c.name === 'positioning')
    expect(check?.passed).toBe(true)
  })

  it('passes positioning check with paragraph-format points', () => {
    const paragraphs = `OpenShift provides enterprise-grade Kubernetes with built-in security and compliance features that address Acme's regulated manufacturing environment, reducing audit preparation from weeks to automated continuous monitoring.

Ansible Automation Platform integrates seamlessly with OpenShift for Day 2 operations, reducing their current 40-hour monthly maintenance burden to under 10 hours through automated remediation workflows and self-service provisioning.

Red Hat's hybrid cloud strategy aligns with Acme's multi-cloud roadmap, providing consistent operations across AWS and on-premise data centers with unified policy enforcement and compliance reporting.`

    const scorecard = campaignValidator.validate(makeCampaign(paragraphs))
    const check = scorecard.checks.find(c => c.name === 'positioning')
    expect(check?.passed).toBe(true)
  })

  it('scores >= 80 with paragraph-format positioning in full campaign', () => {
    const paragraphs = `OpenShift provides enterprise-grade Kubernetes with built-in security and compliance features that address Acme's regulated manufacturing environment, reducing audit preparation from weeks to automated continuous monitoring.

Ansible Automation Platform integrates seamlessly with OpenShift for Day 2 operations, reducing their current 40-hour monthly maintenance burden to under 10 hours through automated remediation workflows and self-service provisioning.`

    const scorecard = campaignValidator.validate(makeCampaign(paragraphs))
    expect(scorecard.score).toBeGreaterThanOrEqual(80)
  })

  it('fails positioning check when section is empty', () => {
    const scorecard = campaignValidator.validate(makeCampaign(''))
    const check = scorecard.checks.find(c => c.name === 'positioning')
    expect(check?.passed).toBe(false)
  })

  it('fails positioning check with only one short paragraph', () => {
    const scorecard = campaignValidator.validate(makeCampaign('A single short line.'))
    const check = scorecard.checks.find(c => c.name === 'positioning')
    expect(check?.passed).toBe(false)
  })
})
