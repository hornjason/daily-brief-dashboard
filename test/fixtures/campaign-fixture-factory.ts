/**
 * Campaign spec compliance fixtures — 3 factory functions.
 * Each returns { data: StructuredCampaignData, selection: StructuredCampaignSelection }
 * for use with generateCampaignFromStructured().
 *
 * Zero API calls, zero Gemini, pure fixture data.
 * Issue #1096 — council-designed fixture architecture.
 */

import type { StructuredCampaignData, StructuredCampaignSelection, StructuredEmailSelection, ResolvedExec, StructuredPlay } from '../../src/campaign-html-template.ts'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { VoiceProfile } from '../../src/ae-voice.ts'
import type { AccountTeamMember } from '../../src/types.ts'
import type { CustomerObjectiveProfile } from '../../src/modules/intelligence-module.ts'

// ── Shared helpers ──────────────────────────────────────────────────────────

function makeSignal(headline: string, type: 'news' | 'intelligence' = 'intelligence'): Signal {
  return {
    headline,
    type,
    source: 'intelligence',
    detail: `Detail for: ${headline}`,
    timestamp: '2026-08-01',
  }
}

function makeVoiceProfile(): VoiceProfile {
  return {
    aeName: 'Jason Horn',
    characteristics: ['direct', 'technical'],
    promptInstruction: 'Write in a direct, technical tone.',
    detectedFrom: '47 emails across 11 customers',
    detectedAt: '2026-07-01',
    phone: '503-555-0199',
    email: 'jhorn@redhat.com',
    formality: 'professional',
    wordBudget: { exec: 120, manager: 200 },
    assertionLevel: 'collaborative',
  }
}

function makeObjectiveProfile(): CustomerObjectiveProfile {
  return {
    financial: [
      { objective: 'Reduce infrastructure costs by consolidating platforms', metric: '15-20% cost reduction', priority: 'HIGH', source: 'earnings-call', confidence: 'HIGH' },
    ],
    security: [
      { objective: 'Achieve FedRAMP compliance for government contracts', metric: null, priority: 'MED', source: 'intelligence-brief', confidence: 'MEDIUM' },
    ],
    operational: [
      { objective: 'Modernize CI/CD pipelines to reduce deployment cycles', metric: '40% faster deployments', priority: 'HIGH', source: 'intelligence-brief', confidence: 'HIGH' },
    ],
    innovation: [
      { objective: 'Deploy AI inference at the edge for manufacturing QA', metric: null, priority: 'MED', source: 'news', confidence: 'MEDIUM' },
    ],
    growth: [
      { objective: 'Expand into APAC markets with hybrid cloud infrastructure', metric: '3 new regions by 2027', priority: 'LOW', source: 'annual-report', confidence: 'LOW' },
    ],
  }
}

// ── Factory 1: Happy Path ───────────────────────────────────────────────────

export function buildHappyFixture(): { data: StructuredCampaignData; selection: StructuredCampaignSelection } {
  const signals: Signal[] = [
    makeSignal('Infrastructure-as-Code Modernization initiative expanding automation footprint'),
    makeSignal('Cloud Migration Strategy shifting workloads to hybrid architecture', 'news'),
    makeSignal('AI/ML Platform Evaluation for edge inference deployment'),
  ]

  const resolvedExecs: ResolvedExec[] = [
    { name: 'Sarah Chen', title: 'VP Infrastructure', email: 'schen@acmecorp.com', linkedIn: 'https://linkedin.com/in/sarachen' },
    { name: 'Marcus Rivera', title: 'Director of Engineering', email: 'mrivera@acmecorp.com', linkedIn: 'https://linkedin.com/in/marcusrivera' },
    { name: 'Emily Watson', title: 'Senior Manager DevOps', email: 'ewatson@acmecorp.com' },
  ]

  const accountTeam: AccountTeamMember[] = [
    { name: 'Jason Horn', title: 'Account Executive', role: 'ae' },
    { name: 'Alex Kim', title: 'Account Solution Architect', role: 'asa' },
    { name: 'Jordan Lee', title: 'Specialist Solution Provider - Ansible', role: 'ssp' },
  ]

  const structuredPlays: StructuredPlay[] = [
    {
      name: 'SaaS Tax Offset',
      parentTdp: 'TDP-SAAS-001',
      realWorldExamples: [
        { customer: 'Amadeus', outcome: 'replaced Chef SaaS with AAP — $5.62M in benefits, 257.9% ROI' },
        { customer: 'Deutsche Telekom', outcome: 'consolidated 3 automation tools onto AAP — 40% reduction in ops overhead' },
      ],
      extractedMetrics: [
        { value: '$5.62M', context: 'in total economic benefits over 3 years' },
        { value: '257.9%', context: 'ROI from consolidating onto Ansible Automation Platform' },
      ],
    },
  ]

  const data: StructuredCampaignData = {
    resolvedExecs,
    signals,
    voiceProfile: makeVoiceProfile(),
    accountTeam,
    subscriptions: [
      { product: 'RHEL', productDescription: 'Red Hat Enterprise Linux Server', status: 'Active', quantity: 150 },
      { product: 'OCP', productDescription: 'Red Hat OpenShift Container Platform', status: 'Active', quantity: 25 },
    ],
    structuredPlays,
    customerName: 'Acme Corporation',
    materialTitle: 'SaaS Tax Offset Sales Play',
    materialUrl: 'https://docs.google.com/document/d/abc123',
    generatedDate: '2026-08-17',
    fitRationale: 'Acme Corporation is a strong fit because their infrastructure modernization initiative aligns directly with Red Hat automation capabilities.',
    referenceMaterials: [
      { resource: 'SaaS Tax White Paper', url: 'https://www.redhat.com/en/resources/saas-tax-whitepaper', keyTakeaway: 'Key frameworks for calculating SaaS tax exposure' },
    ],
    footprint: {
      current: 'Red Hat Enterprise Linux (Active), Red Hat OpenShift Container Platform (Active)',
      expansion: 'Ansible Automation Platform, Red Hat AI',
    },
    bvTalkingPoints: [
      {
        objective: 'Cost Optimization',
        talkingPoints: 'Consolidating automation tools reduces licensing costs by 15-20%. Self-managed deployment eliminates recurring SaaS fees.',
        keyMetrics: '$5.62M total economic benefits, 257.9% ROI',
      },
    ],
    signalsLoaded: ['intelligence', 'news', 'subscriptions'],
    sourceAttributions: [
      { name: 'SaaS Tax Offset Play', description: 'Primary campaign source material' },
    ],
    aeEmail: 'jhorn@redhat.com',
    aePhone: '503-555-0199',
    campaignThreat: 'rising SaaS licensing costs',
    campaignSolution: 'self-managed automation platform',
    objectiveProfile: makeObjectiveProfile(),
    preMatchedMetrics: [
      {
        recipientName: 'Sarah Chen',
        recipientTitle: 'VP Infrastructure',
        category: 'financial',
        confidence: 0.85,
        entry: { objective: 'Reduce infrastructure costs by consolidating platforms', metric: '15-20% cost reduction', priority: 'HIGH', source: 'earnings-call', confidence: 'HIGH' },
      },
      {
        recipientName: 'Marcus Rivera',
        recipientTitle: 'Director of Engineering',
        category: 'operational',
        confidence: 0.78,
        entry: { objective: 'Modernize CI/CD pipelines to reduce deployment cycles', metric: '40% faster deployments', priority: 'HIGH', source: 'intelligence-brief', confidence: 'HIGH' },
      },
    ],
  }

  const selection: StructuredCampaignSelection = {
    campaignSummary: 'Positioned Red Hat automation to offset rising SaaS licensing costs at Acme Corporation.',
    customerContext: 'Acme Corporation is actively modernizing their infrastructure and evaluating automation platforms to reduce operational overhead.',
    positioning: 'Red Hat Ansible Automation Platform provides a self-managed alternative that eliminates per-node SaaS fees while maintaining enterprise-grade support.',
    emails: [
      {
        recipientName: 'Sarah Chen',
        tier: 'executive',
        intent: 'nurture',
        subject: 'Infrastructure automation trends reshaping enterprise operations',
        signalIndex: 0,
        featureKeys: ['ansible-automation-platform', 'ansible-lightspeed'],
        peerProof: { playName: 'SaaS Tax Offset', exampleIndex: 0 },
      },
      {
        recipientName: 'Marcus Rivera',
        tier: 'manager',
        intent: 'nurture',
        subject: 'How engineering teams are cutting deployment cycles by 40%',
        signalIndex: 1,
        featureKeys: ['ansible-automation-platform', 'openshift-container-platform', 'red-hat-enterprise-linux'],
        peerProof: { playName: 'SaaS Tax Offset', exampleIndex: 1 },
      },
      {
        recipientName: 'Emily Watson',
        tier: 'manager',
        intent: 'expand',
        subject: 'Scaling automation at enterprise level without proportional cost increase',
        signalIndex: 2,
        featureKeys: ['ansible-automation-platform'],
        peerProof: null,
      },
    ],
  }

  return { data, selection }
}

// ── Factory 2: Minimal / Graceful Degradation ───────────────────────────────

export function buildMinimalFixture(): { data: StructuredCampaignData; selection: StructuredCampaignSelection } {
  const signals: Signal[] = [
    makeSignal('Cloud strategy evaluation underway'),
  ]

  const resolvedExecs: ResolvedExec[] = [
    { name: 'John Smith', title: 'CTO' },
  ]

  const data: StructuredCampaignData = {
    resolvedExecs,
    signals,
    voiceProfile: null,
    accountTeam: [
      { name: 'Jane Doe', title: 'Account Executive', role: 'ae' },
    ],
    subscriptions: [],
    structuredPlays: [],
    customerName: 'MinimalCo',
    materialTitle: 'Cloud Strategy Assessment',
    materialUrl: 'https://docs.google.com/document/d/minimal123',
    generatedDate: '2026-08-17',
  }

  const selection: StructuredCampaignSelection = {
    campaignSummary: 'Exploratory outreach for cloud strategy discussion.',
    customerContext: 'MinimalCo is evaluating cloud strategies.',
    positioning: 'Red Hat provides enterprise hybrid cloud solutions.',
    emails: [
      {
        recipientName: 'John Smith',
        tier: 'executive',
        intent: 'nurture',
        subject: 'Cloud strategy approaches for enterprise transformation',
        signalIndex: 0,
        featureKeys: ['openshift-container-platform'],
        peerProof: null,
      },
    ],
  }

  return { data, selection }
}

// ── Factory 3: Adversarial / Poisoned ───────────────────────────────────────

export function buildPoisonedFixture(): { data: StructuredCampaignData; selection: StructuredCampaignSelection } {
  // Signal headlines bypass sanitizeCreepyLines — keep clean for buildOpener fallback
  const signals: Signal[] = [
    makeSignal('Enterprise automation platform evaluation underway'),
    makeSignal('Infrastructure modernization initiative gaining momentum'),
  ]

  const resolvedExecs: ResolvedExec[] = [
    { name: 'Alice Nguyen', title: 'VP Operations', email: 'anguyen@poisonco.com' },
  ]

  const data: StructuredCampaignData = {
    resolvedExecs,
    signals,
    voiceProfile: makeVoiceProfile(),
    accountTeam: [
      { name: 'Jason Horn', title: 'Account Executive', role: 'ae' },
    ],
    subscriptions: [
      { product: 'RHEL', productDescription: 'Red Hat Enterprise Linux', sku: 'RH00004', status: 'Active', quantity: 500 },
    ],
    structuredPlays: [
      {
        name: 'Infrastructure Modernization',
        parentTdp: 'TDP-INFRA-001',
        realWorldExamples: [
          { customer: 'TestCo', outcome: 'consolidated automation tooling for 40% reduction in ops overhead' },
        ],
      },
    ],
    customerName: 'PoisonCo Industries',
    materialTitle: 'Pipeline Acceleration Play',
    materialUrl: 'https://docs.google.com/document/d/poison123',
    generatedDate: '2026-08-17',
    fitRationale: 'PoisonCo has $2.5M pending pipeline and 500 nodes with subscription count of 500.',
    footprint: {
      current: 'NN-1234 — Pipeline RHEL Server (Active)',
      expansion: 'Company intelligence dashboard',
    },
    signalsLoaded: ['intelligence'],
    aeEmail: 'jhorn@redhat.com',
    aePhone: '503-555-0199',
    campaignThreat: 'rising infrastructure costs',
    campaignSolution: 'self-managed automation platform',
    objectiveProfile: {
      financial: [
        { objective: 'Pipeline opportunity value of $2.5M deal pending', metric: '$2.5M pipeline', priority: 'HIGH', source: 'internal', confidence: 'HIGH' },
      ],
      security: [],
      operational: [
        { objective: 'Support case #4521 requires headcount reduction of 200 laid off employees', metric: null, priority: 'HIGH', source: 'internal', confidence: 'HIGH' },
      ],
      innovation: [],
      growth: [
        { objective: 'Expand 1500 instances across 500 nodes with subscription count growth', metric: '1500 instances', priority: 'MED', source: 'internal', confidence: 'MEDIUM' },
      ],
    },
  }

  const selection: StructuredCampaignSelection = {
    campaignSummary: 'Pipeline acceleration targeting $2.5M deal with support case resolution.',
    customerContext: 'PoisonCo has a $2.5M pipeline opportunity with 500 RHEL subscriptions and pending support case #4521. Their workforce reduction of 200 employees signals cost optimization.',
    positioning: 'Red Hat renewal of $500K strengthens the 500 node subscription count with pipeline value acceleration.',
    emails: [
      {
        recipientName: 'Alice Nguyen',
        tier: 'executive',
        intent: 'nurture',
        subject: 'Infrastructure automation trends reshaping operations',
        signalIndex: 0,
        featureKeys: ['ansible-automation-platform'],
        peerProof: { playName: 'Infrastructure Modernization', exampleIndex: 0 },
      },
    ],
  }

  return { data, selection }
}
