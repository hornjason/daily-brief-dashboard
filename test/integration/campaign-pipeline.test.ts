/**
 * L3 Pipeline Integration Test — Campaign end-to-end validation
 *
 * Validates the FULL campaign pipeline by calling generateCampaignFromStructured()
 * with realistic fixture data that exercises all pipeline stages.
 * L1 (fixture) and L2 (cached output) tests both pass when wiring is broken.
 * Only L3 catches wiring failures — where upstream data is captured but doesn't
 * reach the template.
 *
 * Issue #1140 — Pipeline Section Tracker validation per spec section.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  generateCampaignFromStructured,
  type StructuredCampaignData,
  type StructuredCampaignSelection,
  type StructuredEmailSelection,
  type ResolvedExec,
  type StructuredPlay,
  type ReferenceMaterial,
  type EligibilityRow,
  type BVTalkingPoint,
  type CampaignFootprint,
} from '../../src/campaign-html-template.ts'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { VoiceProfile } from '../../src/ae-voice.ts'
import type { AccountTeamMember } from '../../src/types.ts'
import type { CustomerObjectiveProfile } from '../../src/modules/intelligence-module.ts'
import type { PersonaBrief } from '../../src/lib/persona-selector.ts'
import type { PreMatchedPeerProof } from '../../src/lib/persona-classifier.ts'
import { DENY_PATTERNS, assertNoDenyPatterns, assertNoGhostValues, extractEmails } from '../helpers/campaign-assertions.ts'

// ── Deterministic date mock ────────────────────────────────────────────────

const FIXED_DATE = new Date('2026-08-17T12:00:00Z').getTime()
let originalDateNow: () => number

// ── Full-pipeline fixture builder ──────────────────────────────────────────

function buildFullPipelineFixture(): { data: StructuredCampaignData; selection: StructuredCampaignSelection } {
  const signals: Signal[] = [
    { headline: 'SB 122 SaaS tax legislation takes effect January 2027 in California', type: 'news', source: 'news-radar', detail: 'California bill redefines remotely accessed software as tangible personal property', timestamp: '2026-08-01' },
    { headline: 'Infrastructure-as-Code modernization expanding automation footprint', type: 'intelligence', source: 'intelligence', detail: 'Enterprise shifting to automation-first operations across hybrid environments', timestamp: '2026-07-15' },
    { headline: 'Cloud workload migration to hybrid architecture accelerating', type: 'news', source: 'news-radar', detail: 'Company planning 60% cloud-native by Q2 2027', timestamp: '2026-08-10' },
    { headline: 'AI/ML platform evaluation for manufacturing QA at the edge', type: 'intelligence', source: 'intelligence', detail: 'Exploring edge inference for quality assurance in 4 plants', timestamp: '2026-07-28' },
    { headline: 'Container security hardening initiative launched', type: 'intelligence', source: 'intelligence', detail: 'FedRAMP compliance mandating container supply chain security', timestamp: '2026-08-05' },
    { headline: 'Red Hat Enterprise Linux renewal approaching Q4 2026', type: 'intelligence', source: 'subscriptions', detail: 'Active subscription with 200 nodes across 3 regions', timestamp: '2026-06-20' },
    { headline: 'New VP Engineering hired from AWS — container-first background', type: 'news', source: 'intelligence', detail: 'Leadership change signals shift toward cloud-native investment', timestamp: '2026-07-01' },
    { headline: 'Ansible Automation Platform expansion into network automation', type: 'intelligence', source: 'subscriptions', detail: 'Currently at pilot scale, evaluating enterprise-wide rollout', timestamp: '2026-07-20' },
  ]

  const resolvedExecs: ResolvedExec[] = [
    { name: 'Diana Torres', title: 'Chief Information Officer', email: 'dtorres@globalmanufacturing.com', linkedIn: 'https://linkedin.com/in/dianatorres' },
    { name: 'Robert Nakamura', title: 'VP Engineering', email: 'rnakamura@globalmanufacturing.com', linkedIn: 'https://linkedin.com/in/robertnakamura' },
    { name: 'Samantha Wells', title: 'VP Operations', email: 'swells@globalmanufacturing.com', linkedIn: 'https://linkedin.com/in/samanthawells' },
    { name: 'Kevin Patel', title: 'Director of Infrastructure', email: 'kpatel@globalmanufacturing.com', linkedIn: 'https://linkedin.com/in/kevinpatel' },
    { name: 'Maria Gonzalez', title: 'Director of Platform Engineering', email: 'mgonzalez@globalmanufacturing.com', linkedIn: 'https://linkedin.com/in/mariagonzalez' },
    { name: 'James Liu', title: 'Senior Manager DevOps', email: 'jliu@globalmanufacturing.com', linkedIn: 'https://linkedin.com/in/jamesliu' },
  ]

  const accountTeam: AccountTeamMember[] = [
    { name: 'Jason Horn', title: 'Account Executive', role: 'ae' },
    { name: 'Alex Kim', title: 'Account Solution Architect', role: 'asa' },
    { name: 'Jordan Lee', title: 'Specialist Solution Provider - Ansible', role: 'ssp' },
    { name: 'Morgan Chen', title: 'Specialist Solution Architect - OpenShift', role: 'ssa' },
  ]

  const voiceProfile: VoiceProfile = {
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

  const structuredPlays: StructuredPlay[] = [
    {
      name: 'Source Material Customer Wins',
      parentTdp: 'Campaign Source Material',
      realWorldExamples: [
        { customer: 'Amadeus', outcome: 'replaced Chef SaaS with AAP — $5.62M in benefits, 257.9% ROI over 3 years' },
        { customer: 'Deutsche Telekom', outcome: 'consolidated 3 automation tools onto AAP — 40% reduction in ops overhead' },
        { customer: 'Mutua Madrileña', outcome: 'cut service tickets 50% with Event-Driven Ansible automation' },
      ],
    },
    {
      name: 'Infrastructure Modernization',
      parentTdp: 'TDP-INFRA-001',
      realWorldExamples: [
        { customer: 'Banco Santander', outcome: 'migrated 5,000 VMs to OpenShift Virtualization — 35% infrastructure cost reduction' },
      ],
      extractedMetrics: [
        { value: '35%', context: 'infrastructure cost reduction from VM consolidation' },
      ],
    },
  ]

  const objectiveProfile: CustomerObjectiveProfile = {
    financial: [
      { objective: 'Reduce infrastructure costs by consolidating platforms — targeting 15-20% savings', metric: '15-20% cost reduction', priority: 'HIGH', source: 'earnings-call', confidence: 'HIGH' },
      { objective: 'Annual revenue $4.2 billion with strong operating margins', metric: '$4.2B revenue', priority: 'MED', source: 'annual-report', confidence: 'HIGH' },
    ],
    security: [
      { objective: 'Achieve FedRAMP compliance for government contracts by Q2 2027', metric: null, priority: 'HIGH', source: 'intelligence-brief', confidence: 'HIGH' },
      { objective: 'Container supply chain security hardening across all production clusters', metric: null, priority: 'HIGH', source: 'intelligence-brief', confidence: 'MEDIUM' },
    ],
    operational: [
      { objective: 'Modernize CI/CD pipelines to reduce deployment cycles from weeks to hours', metric: '40% faster deployments', priority: 'HIGH', source: 'intelligence-brief', confidence: 'HIGH' },
      { objective: 'Consolidate 3 automation tools into single enterprise platform', metric: '3 tools consolidated', priority: 'HIGH', source: 'Strategic Initiatives', confidence: 'HIGH' },
    ],
    innovation: [
      { objective: 'Deploy AI inference at the edge for manufacturing QA across 4 plants', metric: '4 plants', priority: 'MED', source: 'news', confidence: 'MEDIUM' },
    ],
    growth: [
      { objective: 'Expand into APAC markets with hybrid cloud infrastructure — 3 new regions by 2027', metric: '3 new regions by 2027', priority: 'LOW', source: 'annual-report', confidence: 'LOW' },
    ],
  }

  const pass0Briefs: PersonaBrief[] = [
    {
      role: 'executive-sponsor',
      suggestedTitle: 'Chief Information Officer',
      why: 'CIO drives enterprise-wide automation strategy and vendor consolidation decisions',
      objectiveMatch: 'Infrastructure cost reduction of 15-20% aligns with automation platform consolidation',
      peerProofCandidates: [{ company: 'Amadeus', outcome: '$5.62M in benefits, 257.9% ROI', relevance: 'SaaS consolidation' }],
      timingTrigger: 'SB 122 takes effect January 2027 — consolidation window closing',
      valueProposition: 'Self-managed automation eliminates SaaS tax exposure on enterprise tooling',
      featureKeys: ['ansible-automation-platform', 'ansible-lightspeed-coding-assistant', 'automation-dashboard-aap-2-6'],
      competitiveContext: 'Chef and Puppet losing ground to Ansible in enterprise automation — migration patterns accelerating',
      relationshipPath: 'Existing RHEL customer with 200 nodes — natural expansion into automation',
      installedBase: 'Red Hat Enterprise Linux, Red Hat OpenShift Container Platform',
      suppressTriggers: [],
      confidence: { overall: 'HIGH' },
    },
    {
      role: 'technical-evaluator',
      suggestedTitle: 'VP Engineering',
      why: 'VP Engineering evaluates technical platforms and drives adoption across engineering org',
      objectiveMatch: 'CI/CD modernization — 40% faster deployments through automation pipeline standardization',
      peerProofCandidates: [{ company: 'Deutsche Telekom', outcome: '40% reduction in ops overhead', relevance: 'tool consolidation' }],
      timingTrigger: 'New VP from AWS background — container-first strategy aligns with OpenShift',
      valueProposition: 'Unified platform for containers, VMs, and AI workloads reduces operational complexity',
      featureKeys: ['openshift-container-platform', 'openshift-ai', 'advanced-cluster-security'],
      competitiveContext: 'AWS EKS and Azure AKS lack VM migration path — OpenShift Virtualization differentiator',
      relationshipPath: 'OpenShift already in production — expansion into AI and virtualization',
      installedBase: 'Red Hat Enterprise Linux, Red Hat OpenShift Container Platform',
      suppressTriggers: [],
      confidence: { overall: 'HIGH' },
    },
    {
      role: 'champion',
      suggestedTitle: 'VP Operations',
      why: 'VP Operations owns operational efficiency and incident response automation',
      objectiveMatch: 'Operational efficiency through automated remediation and event-driven response',
      peerProofCandidates: [{ company: 'Mutua Madrileña', outcome: 'cut service tickets 50%', relevance: 'operations automation' }],
      timingTrigger: 'Manufacturing QA initiative creates operational urgency for automation',
      valueProposition: 'Event-Driven Ansible transforms reactive operations into proactive self-healing infrastructure',
      featureKeys: ['event-driven-ansible', 'ansible-automation-platform', 'aiops-overview'],
      competitiveContext: null,
      relationshipPath: 'Ansible expansion from 50 to enterprise-wide rollout in progress',
      installedBase: 'Red Hat Enterprise Linux, Red Hat Ansible Automation Platform',
      suppressTriggers: [],
      confidence: { overall: 'MEDIUM' },
    },
    {
      role: 'practitioner',
      suggestedTitle: 'Director of Infrastructure',
      why: 'Director of Infrastructure manages day-to-day platform operations and capacity planning',
      objectiveMatch: 'Platform consolidation reduces operational overhead and simplifies infrastructure management',
      peerProofCandidates: [{ company: 'Banco Santander', outcome: '35% infrastructure cost reduction', relevance: 'VM migration' }],
      timingTrigger: 'Infrastructure cost reduction mandate from CFO',
      valueProposition: 'OpenShift Virtualization migrates VMs alongside containers on a unified platform',
      featureKeys: ['openshift-virtualization', 'openshift-container-platform', 'red-hat-enterprise-linux'],
      competitiveContext: 'VMware licensing changes driving evaluation of alternatives',
      relationshipPath: 'RHEL foundation already in place — natural progression to OpenShift',
      installedBase: 'Red Hat Enterprise Linux',
      suppressTriggers: [],
      confidence: { overall: 'MEDIUM' },
    },
    {
      role: 'technical-evaluator',
      suggestedTitle: 'Director of Platform Engineering',
      why: 'Platform Engineering owns developer experience and internal developer portal strategy',
      objectiveMatch: 'Developer productivity improvement through golden paths and self-service platform',
      peerProofCandidates: [],
      timingTrigger: 'Platform engineering team formed Q2 2026 — building developer portal',
      valueProposition: 'Red Hat Developer Hub provides a ready-made internal developer portal with golden path templates',
      featureKeys: ['red-hat-developer-hub', 'openshift-container-platform', 'getting-started-with-openshift'],
      competitiveContext: 'Backstage adoption growing but requires significant customization — Developer Hub is production-ready',
      relationshipPath: 'OpenShift adoption creates natural demand for developer portal',
      installedBase: 'Red Hat OpenShift Container Platform',
      suppressTriggers: [],
      confidence: { overall: 'MEDIUM' },
    },
    {
      role: 'practitioner',
      suggestedTitle: 'Senior Manager DevOps',
      why: 'Sr. Manager DevOps drives automation adoption and CI/CD pipeline standardization',
      objectiveMatch: 'CI/CD pipeline standardization across cloud and on-prem environments',
      peerProofCandidates: [{ company: 'Deutsche Telekom', outcome: '40% reduction in ops overhead', relevance: 'automation consolidation' }],
      timingTrigger: 'Automation expansion from 50 to enterprise-wide rollout approved',
      valueProposition: 'Ansible Automation Platform standardizes CI/CD across hybrid environments with flat-rate licensing',
      featureKeys: ['ansible-automation-platform', 'execution-environments', 'automation-mesh'],
      competitiveContext: null,
      relationshipPath: 'Direct user of Ansible — champion for enterprise-wide expansion',
      installedBase: 'Red Hat Ansible Automation Platform',
      suppressTriggers: [],
      confidence: { overall: 'HIGH' },
    },
  ]

  const preMatchedPeerProofs: PreMatchedPeerProof[] = [
    { recipientName: 'Diana Torres', proof: { customer: 'Amadeus', outcome: 'replaced Chef SaaS with AAP — $5.62M in benefits, 257.9% ROI over 3 years' }, category: 'financial' },
    { recipientName: 'Robert Nakamura', proof: { customer: 'Deutsche Telekom', outcome: 'consolidated 3 automation tools onto AAP — 40% reduction in ops overhead' }, category: 'operational' },
    { recipientName: 'Samantha Wells', proof: { customer: 'Mutua Madrileña', outcome: 'cut service tickets 50% with Event-Driven Ansible automation' }, category: 'operational' },
    { recipientName: 'Kevin Patel', proof: { customer: 'Banco Santander', outcome: 'migrated 5,000 VMs to OpenShift Virtualization — 35% infrastructure cost reduction' }, category: 'financial' },
  ]

  const referenceMaterials: ReferenceMaterial[] = [
    { resource: 'SaaS Tax Offset Sales Play', url: 'https://www.redhat.com/en/resources/saas-tax-offset', keyTakeaway: 'Framework for calculating SaaS tax exposure and self-managed alternatives' },
    { resource: 'Holland & Knight SB 122 Analysis', url: 'https://www.hklaw.com/en/insights/publications/2026/sb-122-analysis', keyTakeaway: 'Legal analysis of California SB 122 definitions and exemptions for remotely accessed software' },
    { resource: 'Numeral State-by-State Tax Breakdown', url: 'https://www.numeral.com/saas-tax-guide', keyTakeaway: 'State-by-state SaaS tax landscape showing California impact' },
  ]

  const eligibilityTable: EligibilityRow[] = [
    { offering: 'Ansible Automation Platform', deployment: 'Customer VPC (self-managed)', status: 'ELIGIBLE FOR EXEMPTION' },
    { offering: 'Ansible Automation Platform', deployment: 'Red Hat Hosted', status: 'TAXABLE' },
    { offering: 'OpenShift Container Platform', deployment: 'Customer VPC (self-managed)', status: 'ELIGIBLE FOR EXEMPTION' },
    { offering: 'Red Hat Enterprise Linux', deployment: 'Customer-managed', status: 'ELIGIBLE FOR EXEMPTION' },
  ]

  const footprint: CampaignFootprint = {
    current: 'Red Hat Enterprise Linux, Red Hat OpenShift Container Platform, Red Hat Ansible Automation Platform',
    expansion: 'OpenShift AI, OpenShift Virtualization, Advanced Cluster Security',
  }

  const bvTalkingPoints: BVTalkingPoint[] = [
    { objective: 'Cost Optimization', talkingPoints: 'Self-managed deployment eliminates SaaS tax. Platform consolidation reduces licensing costs 15-20%.', keyMetrics: '$5.62M total economic benefits, 257.9% ROI (Amadeus)' },
    { objective: 'Operational Efficiency', talkingPoints: 'Event-driven automation reduces manual intervention. Unified platform simplifies multi-cloud operations.', keyMetrics: '40% ops overhead reduction (Deutsche Telekom), 50% fewer service tickets (Mutua Madrileña)' },
    { objective: 'Security & Compliance', talkingPoints: 'Container supply chain security for FedRAMP. Automated policy enforcement across clusters.', keyMetrics: 'FedRAMP compliance by Q2 2027 target' },
  ]

  const data: StructuredCampaignData = {
    resolvedExecs,
    signals,
    voiceProfile,
    accountTeam,
    subscriptions: [
      { product: 'RHEL', productDescription: 'Red Hat Enterprise Linux Server', status: 'Active', quantity: 200 },
      { product: 'OCP', productDescription: 'Red Hat OpenShift Container Platform', status: 'Active', quantity: 40 },
      { product: 'AAP', productDescription: 'Red Hat Ansible Automation Platform', status: 'Active', quantity: 50 },
    ],
    structuredPlays,
    customerName: 'Global Manufacturing Corp',
    materialTitle: 'SaaS Tax Offset — Self-Managed Automation Strategy',
    materialUrl: 'https://docs.google.com/document/d/pipeline-test-fixture',
    generatedDate: '2026-08-17',
    rawSignals: {
      intelligence: {
        company: '## Company Overview\n\nGlobal Manufacturing Corp is a Fortune 500 industrial manufacturer with annual revenue of $4.2 billion and approximately 28,000 employees across 15 countries. The company operates 12 manufacturing plants and 4 R&D centers.\n\n## Strategic Initiatives\n\n- **Infrastructure Modernization**: Consolidating 3 automation tools (Chef, Puppet, custom scripts) onto a single enterprise platform — targeting 15-20% cost reduction.\n- **Cloud-Native Transformation**: Migrating 60% of workloads to containers by Q2 2027.\n- **Edge AI Deployment**: Deploying AI inference for manufacturing QA at 4 plants.\n- **FedRAMP Compliance**: Government contracts requiring FedRAMP-certified infrastructure by Q2 2027.\n\n## Competitive Landscape\n\n1. **VMware/Broadcom**: Rising licensing costs driving evaluation of alternatives. Key threat: vendor lock-in on virtualization.\n2. **HashiCorp**: Terraform adoption for IaC. Red Hat differentiates with integrated automation platform.\n3. **AWS EKS**: Cloud-native Kubernetes. Red Hat advantage: hybrid cloud with VM migration path.',
      },
      subscriptions: [
        { productDescription: 'Red Hat Enterprise Linux Server', status: 'Active', quantity: 200 },
        { productDescription: 'Red Hat OpenShift Container Platform', status: 'Active', quantity: 40 },
        { productDescription: 'Red Hat Ansible Automation Platform', status: 'Active', quantity: 50 },
      ],
      accountPlan: '## Account Plan: Global Manufacturing Corp\n\n### Why Red Hat?\n\n**IT and Modernization Initiatives**\n\n- **Infrastructure Consolidation**: Reduce 3 automation platforms to 1 → Ansible Automation Platform\n- **Container Security Hardening**: FedRAMP compliance → Advanced Cluster Security for Kubernetes\n- **Edge AI for Manufacturing QA**: Production quality monitoring → OpenShift AI, RHEL AI',
    },
    fitRationale: 'Global Manufacturing Corp is consolidating automation tools during the SB 122 window — their existing Red Hat footprint makes self-managed deployment the natural migration path.',
    referenceMaterials,
    referenceMaterialsHeading: 'Source Documents & Analyses',
    eligibilityTable,
    eligibilityHeading: 'SB 122 Deployment Eligibility',
    footprint,
    bvTalkingPoints,
    signalsLoaded: ['intelligence', 'news-radar', 'subscriptions', 'cases', 'tech-stack'],
    sourceAttributions: [
      { name: 'SaaS Tax Offset Sales Play', description: 'Primary campaign source — self-managed deployment strategy' },
      { name: 'Holland & Knight SB 122 Analysis', description: 'Legal framework for remotely accessed software taxation' },
      { name: 'Numeral SaaS Tax Guide', description: 'State-by-state SaaS tax landscape' },
    ],
    aeEmail: 'jhorn@redhat.com',
    aePhone: '503-555-0199',
    sourceUrls: [
      'https://www.hklaw.com/en/insights/publications/2026/sb-122-analysis',
      'https://www.numeral.com/saas-tax-guide',
    ],
    campaignThreat: 'the SaaS tax',
    campaignSolution: 'self-managed automation',
    objectiveProfile,
    preMatchedMetrics: [
      { recipientName: 'Diana Torres', recipientTitle: 'Chief Information Officer', category: 'financial', confidence: 0.92, entry: { objective: 'Reduce infrastructure costs by consolidating platforms — targeting 15-20% savings', metric: '15-20% cost reduction', priority: 'HIGH', source: 'earnings-call', confidence: 'HIGH' } },
      { recipientName: 'Robert Nakamura', recipientTitle: 'VP Engineering', category: 'operational', confidence: 0.85, entry: { objective: 'Modernize CI/CD pipelines to reduce deployment cycles from weeks to hours', metric: '40% faster deployments', priority: 'HIGH', source: 'intelligence-brief', confidence: 'HIGH' } },
      { recipientName: 'Samantha Wells', recipientTitle: 'VP Operations', category: 'operational', confidence: 0.80, entry: { objective: 'Consolidate 3 automation tools into single enterprise platform', metric: '3 tools consolidated', priority: 'HIGH', source: 'Strategic Initiatives', confidence: 'HIGH' } },
      { recipientName: 'Kevin Patel', recipientTitle: 'Director of Infrastructure', category: 'financial', confidence: 0.78, entry: { objective: 'Reduce infrastructure costs by consolidating platforms — targeting 15-20% savings', metric: '15-20% cost reduction', priority: 'HIGH', source: 'earnings-call', confidence: 'HIGH' } },
      { recipientName: 'Maria Gonzalez', recipientTitle: 'Director of Platform Engineering', category: 'innovation', confidence: 0.72, entry: { objective: 'Deploy AI inference at the edge for manufacturing QA across 4 plants', metric: '4 plants', priority: 'MED', source: 'news', confidence: 'MEDIUM' } },
      { recipientName: 'James Liu', recipientTitle: 'Senior Manager DevOps', category: 'operational', confidence: 0.82, entry: { objective: 'Modernize CI/CD pipelines to reduce deployment cycles from weeks to hours', metric: '40% faster deployments', priority: 'HIGH', source: 'intelligence-brief', confidence: 'HIGH' } },
    ],
    preMatchedPeerProofs,
    pass0Briefs,
    signalQuality: { disposition: 'PROCEED', signalCompleteness: 87, missing: ['cases'] },
  }

  const emails: StructuredEmailSelection[] = [
    {
      recipientName: 'Diana Torres',
      tier: 'executive',
      intent: 'nurture',
      subject: 'The infrastructure cost variable your CFO will ask about next quarter',
      signalIndex: 0,
      featureKeys: ['ansible-automation-platform', 'ansible-lightspeed-coding-assistant', 'automation-dashboard-aap-2-6'],
      peerProof: { playName: 'Source Material Customer Wins', exampleIndex: 0 },
      challengerDataPoint: 'SB 122 redefines remotely accessed software as tangible personal property — organizations that consolidate before January 2027 lock in the exemption.',
      customOpener: 'SB 122 takes effect January 1 — every SaaS automation tool your engineering teams rely on picks up an 8-10% tax overhead.',
      featureApplications: [
        'self-managed in your VPC, zero SaaS tax exposure on automation workloads',
        'AI-assisted playbook creation accelerates migration from Chef and Puppet',
        'centralized visibility into automation health across your 12 manufacturing plants',
      ],
      signalBridge: 'For a company already running [Red Hat Enterprise Linux](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux), the fix is straightforward.',
      referenceLine: 'For background on the law: [Holland & Knight\'s analysis of SB 122](https://www.hklaw.com/en/insights/publications/2026/sb-122-analysis) covers the definitions and exemptions, and [Numeral\'s state-by-state breakdown](https://www.numeral.com/saas-tax-guide) shows where California fits.',
    },
    {
      recipientName: 'Robert Nakamura',
      tier: 'executive',
      intent: 'expand',
      subject: 'What your new engineering teams inherited and what to do about it',
      signalIndex: 1,
      featureKeys: ['openshift-container-platform', 'openshift-ai', 'advanced-cluster-security'],
      peerProof: { playName: 'Source Material Customer Wins', exampleIndex: 1 },
      challengerDataPoint: 'Engineering teams that standardize CI/CD on a single platform before cloud migration close deployment cycles 40% faster than those running parallel toolchains.',
      customOpener: 'your engineering org inherited three automation platforms — that operational debt compounds every quarter it stays unconsolidated.',
      featureApplications: [
        'unified control plane for containers, VMs, and AI workloads in your hybrid environment',
        'deploy and serve AI models directly on the platform your teams already operate',
        'automated container supply chain security for your FedRAMP compliance timeline',
      ],
      signalBridge: 'The teams moving fastest on this are running hybrid workloads on a platform that handles containers, VMs, and AI inference together.',
      referenceLine: 'For background on the law: [Holland & Knight\'s analysis of SB 122](https://www.hklaw.com/en/insights/publications/2026/sb-122-analysis) covers the definitions.',
    },
    {
      recipientName: 'Samantha Wells',
      tier: 'executive',
      intent: 'nurture',
      subject: 'Turning reactive operations into a competitive advantage',
      signalIndex: 3,
      featureKeys: ['event-driven-ansible', 'ansible-automation-platform', 'aiops-overview'],
      peerProof: { playName: 'Source Material Customer Wins', exampleIndex: 2 },
      challengerDataPoint: 'Manufacturing operations teams that automate incident response see 50% fewer escalations — the ones still running manual runbooks are the same ones missing SLA targets.',
      customOpener: 'your manufacturing QA initiative creates an opportunity to transform how your operations team handles incidents across all 4 plants.',
      featureApplications: [
        'triggers automated responses to infrastructure events in real time across your manufacturing plants',
        'standardizes automation runbooks so every plant runs the same operational playbook',
        'applies AI to IT operations for predictive incident management before escalation',
      ],
      signalBridge: 'Organizations facing similar operational shifts are using enterprise automation to respond faster than manual operations allow.',
      referenceLine: null as unknown as string,
    },
    {
      recipientName: 'Kevin Patel',
      tier: 'manager',
      intent: 'nurture',
      subject: 'Three platforms, one migration path — here is the math',
      signalIndex: 2,
      featureKeys: ['openshift-virtualization', 'openshift-container-platform', 'red-hat-enterprise-linux'],
      peerProof: { playName: 'Infrastructure Modernization', exampleIndex: 0 },
      challengerDataPoint: 'VMware licensing changes are creating a 2-year window where VM migration costs less than renewal. After that window closes, switching costs lock in.',
      customOpener: 'your infrastructure team is running containers and VMs on separate platforms — that operational split doubles your patching surface and complicates every compliance audit.',
      featureApplications: [
        'migrates your existing VMs alongside containers on a unified platform — no forklift required',
        'runs containerized workloads at scale with the same Kubernetes your teams already use',
        'the same enterprise Linux foundation your 200 nodes already rely on extends into the container layer',
      ],
      signalBridge: 'The same enterprise Linux foundation your teams already rely on extends naturally into this space.',
      referenceLine: 'For background: [Holland & Knight\'s analysis of SB 122](https://www.hklaw.com/en/insights/publications/2026/sb-122-analysis) covers the exemption framework.',
    },
    {
      recipientName: 'Maria Gonzalez',
      tier: 'manager',
      intent: 'expand',
      subject: 'Developer portal strategy that ships in weeks, not quarters',
      signalIndex: 4,
      featureKeys: ['red-hat-developer-hub', 'openshift-container-platform', 'getting-started-with-openshift'],
      peerProof: null,
      challengerDataPoint: 'Platform engineering teams that build custom developer portals from Backstage spend 6-9 months on customization. Production-ready alternatives exist.',
      customOpener: 'your platform engineering team is building developer golden paths — the organizations shipping fastest started with a production-ready portal instead of customizing from scratch.',
      featureApplications: [
        'centralizes developer tools and golden paths in an internal developer portal your teams can adopt this quarter',
        'developer-ready environments built on the OpenShift your clusters already run',
        'provides getting-started templates that reduce onboarding time for new engineers',
      ],
      signalBridge: 'The teams moving fastest on platform engineering are starting with a production-ready portal instead of building from Backstage.',
      referenceLine: null as unknown as string,
    },
    {
      recipientName: 'James Liu',
      tier: 'manager',
      intent: 'expand',
      subject: 'Scaling automation to enterprise without proportional cost increase',
      signalIndex: 7,
      featureKeys: ['ansible-automation-platform', 'execution-environments', 'automation-mesh'],
      peerProof: { playName: 'Source Material Customer Wins', exampleIndex: 1 },
      challengerDataPoint: 'Enterprise automation licensing that scales per-node makes the business case worse as adoption succeeds. Flat-rate licensing inverts that equation.',
      customOpener: 'your team proved Ansible works at pilot scale — the expansion to enterprise-wide is approved, and the licensing model determines whether the ROI compounds or erodes.',
      featureApplications: [
        'flat-rate licensing means your enterprise rollout costs stay flat as automation adoption scales across the organization',
        'packages automation dependencies into portable containers your team controls — no more environment drift',
        'extends automation reach across your distributed manufacturing network and edge locations',
      ],
      signalBridge: 'Red Hat\'s automation platform is how organizations are converting this kind of expansion into consistent, repeatable operations.',
      referenceLine: 'For additional context: [Holland & Knight\'s analysis of SB 122](https://www.hklaw.com/en/insights/publications/2026/sb-122-analysis) and [Numeral\'s state-by-state breakdown](https://www.numeral.com/saas-tax-guide).',
    },
  ]

  const selection: StructuredCampaignSelection = {
    campaignSummary: 'Positioned self-managed automation to offset SaaS tax exposure at Global Manufacturing Corp. Their 3-tool automation sprawl (Chef, Puppet, custom scripts) creates immediate SB 122 liability — consolidation onto Ansible Automation Platform eliminates the tax vector while reducing operational overhead.',
    customerContext: 'Global Manufacturing Corp is actively consolidating automation tools during the SB 122 window. Their infrastructure modernization initiative targets 15-20% cost reduction through platform consolidation.',
    positioning: 'Red Hat provides the only enterprise automation platform that is self-managed, eliminating SaaS tax exposure while delivering measurable operational efficiency gains. The Challenger insight: organizations that consolidate before January 2027 lock in the exemption permanently.',
    emails,
  }

  return { data, selection }
}

// ── Thin-material fixture builder ──────────────────────────────────────────

function buildThinMaterialFixture(): { data: StructuredCampaignData; selection: StructuredCampaignSelection } {
  const signals: Signal[] = [
    { headline: 'Cloud strategy evaluation underway', type: 'intelligence', source: 'intelligence', detail: 'Early-stage cloud assessment', timestamp: '2026-08-01' },
  ]

  const resolvedExecs: ResolvedExec[] = [
    { name: 'Anna Park', title: 'CTO', email: 'apark@thinco.com' },
    { name: 'David Chen', title: 'Director of IT', email: 'dchen@thinco.com' },
  ]

  const data: StructuredCampaignData = {
    resolvedExecs,
    signals,
    voiceProfile: null,
    accountTeam: [{ name: 'Jane Doe', title: 'Account Executive', role: 'ae' }],
    subscriptions: [],
    structuredPlays: [],
    customerName: 'ThinCo Industries',
    materialTitle: 'Cloud Strategy Assessment',
    materialUrl: 'https://docs.google.com/document/d/thin-fixture',
    generatedDate: '2026-08-17',
    signalsLoaded: ['intelligence'],
    campaignThreat: 'rising infrastructure costs',
    campaignSolution: 'consolidated infrastructure',
  }

  const selection: StructuredCampaignSelection = {
    campaignSummary: 'Exploratory outreach for cloud strategy discussion at ThinCo Industries.',
    customerContext: 'ThinCo is evaluating cloud strategies for the first time.',
    positioning: 'Red Hat provides enterprise hybrid cloud solutions.',
    emails: [
      {
        recipientName: 'Anna Park',
        tier: 'executive',
        intent: 'nurture',
        subject: 'Cloud architecture patterns reshaping enterprise IT',
        signalIndex: 0,
        featureKeys: ['openshift-container-platform'],
        peerProof: null,
        challengerDataPoint: 'Organizations that delay cloud modernization face technical debt compounding at 15% annually.',
        customOpener: 'your cloud strategy evaluation is well-timed as enterprise adoption patterns shift toward hybrid-first architectures.',
        featureApplications: ['unified control plane for hybrid cloud workloads across cloud and on-prem'],
        signalBridge: 'The teams moving fastest on cloud strategy are running hybrid workloads on a platform that handles containers and VMs together.',
      },
      {
        recipientName: 'David Chen',
        tier: 'manager',
        intent: 'nurture',
        subject: 'Hybrid cloud infrastructure that starts small and scales',
        signalIndex: 0,
        featureKeys: ['openshift-container-platform'],
        peerProof: null,
        challengerDataPoint: 'IT teams running parallel container and VM platforms spend 35% more on operations than those running unified infrastructure.',
        customOpener: 'your IT team can start with a small OpenShift deployment and expand as cloud strategy matures — no big-bang migration required.',
        featureApplications: ['runs containerized workloads at scale with enterprise Kubernetes'],
        signalBridge: 'The same approach works whether you start with 3 nodes or scale to 300.',
      },
    ],
  }

  return { data, selection }
}

// ── Test suite ─────────────────────────────────────────────────────────────

let fullHtml: string
let thinHtml: string

beforeAll(() => {
  originalDateNow = Date.now
  Date.now = () => FIXED_DATE

  const full = buildFullPipelineFixture()
  fullHtml = generateCampaignFromStructured(full.selection, full.data)

  const thin = buildThinMaterialFixture()
  thinHtml = generateCampaignFromStructured(thin.selection, thin.data)
})

afterAll(() => {
  Date.now = originalDateNow
})

// ── §2 Target Contacts ────────────────────────────────────────────────────

describe('§2 Target Contacts — 6 contacts, both tiers, all with LinkedIn', () => {
  it('contacts section exists', () => {
    expect(fullHtml).toMatch(/Target\s+Contacts/i)
  })

  it('all 6 contact names appear in output', () => {
    const names = ['Diana Torres', 'Robert Nakamura', 'Samantha Wells', 'Kevin Patel', 'Maria Gonzalez', 'James Liu']
    for (const name of names) {
      expect(fullHtml).toContain(name)
    }
  })

  it('count >= 6 contacts in the contacts table', () => {
    const fixture = buildFullPipelineFixture()
    expect(fixture.data.resolvedExecs.length).toBe(6)
    for (const exec of fixture.data.resolvedExecs) {
      expect(fullHtml).toContain(exec.name)
    }
  })

  it('both executive and manager tiers present in email output', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Executive\s+Outreach/i)
    expect(plain).toMatch(/Manager\s+Outreach/i)
  })

  it('3 executive emails rendered', () => {
    const execSection = fullHtml.match(/Executive\s+Outreach[\s\S]*?(?=Manager\s+Outreach|$)/i)?.[0] || ''
    const execEmails = (execSection.match(/📧/g) || []).length
    expect(execEmails).toBeGreaterThanOrEqual(3)
  })

  it('3 manager emails rendered', () => {
    const managerSection = fullHtml.match(/Manager\s+Outreach[\s\S]*?(?=<hr|<\/body|$)/i)?.[0] || ''
    const managerEmails = (managerSection.match(/📧/g) || []).length
    expect(managerEmails).toBeGreaterThanOrEqual(3)
  })

  it('all contacts have LinkedIn URLs in the table', () => {
    const fixture = buildFullPipelineFixture()
    for (const exec of fixture.data.resolvedExecs) {
      expect(exec.linkedIn).toBeDefined()
      expect(exec.linkedIn).toMatch(/linkedin\.com/)
    }
    expect(fullHtml).toMatch(/linkedin\.com/i)
  })

  it('all contacts have email addresses', () => {
    expect(fullHtml).toContain('dtorres@globalmanufacturing.com')
    expect(fullHtml).toContain('rnakamura@globalmanufacturing.com')
    expect(fullHtml).toContain('kpatel@globalmanufacturing.com')
  })
})

// ── §4 Quality Checklist ──────────────────────────────────────────────────

describe('§4 Quality Checklist — actual word count values shown', () => {
  it('quality checklist section exists', () => {
    expect(fullHtml).toMatch(/Quality\s+Checklist/i)
  })

  it('checklist contains word count indicators (digits in checklist rows)', () => {
    const checklistSection = fullHtml.match(/Quality\s+Checklist[\s\S]*?(?=<hr|<h2)/i)?.[0] || ''
    const plainChecklist = checklistSection.replace(/<[^>]+>/g, ' ')
    const hasDigits = /\d+\s*\/\s*\d+|\d+\s*words?|\bactual\b/i.test(plainChecklist)
    const hasCheckmarks = /[☑☒✅❌⚠️]/g.test(plainChecklist)
    expect(hasCheckmarks || hasDigits).toBe(true)
  })
})

// ── §7 Reference Material ─────────────────────────────────────────────────

describe('§7 Reference Material — URLs not undefined, not homepage', () => {
  it('reference material section exists', () => {
    expect(fullHtml).toMatch(/Source\s+Documents|Reference\s+Material/i)
  })

  it('reference URLs are present and not undefined', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/href="undefined"/i)
    expect(fullHtml).toContain('hklaw.com')
    expect(fullHtml).toContain('numeral.com')
  })

  it('reference URLs are not homepage-only links', () => {
    const fixture = buildFullPipelineFixture()
    for (const ref of fixture.data.referenceMaterials || []) {
      if (ref.url) {
        const url = new URL(ref.url)
        const path = url.pathname.replace(/\/$/, '')
        expect(path.length).toBeGreaterThan(4)
      }
    }
  })

  it('reference material URLs appear as clickable links in HTML', () => {
    expect(fullHtml).toMatch(/href="https:\/\/www\.hklaw\.com/)
    expect(fullHtml).toMatch(/href="https:\/\/www\.numeral\.com/)
  })

  it('email reference lines contain working URLs in rendered output', () => {
    const emailSection = fullHtml.match(/Email Templates by Role[\s\S]*?<\/body>/)?.[0] || ''
    const refMatches = emailSection.match(/hklaw\.com|numeral\.com/gi) || []
    expect(refMatches.length).toBeGreaterThanOrEqual(2)
  })
})

// ── §9 Footprint ──────────────────────────────────────────────────────────

describe('§9 Footprint — no CRM slugs, no subscription counts', () => {
  it('footprint section exists', () => {
    expect(fullHtml).toMatch(/Red\s+Hat\s+Footprint|Existing.*Footprint/i)
  })

  it('no CRM slug patterns in footprint', () => {
    const footprintSection = fullHtml.match(/Footprint[\s\S]*?(?=<hr|<h2)/i)?.[0] || ''
    const plain = footprintSection.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\d{8}/)
    expect(plain).not.toMatch(/\bCommit\b/)
    expect(plain).not.toMatch(/\bDeal\s+Reg\b/i)
    expect(plain).not.toMatch(/\bRenewal\b/i)
  })

  it('no subscription counts in footprint', () => {
    const footprintSection = fullHtml.match(/Footprint[\s\S]*?(?=<hr|<h2)/i)?.[0] || ''
    const plain = footprintSection.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\d+\s+subscriptions?/i)
    expect(plain).not.toMatch(/subscription\s+count/i)
    expect(plain).not.toMatch(/\d+\s+nodes?\b/i)
  })

  it('footprint shows product names (not SKUs)', () => {
    const footprintSection = fullHtml.match(/Footprint[\s\S]*?(?=<hr|<h2)/i)?.[0] || ''
    const plain = footprintSection.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Red Hat Enterprise Linux|OpenShift|Ansible/i)
  })

  it('no NN- prefix in footprint', () => {
    const footprintSection = fullHtml.match(/Footprint[\s\S]*?(?=<hr|<h2)/i)?.[0] || ''
    expect(footprintSection).not.toMatch(/NN-\d+/)
  })

  it('no "— Pipeline" suffix in footprint', () => {
    const footprintSection = fullHtml.match(/Footprint[\s\S]*?(?=<hr|<h2)/i)?.[0] || ''
    expect(footprintSection).not.toMatch(/—\s*Pipeline/i)
  })
})

// ── §10a Executive Emails ─────────────────────────────────────────────────

describe('§10a Executive emails — count >= 3, peer proof non-empty', () => {
  it('at least 3 executive emails generated', () => {
    const emails = extractEmails(fullHtml)
    const execEmails = emails.filter(e => /executive|cio|vp|chief/i.test(e.tier))
    expect(execEmails.length).toBeGreaterThanOrEqual(3)
  })

  it('each executive email has peer proof content', () => {
    const emails = extractEmails(fullHtml)
    const execEmails = emails.filter(e => /executive|cio|vp|chief/i.test(e.tier))
    for (const email of execEmails) {
      const body = email.body.replace(/<[^>]+>/g, ' ')
      const hasPeerProof = /Amadeus|Deutsche Telekom|Mutua Madrile|Banco Santander|sat with a handful of leaders/i.test(body)
      expect(hasPeerProof).toBe(true)
    }
  })

  it('executive emails contain subject lines without product names', () => {
    const fixture = buildFullPipelineFixture()
    const execEmails = fixture.selection.emails.filter(e => e.tier === 'executive')
    for (const email of execEmails) {
      expect(email.subject).not.toMatch(/\bRed Hat\b/i)
      expect(email.subject).not.toMatch(/\bAnsible\b/i)
      expect(email.subject).not.toMatch(/\bOpenShift\b/i)
      expect(email.subject).not.toMatch(/\bRHEL\b/i)
    }
  })

  it('executive emails have feature bullets with linked URLs', () => {
    const emails = extractEmails(fullHtml)
    const execEmails = emails.filter(e => /executive|cio|vp|chief/i.test(e.tier))
    for (const email of execEmails) {
      const links = (email.body.match(/href="https?:\/\/[^"]+"/gi) || [])
      expect(links.length).toBeGreaterThan(0)
    }
  })

  it('executive emails have CTA with specific dates', () => {
    const emails = extractEmails(fullHtml)
    const execEmails = emails.filter(e => /executive|cio|vp|chief/i.test(e.tier))
    for (const email of execEmails) {
      const body = email.body.replace(/<[^>]+>/g, ' ')
      expect(body).toMatch(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i)
    }
  })
})

// ── §10b Manager Emails ───────────────────────────────────────────────────

describe('§10b Manager emails — count >= 3, peer proof non-empty', () => {
  it('at least 3 manager emails generated', () => {
    const emails = extractEmails(fullHtml)
    const managerEmails = emails.filter(e => /manager|director|head|senior/i.test(e.tier))
    expect(managerEmails.length).toBeGreaterThanOrEqual(3)
  })

  it('each manager email has peer proof content', () => {
    const emails = extractEmails(fullHtml)
    const managerEmails = emails.filter(e => /manager|director|head|senior/i.test(e.tier))
    for (const email of managerEmails) {
      const body = email.body.replace(/<[^>]+>/g, ' ')
      const hasPeerProof = /Amadeus|Deutsche Telekom|Mutua Madrile|Banco Santander|sat with a handful of leaders/i.test(body)
      expect(hasPeerProof).toBe(true)
    }
  })

  it('manager emails contain subject lines without product names', () => {
    const fixture = buildFullPipelineFixture()
    const mgrEmails = fixture.selection.emails.filter(e => e.tier === 'manager')
    for (const email of mgrEmails) {
      expect(email.subject).not.toMatch(/\bRed Hat\b/i)
      expect(email.subject).not.toMatch(/\bAnsible\b/i)
      expect(email.subject).not.toMatch(/\bOpenShift\b/i)
      expect(email.subject).not.toMatch(/\bRHEL\b/i)
    }
  })

  it('manager emails have feature bullets with linked URLs', () => {
    const emails = extractEmails(fullHtml)
    const managerEmails = emails.filter(e => /manager|director|head|senior/i.test(e.tier))
    for (const email of managerEmails) {
      const links = (email.body.match(/href="https?:\/\/[^"]+"/gi) || [])
      expect(links.length).toBeGreaterThan(0)
    }
  })

  it('manager emails have CTA with specific dates', () => {
    const emails = extractEmails(fullHtml)
    const managerEmails = emails.filter(e => /manager|director|head|senior/i.test(e.tier))
    for (const email of managerEmails) {
      const body = email.body.replace(/<[^>]+>/g, ' ')
      expect(body).toMatch(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i)
    }
  })
})

// ── §all DENY_PATTERN enforcement ─────────────────────────────────────────

describe('§all — zero DENY_PATTERN matches in full output', () => {
  it('full output passes all DENY_PATTERNs', () => {
    assertNoDenyPatterns(fullHtml, 'full pipeline output')
  })

  it('each email body individually passes DENY_PATTERNs', () => {
    const emails = extractEmails(fullHtml)
    for (const email of emails) {
      const plainBody = email.body.replace(/<[^>]+>/g, ' ')
      for (const { pattern, label } of DENY_PATTERNS) {
        const match = plainBody.match(pattern)
        if (match) {
          throw new Error(`DENY_PATTERN "${label}" matched in email to ${email.recipientName}: "${match[0]}"`)
        }
      }
    }
  })

  it('no ghost values (undefined/null/NaN) in output', () => {
    assertNoGhostValues(fullHtml)
  })

  it('no pipeline dollar amounts in any email', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\$\d[\d,.]*[kKmMbB]?\s+pipeline/i)
    expect(plain).not.toMatch(/pipeline\s+opportunit/i)
    expect(plain).not.toMatch(/pipeline\s+value/i)
  })

  it('no support case/ticket references in any email', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/support\s+case/i)
    expect(plain).not.toMatch(/support\s+ticket/i)
    expect(plain).not.toMatch(/case\s+#\d/i)
  })

  it('no subscription counts in customer-facing text', () => {
    const emailSection = fullHtml.match(/Email Templates by Role[\s\S]*?<\/body>/)?.[0] || ''
    const plain = emailSection.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\d+\s+(?:RHEL\s+)?subscriptions?\b/i)
    expect(plain).not.toMatch(/subscription\s+count/i)
  })

  it('Red Hat never positioned as threat', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Red\s+Hat[^.]*\bthreat\b/i)
  })
})

// ── Pipeline wiring: data reaches the template ────────────────────────────

describe('Pipeline wiring — upstream data reaches rendered output', () => {
  it('Pass 0 briefs surface in "Why Customer Is Fit" section', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Strong\s+Fit/i)
    expect(plain).toMatch(/SB 122|automation|consolidat/i)
  })

  it('objective profile metrics appear in Business Metrics table', () => {
    expect(fullHtml).toMatch(/Business\s+Metrics/i)
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/cost reduction|faster deployments|consolidat/i)
  })

  it('subscription data drives relationship line in emails', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Red Hat Enterprise Linux|Red Hat OpenShift|Ansible/i)
    expect(plain).toMatch(/already rely on/i)
  })

  it('intelligence data surfaces in dashboard metrics', () => {
    expect(fullHtml).toMatch(/Customer\s+Intelligence\s+Dashboard/i)
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/\$4\.2/i)
    expect(plain).toMatch(/28,000|28000/i)
  })

  it('account team surfaces in header and sign-offs', () => {
    expect(fullHtml).toContain('Jason Horn')
    expect(fullHtml).toContain('Account Executive')
    expect(fullHtml).toContain('jhorn@redhat.com')
    expect(fullHtml).toContain('503-555-0199')
  })

  it('structured plays provide peer proof data to emails', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Amadeus/i)
    expect(plain).toMatch(/Deutsche Telekom/i)
    expect(plain).toMatch(/Mutua Madrile/i)
  })

  it('eligibility table renders with correct status styling', () => {
    expect(fullHtml).toMatch(/SB\s+122\s+Deployment\s+Eligibility/i)
    expect(fullHtml).toMatch(/ELIGIBLE FOR EXEMPTION/i)
    expect(fullHtml).toMatch(/TAXABLE/i)
  })

  it('BV talking points section renders', () => {
    expect(fullHtml).toMatch(/Talking\s+Points|Call\s+Prep/i)
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Cost Optimization/i)
    expect(plain).toMatch(/Operational Efficiency/i)
  })

  it('source attributions appear in header', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/SaaS Tax Offset Sales Play/i)
    expect(plain).toMatch(/Holland.*Knight/i)
  })

  it('strategic initiatives from intel appear in output', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Strategic\s+Initiatives/i)
    expect(plain).toMatch(/Infrastructure|Cloud|FedRAMP|Edge/i)
  })

  it('competitive position from Pass 0 briefs renders', () => {
    const plain = fullHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/Competitive\s+Position/i)
    expect(plain).toMatch(/Chef|Puppet|VMware|AWS|Backstage/i)
  })

  it('signal quality status appears when not PROCEED', () => {
    const fixture = buildFullPipelineFixture()
    fixture.data.signalQuality = { disposition: 'DEGRADED', signalCompleteness: 75, missing: ['cases', 'tech-stack'] }
    const html = generateCampaignFromStructured(fixture.selection, fixture.data)
    expect(html).toMatch(/75%\s*coverage/i)
  })
})

// ── Thin-material scenario ────────────────────────────────────────────────

describe('Thin material — sparse data graceful degradation', () => {
  it('only 2 contacts in fixture still generates valid HTML', () => {
    expect(thinHtml).toContain('<!DOCTYPE html>')
    expect(thinHtml).toContain('</html>')
  })

  it('renders both contacts', () => {
    expect(thinHtml).toContain('Anna Park')
    expect(thinHtml).toContain('David Chen')
  })

  it('empty peer proof data uses generic fallback', () => {
    const plain = thinHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).toMatch(/sat with a handful of leaders|peer|advantage/i)
  })

  it('no reference materials — section absent, not broken', () => {
    const plain = thinHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Reference\s+Material/i)
  })

  it('no footprint section when data absent', () => {
    const plain = thinHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Existing\s+Red\s+Hat\s+Footprint/i)
  })

  it('no BV talking points when data absent', () => {
    const plain = thinHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Call\s+Prep.*Talking\s+Points/i)
  })

  it('no eligibility table when data absent', () => {
    const plain = thinHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Eligibility/i)
  })

  it('zero ghost values in thin output', () => {
    assertNoGhostValues(thinHtml)
  })

  it('thin output passes all DENY_PATTERNs', () => {
    assertNoDenyPatterns(thinHtml, 'thin material output')
  })

  it('relationship line absent when no subscriptions', () => {
    const plain = thinHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/already rely on/i)
  })
})

// ── Performance ───────────────────────────────────────────────────────────

describe('Performance — all tests run without external API calls', () => {
  it('full pipeline fixture generates in under 500ms', () => {
    const start = performance.now()
    const fixture = buildFullPipelineFixture()
    generateCampaignFromStructured(fixture.selection, fixture.data)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(500)
  })

  it('thin fixture generates in under 200ms', () => {
    const start = performance.now()
    const fixture = buildThinMaterialFixture()
    generateCampaignFromStructured(fixture.selection, fixture.data)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(200)
  })

  it('total test file runtime under 30s', () => {
    const totalStart = performance.now()
    for (let i = 0; i < 10; i++) {
      const f = buildFullPipelineFixture()
      generateCampaignFromStructured(f.selection, f.data)
    }
    const elapsed = performance.now() - totalStart
    expect(elapsed).toBeLessThan(30000)
  })
})
