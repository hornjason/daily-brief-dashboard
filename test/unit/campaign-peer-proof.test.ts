/**
 * Regression test for #853: Campaign peer proof variation
 * All 6 emails should NOT cite the same peer proof.
 */

import { describe, it, expect } from 'bun:test'
import { campaignValidator } from '../../src/quality-validators/campaign-validator.ts'

// ── Structured fixtures ────────────────────────────────────────────────────

function makeStructuredCampaign(peerProofs: (string | null)[]) {
  return JSON.stringify({
    campaignSummary: 'Campaign targeting Acme Corp with Red Hat OpenShift for cloud-native transformation across multiple business units.',
    customerContext: 'Acme Corp is evaluating container orchestration after a Kubernetes pilot. VP Infra presented at KubeCon. Pipeline renewal of $2.1M in Q3.',
    positioning: 'Challenger Insight: Hidden gap in container security at scale. OpenShift addresses enterprise Kubernetes with built-in compliance automation.',
    emails: peerProofs.map((proof, i) => ({
      persona: ['CIO', 'VP Infra', 'Director IT', 'Director Ops', 'VP Security', 'Head DevOps'][i] ?? `Persona ${i}`,
      tier: i < 3 ? 'executive' : 'manager',
      subject: `Email subject line number ${i + 1} about infrastructure`,
      body: `Your teams are building container fundamentals. Based on your Red Hat Enterprise Linux foundation, OpenShift provides a natural extension with built-in security scanning. Capability ${i + 1} is relevant for your environment where audit and compliance matter. Automated remediation workflows detect and resolve issues before they escalate. Self-healing patterns reduce mean time to resolution from hours to minutes across the hybrid infrastructure.`,
      peerProof: proof,
      actionStep: `Carolanne should schedule a briefing by next Friday to discuss the transition plan for area ${i + 1}`,
    })),
  })
}

// ── Markdown fixture helper ────────────────────────────────────────────────

function makeMarkdownCampaign(peerProofs: (string | null)[]) {
  const personas = [
    { name: 'VP Infrastructure', tier: 'Executive Tier' },
    { name: 'VP Operations', tier: 'Executive Tier' },
    { name: 'CIO', tier: 'Executive Tier' },
    { name: 'Director DevOps', tier: 'Manager Tier' },
    { name: 'Director IT', tier: 'Manager Tier' },
    { name: 'Head of Security', tier: 'Manager Tier' },
  ]

  let md = `## Campaign Summary
This campaign positions Red Hat OpenShift for Acme Corp's cloud-native transformation and upcoming $2.1M pipeline renewal.

## Customer Context
Acme Corp is a $2.1B manufacturing company undergoing digital transformation. Their VP of Infrastructure presented at KubeCon about hybrid cloud goals. Pipeline renewal of $2.1M in Q3.

## Positioning
- Challenger Insight: Hidden gap in container security at scale. OpenShift provides enterprise Kubernetes with built-in compliance automation for regulated industries
- Ansible Automation Platform integrates with OpenShift for Day 2 operations
- Red Hat hybrid cloud strategy aligns with their multi-cloud roadmap

`

  for (let i = 0; i < peerProofs.length; i++) {
    const p = personas[i] ?? { name: `Persona ${i}`, tier: 'Executive Tier' }
    const proof = peerProofs[i]
    md += `## ${p.name} — ${p.tier}
Subject: Email subject about infrastructure challenges ${i + 1}

Hi there,

Your team is building strong container fundamentals. Based on your existing Red Hat Enterprise Linux foundation, OpenShift provides a natural extension with built-in security and compliance.

Red Hat's approach provides:
- [Built-in security scanning](https://www.redhat.com/en/technologies/cloud-computing/openshift): scanning and compliance automation feature ${i}
- [Multi-cluster management](https://www.redhat.com/en/technologies/cloud-computing/openshift): multi-cluster feature ${i}
- [Automated remediation](https://www.redhat.com/en/technologies/management/ansible): remediation feature ${i}

${proof ? `Peer proof: ${proof}` : ''}

Carolanne should schedule a briefing by next Friday to discuss transition.

`
  }
  return md
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('campaign peer proof variation (#853)', () => {
  describe('structured JSON validation', () => {
    it('fails when all emails cite the same peer proof', () => {
      const campaign = makeStructuredCampaign([
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
      ])
      const scorecard = campaignValidator.validate(campaign)
      const check = scorecard.checks.find(c => c.name === 'varied-peer-proof')
      expect(check).toBeDefined()
      expect(check?.passed).toBe(false)
    })

    it('passes when emails have varied peer proofs', () => {
      const campaign = makeStructuredCampaign([
        'MAPFRE reduced incidents by 40%',
        'Beta Inc consolidated 3 compliance tools',
        'Gamma Corp cut deployment time 60%',
        null,
        'Delta Ltd automated 80% of remediation',
        null,
      ])
      const scorecard = campaignValidator.validate(campaign)
      const check = scorecard.checks.find(c => c.name === 'varied-peer-proof')
      expect(check).toBeDefined()
      expect(check?.passed).toBe(true)
    })

    it('passes when fewer than 2 emails have non-null peer proof', () => {
      const campaign = makeStructuredCampaign([
        'MAPFRE reduced incidents by 40%',
        null,
        null,
        null,
        null,
        null,
      ])
      const scorecard = campaignValidator.validate(campaign)
      const check = scorecard.checks.find(c => c.name === 'varied-peer-proof')
      expect(check).toBeDefined()
      expect(check?.passed).toBe(true)
    })

    it('passes when all peer proofs are null', () => {
      const campaign = makeStructuredCampaign([null, null, null, null])
      const scorecard = campaignValidator.validate(campaign)
      const check = scorecard.checks.find(c => c.name === 'varied-peer-proof')
      expect(check).toBeDefined()
      expect(check?.passed).toBe(true)
    })
  })

  describe('markdown validation', () => {
    it('fails when all emails cite the same peer proof', () => {
      const campaign = makeMarkdownCampaign([
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
        'MAPFRE reduced incidents by 40%',
      ])
      const scorecard = campaignValidator.validate(campaign)
      const check = scorecard.checks.find(c => c.name === 'varied-peer-proof')
      expect(check).toBeDefined()
      expect(check?.passed).toBe(false)
    })

    it('passes when emails have varied peer proofs', () => {
      const campaign = makeMarkdownCampaign([
        'MAPFRE reduced incidents by 40%',
        'Beta Inc consolidated 3 compliance tools',
        'Gamma Corp cut deployment time 60%',
        null,
        'Delta Ltd automated 80% of remediation',
        null,
      ])
      const scorecard = campaignValidator.validate(campaign)
      const check = scorecard.checks.find(c => c.name === 'varied-peer-proof')
      expect(check).toBeDefined()
      expect(check?.passed).toBe(true)
    })

    it('passes when fewer than 2 emails have peer proof in markdown', () => {
      const campaign = makeMarkdownCampaign([
        'MAPFRE reduced incidents by 40%',
        null,
        null,
        null,
        null,
        null,
      ])
      const scorecard = campaignValidator.validate(campaign)
      const check = scorecard.checks.find(c => c.name === 'varied-peer-proof')
      expect(check).toBeDefined()
      expect(check?.passed).toBe(true)
    })
  })
})
