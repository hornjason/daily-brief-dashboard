import { describe, it, expect } from 'bun:test'
import { deriveThreatSolution } from '../../src/campaign-service.ts'

describe('deriveThreatSolution', () => {
  it('matches SaaS tax pattern', () => {
    const result = deriveThreatSolution('Ansible Prospecting and the Upcoming SaaS Tax', 'SB 122 takes effect January 1')
    expect(result.threat).toBe('the SaaS tax')
  })

  it('matches vendor lock-in for VMware/Broadcom content', () => {
    const result = deriveThreatSolution('Migrating from VMware', 'Broadcom acquisition changes licensing')
    expect(result.threat).toBe('vendor lock-in and rising licensing costs')
  })

  it('matches OpenShift migration to container platform solution', () => {
    const result = deriveThreatSolution('OpenShift Migration Strategy', 'container platform modernization')
    expect(result.solution).toBe('a unified container platform')
  })

  it('matches Ansible content to automation solution', () => {
    const result = deriveThreatSolution('Ansible Automation Platform', 'automation across hybrid environments')
    expect(result.solution).toBe('self-managed automation')
  })

  it('matches security breach threat', () => {
    const result = deriveThreatSolution('Security Posture Review', 'recent data breach in the industry')
    expect(result.threat).toBe('security breach exposure')
  })

  it('matches RHEL to enterprise Linux solution', () => {
    const result = deriveThreatSolution('RHEL Standardization', 'enterprise linux foundation')
    expect(result.solution).toBe('a standardized enterprise Linux foundation')
  })

  it('matches AI/ML content to enterprise AI solution', () => {
    const result = deriveThreatSolution('AI Model Serving', 'machine learning platform evaluation')
    expect(result.solution).toBe('an enterprise AI platform')
  })

  it('matches compliance threat', () => {
    const result = deriveThreatSolution('Compliance Review', 'new regulation requirements audit')
    expect(result.threat).toBe('compliance requirements')
  })

  it('matches cloud cost threat', () => {
    const result = deriveThreatSolution('Cloud Strategy', 'cloud spend optimization and cloud migration')
    expect(result.threat).toBe('uncontrolled cloud costs')
  })

  it('matches technical debt threat', () => {
    const result = deriveThreatSolution('Platform Modernization', 'legacy system modernization initiative')
    expect(result.threat).toBe('technical debt')
  })

  it('returns generic defaults for unknown input', () => {
    const result = deriveThreatSolution('General Business Update', 'quarterly review meeting notes')
    expect(result.threat).toBe('rising infrastructure costs')
    expect(result.solution).toBe('consolidated infrastructure')
  })

  it('never includes Red Hat product names in threat output', () => {
    const productNames = ['ansible', 'openshift', 'rhel', 'red hat', 'stackrox', 'acs']
    const testCases = [
      { title: 'Ansible Prospecting', content: 'SaaS tax exposure' },
      { title: 'OpenShift Migration', content: 'container modernization' },
      { title: 'RHEL Standardization', content: 'enterprise linux' },
      { title: 'ACS Security', content: 'security breach' },
      { title: 'General Topic', content: 'unknown content' },
    ]

    for (const tc of testCases) {
      const result = deriveThreatSolution(tc.title, tc.content)
      const threatLower = result.threat.toLowerCase()
      for (const product of productNames) {
        expect(threatLower).not.toContain(product)
      }
    }
  })

  it('matches security solution for ACS/StackRox content', () => {
    const result = deriveThreatSolution('Advanced Cluster Security', 'stackrox integration for vulnerability scanning')
    expect(result.solution).toBe('integrated security across the stack')
  })
})
