/**
 * Unit tests for email entity extraction — GitHub Issue #476
 * Tests pure keyword/regex extraction with no Gemini dependency.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { extractEmailEntities, _resetTriggerTechsForTesting } from '../../src/lib/email-entity-extractor.ts'

beforeEach(() => {
  _resetTriggerTechsForTesting()
})

describe('extractEmailEntities', () => {
  describe('techMentions', () => {
    test('extracts VMware trigger tech from body text', () => {
      const result = extractEmailEntities(
        'We are currently running VMware vSphere across 200 hosts and considering migration options.',
        'Infrastructure Review'
      )
      expect(result.techMentions).toContain('VMware')
      expect(result.techMentions).toContain('vSphere')
    })

    test('extracts Kubernetes-related trigger techs', () => {
      const result = extractEmailEntities(
        'Our team is evaluating EKS vs AKS for our container platform standardization.',
        'Container Platform Decision'
      )
      expect(result.techMentions).toContain('EKS')
      expect(result.techMentions).toContain('AKS')
    })

    test('extracts techs from subject line as well', () => {
      const result = extractEmailEntities(
        'Please find the attached requirements document.',
        'Terraform to Ansible Migration Plan'
      )
      expect(result.techMentions).toContain('Terraform')
    })

    test('deduplicates tech mentions', () => {
      const result = extractEmailEntities(
        'VMware licensing is expensive. We discussed VMware migration last week.',
        'VMware Discussion'
      )
      const vmwareCount = result.techMentions.filter(t => t === 'VMware').length
      expect(vmwareCount).toBeLessThanOrEqual(1)
    })

    test('returns empty array when no techs found', () => {
      const result = extractEmailEntities(
        'Looking forward to our meeting next Tuesday.',
        'Quick sync'
      )
      expect(result.techMentions).toEqual([])
    })
  })

  describe('productMentions', () => {
    test('extracts Red Hat product names', () => {
      const result = extractEmailEntities(
        'We deployed OpenShift last quarter and are now looking at Ansible for automation.',
        'Product update'
      )
      expect(result.productMentions).toContain('OpenShift')
      expect(result.productMentions).toContain('Ansible')
    })

    test('extracts short product acronyms case-sensitively', () => {
      const result = extractEmailEntities(
        'Our OCP cluster is running well. RHEL servers need patching. The AAP controller is deployed.',
        'Status update'
      )
      expect(result.productMentions).toContain('OCP')
      expect(result.productMentions).toContain('RHEL')
      expect(result.productMentions).toContain('AAP')
    })

    test('does not match short acronyms case-insensitively', () => {
      // "aap" in lowercase should NOT match AAP (3-char rule)
      const result = extractEmailEntities(
        'the aap guidelines require compliance review.',
        'Compliance'
      )
      expect(result.productMentions).not.toContain('AAP')
    })

    test('extracts multi-word product names', () => {
      const result = extractEmailEntities(
        'We are evaluating OpenShift AI for our ML workloads and Red Hat Enterprise Linux for the base OS.',
        'Evaluation'
      )
      expect(result.productMentions).toContain('OpenShift AI')
      expect(result.productMentions).toContain('Red Hat Enterprise Linux')
    })

    test('detects products present in product-vocabulary config', () => {
      // RHACS and RHACM were added to vocabulary (#681)
      const result = extractEmailEntities(
        'RHACS is handling our supply chain security and RHACM manages multi-cluster.',
        'Security review'
      )
      expect(result.productMentions).toContain('RHACS')
      expect(result.productMentions).toContain('RHACM')
    })
  })

  describe('competitiveMentions', () => {
    test('extracts competitor names', () => {
      const result = extractEmailEntities(
        'We currently use Splunk for logging and ServiceNow for ITSM.',
        'Current stack'
      )
      expect(result.competitiveMentions).toContain('Splunk')
      expect(result.competitiveMentions).toContain('ServiceNow')
    })

    test('extracts cloud provider competitors', () => {
      const result = extractEmailEntities(
        'Our AWS spend is growing and we also have Azure workloads.',
        'Cloud costs'
      )
      expect(result.competitiveMentions).toContain('AWS')
      expect(result.competitiveMentions).toContain('Azure')
    })

    test('short competitor names require case-sensitive match', () => {
      // "aws" lowercase should NOT match AWS (3-char)
      const result = extractEmailEntities(
        'the aws of the situation requires careful handling.',
        'Discussion'
      )
      expect(result.competitiveMentions).not.toContain('AWS')
    })

    test('extracts Docker and Rancher', () => {
      const result = extractEmailEntities(
        'They are using Docker for container runtime and Rancher for cluster management.',
        'Tech assessment'
      )
      expect(result.competitiveMentions).toContain('Docker')
      expect(result.competitiveMentions).toContain('Rancher')
    })
  })

  describe('actionItems', () => {
    test('extracts action patterns from email', () => {
      const result = extractEmailEntities(
        'Can we schedule a demo next week? I would like to set up a POC environment for evaluation.',
        'Next steps'
      )
      expect(result.actionItems).toContain('demo')
      expect(result.actionItems).toContain('poc')
      expect(result.actionItems).toContain('evaluation')
    })

    test('extracts follow-up and proposal', () => {
      const result = extractEmailEntities(
        'Please send the proposal by Friday. We need a follow-up meeting to discuss.',
        'Action items'
      )
      expect(result.actionItems).toContain('proposal')
      expect(result.actionItems).toContain('follow-up')
    })

    test('extracts proof of concept as full phrase', () => {
      const result = extractEmailEntities(
        'The team approved moving forward with a proof of concept for the automation platform.',
        'Approval'
      )
      expect(result.actionItems).toContain('proof of concept')
    })

    test('deduplicates action items', () => {
      const result = extractEmailEntities(
        'Schedule a demo. The demo should cover all features. Please schedule the demo for next week.',
        'Demo request'
      )
      const demoCount = result.actionItems.filter(a => a === 'demo').length
      expect(demoCount).toBe(1)
    })

    test('extracts next steps', () => {
      const result = extractEmailEntities(
        'Here are the next steps from our meeting.',
        'Meeting recap'
      )
      expect(result.actionItems).toContain('next steps')
    })

    test('returns empty when no actions found', () => {
      const result = extractEmailEntities(
        'Thank you for the information. Have a great weekend.',
        'Re: Info'
      )
      expect(result.actionItems).toEqual([])
    })
  })

  describe('word boundary matching', () => {
    test('does not match "Go" inside "going"', () => {
      // "Go" is not in our keyword lists, but this tests the boundary principle
      // Use a real short keyword: "AWS" should not match inside "BAWS" or "AWSOME"
      const result = extractEmailEntities(
        'The BAWS system processed the request through AWSOME pipeline.',
        'System update'
      )
      expect(result.competitiveMentions).not.toContain('AWS')
    })

    test('matches exact word boundaries', () => {
      const result = extractEmailEntities(
        'We use AWS for cloud. Docker containers run on RHEL.',
        'Infrastructure'
      )
      expect(result.competitiveMentions).toContain('AWS')
      expect(result.competitiveMentions).toContain('Docker')
      expect(result.productMentions).toContain('RHEL')
    })
  })

  describe('combined extraction', () => {
    test('extracts all entity types from a realistic email', () => {
      const body = `Hi team,

Following up on our discussion about migrating from VMware to OpenShift.
We currently run vSphere 7.0 across our data centers with about 500 VMs.
Our RHEL footprint is growing and we want to standardize on Ansible for automation.
The Splunk team is also interested in how this integrates with their SIEM.

Can we schedule a demo of OpenShift Virtualization? We'd like to run a POC
in Q3 with the goal of having a proposal ready by end of quarter.

Also, our AWS spend is significant and we want to explore CPPO options.

Thanks,
Mike`

      const result = extractEmailEntities(body, 'Re: VMware Migration Planning')

      // Tech mentions (from solution-plays triggers)
      expect(result.techMentions).toContain('VMware')
      expect(result.techMentions).toContain('vSphere')

      // Product mentions
      expect(result.productMentions).toContain('OpenShift')
      expect(result.productMentions).toContain('RHEL')
      expect(result.productMentions).toContain('Ansible')
      expect(result.productMentions).toContain('OpenShift Virtualization')

      // Competitor mentions
      expect(result.competitiveMentions).toContain('Splunk')
      expect(result.competitiveMentions).toContain('AWS')

      // Action items
      expect(result.actionItems).toContain('demo')
      expect(result.actionItems).toContain('poc')
      expect(result.actionItems).toContain('proposal')
    })
  })
})
