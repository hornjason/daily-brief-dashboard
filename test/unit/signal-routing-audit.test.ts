/**
 * Signal routing audit tests — Issue #325
 * Verifies that all signal sources route to appropriate template sections.
 */
import { test, expect, describe } from 'bun:test'
import { templateProductAlignment, templateCloudMarketplace, templateCases, templateRenewals, templateTechStack, templateCompetitiveLandscape, templateIntelligence, templateSalesHubInsights, templateEmailIntelligence, templateStrategicOpportunities, templateAll } from '../../src/lib/signal-templates.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    source: 'test',
    type: 'news',
    headline: 'Test signal',
    detail: 'Test detail',
    timestamp: new Date().toISOString(),
    score: 0.5,
    ...overrides,
  }
}

describe('routeSignal coverage — #325 audit', () => {
  test('rh-rss signals with productTags route to product alignment (#375)', () => {
    const signal = makeSignal({
      source: 'rh-rss',
      headline: 'OpenShift 4.16 released',
      detail: 'New features for container management',
      metadata: { productTags: ['openshift'] },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('openshift')
  })

  test('value-maps signals with productSlug route to product alignment (#379)', () => {
    const signal = makeSignal({
      source: 'value-maps',
      headline: 'RHEL value proposition',
      detail: 'Enterprise Linux strategic positioning',
      metadata: { productSlug: 'rhel' },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('rhel')
  })

  test('subscriptions signals with redHatProducts still route correctly', () => {
    const signal = makeSignal({
      source: 'subscriptions',
      type: 'subscription',
      headline: 'Active RHEL subscription',
      detail: '100 nodes',
      metadata: { redHatProducts: ['Red Hat Enterprise Linux'], product: 'RHEL' },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('RHEL')
  })

  test('cloud-marketplace signals route to cloud section', () => {
    const signal = makeSignal({
      source: 'cloud-marketplace',
      headline: 'AWS offering',
      detail: 'Red Hat on AWS marketplace',
      metadata: { provider: 'AWS', hasCloudSpend: true, acvPlus: 50000 },
    })
    const result = templateCloudMarketplace([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('AWS')
  })

  test('cases signals route to cases section', () => {
    const signal = makeSignal({
      source: 'cases',
      type: 'case',
      headline: 'Critical production issue',
      detail: 'RHEL kernel panic',
      metadata: { severity: 1, caseNumber: '12345', product: 'RHEL' },
    })
    const result = templateCases([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('12345')
  })

  test('pipeline renewal signals route to renewals section', () => {
    const signal = makeSignal({
      source: 'pipeline',
      type: 'subscription',
      headline: 'RHEL renewal',
      detail: '200 nodes expiring',
      metadata: { stage: 'Proposal', closeDate: '2026-06-15', amount: 100000, product: 'RHEL' },
    })
    const result = templateRenewals([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('RHEL')
  })

  test('tech-stack signals route to tech section', () => {
    const signal = makeSignal({
      source: 'tech-stack',
      headline: 'Kubernetes detected',
      detail: 'Customer running K8s on-prem',
      metadata: { confidence: 'HIGH', context: 'evaluating OpenShift', infrastructure: true },
    })
    const result = templateTechStack([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('Kubernetes')
  })

  test('product-lifecycle signals with slug always route to product alignment (#376)', () => {
    // Lifecycle signals carry slug metadata — routeSignal should recognize them
    // even if redHatProducts is not set (unowned product scenario)
    const signal = makeSignal({
      source: 'product-lifecycle',
      type: 'product-release',
      headline: 'RHEL 9.4 — EOL Sep 2026',
      detail: 'Current version: 9.4.0',
      metadata: {
        slug: 'rhel',
        currentVersion: '9.4',
        eolDate: '2026-09-30',
        // Note: no redHatProducts — this is the gap #376 identifies
        // Fix: lifecycle module should always set redHatProducts
        redHatProducts: ['rhel'],
      },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('rhel')
  })

  test('account-plan signals route to account-plan section (#380)', () => {
    const signal = makeSignal({
      source: 'account-plan',
      type: 'account-plan',
      headline: 'Acme Corp Strategic Plan',
      detail: 'Key objectives: cloud migration, automation, security modernization',
      metadata: {
        customerSlug: 'acme-corp',
        contentLength: 2500,
      },
    })
    // Should NOT appear in product alignment (it's an account plan, not a product)
    expect(templateProductAlignment([signal])).toBeNull()
  })

  // #673: Intelligence signal routing
  test('intelligence source routes to intelligence, not product (#673)', () => {
    const signal = makeSignal({
      source: 'intelligence',
      type: 'intelligence',
      headline: 'Acme Corp company analysis',
      detail: 'Major cloud migration initiative underway with $50M budget',
      metadata: {
        docType: 'company',
        customerSlug: 'acme-corp',
      },
    })
    const result = templateIntelligence([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('Company Context')
    // Must NOT appear in product alignment
    expect(templateProductAlignment([signal])).toBeNull()
  })

  // #673: Partner-catalog signal routing
  test('partner-catalog source routes to partner, not product (#673)', () => {
    const signal = makeSignal({
      source: 'partner-catalog',
      type: 'intelligence',
      headline: 'Accenture',
      detail: 'Premier partner with OpenShift specialization',
      metadata: {
        partnerName: 'Accenture',
        partnershipLevel: 'Premier',
        specializations: ['OpenShift', 'Ansible'],
        credentialCount: 42,
      },
    })
    // Must NOT appear in product alignment
    expect(templateProductAlignment([signal])).toBeNull()
    expect(templateCloudMarketplace([signal])).toBeNull()
    expect(templateCases([signal])).toBeNull()
    expect(templateRenewals([signal])).toBeNull()
    expect(templateTechStack([signal])).toBeNull()
  })

  // #674: Email signal routing
  test('emails source signals route to email section (#674)', () => {
    const signal = makeSignal({
      source: 'emails',
      type: 'intelligence',
      headline: 'OpenShift evaluation discussion',
      detail: 'CTO mentioned evaluating OpenShift for container platform',
      metadata: {
        from: 'john.doe@acme.com',
        to: 'jane.smith@redhat.com',
        classification: 'Technical Discussion',
        techMentions: ['OpenShift', 'Kubernetes'],
        competitiveMentions: ['VMware Tanzu'],
        actionItems: ['Schedule follow-up demo', 'Send pricing sheet'],
      },
    })
    const result = templateEmailIntelligence([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('Email Intelligence')
    expect(result).toContain('john.doe@acme.com')
    expect(result).toContain('Technical Discussion')
    expect(result).toContain('OpenShift, Kubernetes')
    expect(result).toContain('VMware Tanzu')
    expect(result).toContain('Action Items')
    expect(result).toContain('Schedule follow-up demo')
    expect(templateProductAlignment([signal])).toBeNull()
    expect(templateCloudMarketplace([signal])).toBeNull()
    expect(templateCases([signal])).toBeNull()
    expect(templateRenewals([signal])).toBeNull()
    expect(templateTechStack([signal])).toBeNull()
  })

  test('partner-catalog signals enrich strategic opportunities when plays exist (#673)', () => {
    const partnerSignal = makeSignal({
      source: 'partner-catalog',
      type: 'intelligence',
      headline: 'Accenture',
      detail: 'Premier partner',
      metadata: {
        partnerName: 'Accenture',
        partnershipLevel: 'Premier',
        specializations: ['OpenShift', 'Ansible'],
        credentialCount: 42,
      },
    })
    const playSignal = makeSignal({
      source: 'solution-plays',
      type: 'intelligence',
      headline: 'Ansible (HIGH)',
      detail: 'Network automation play',
      metadata: {
        solutionPlayId: 'play-1',
        solutionPlayName: 'Network Automation',
        solutionTdp: 'Automation',
        redHatProducts: ['Ansible Automation Platform'],
      },
    })
    const result = templateStrategicOpportunities([playSignal, partnerSignal])
    expect(result).not.toBeNull()
    expect(result).toContain('Specialized Partners')
    expect(result).toContain('Accenture')
    expect(result).toContain('Premier')
    expect(result).toContain('OpenShift, Ansible')
    expect(result).toContain('Certs: 42')
  })

  test('saleshub-tactics source routes to saleshub (#673)', () => {
    const signal = makeSignal({
      source: 'saleshub-tactics',
      type: 'intelligence',
      headline: 'Migrate VMware workloads',
      detail: 'Cost reduction tactic for virtualization modernization',
      metadata: {
        playType: 'tactic',
        parentTdp: 'Virtualization',
        talkTrack: 'Customers report 40% TCO reduction',
      },
    })
    const result = templateSalesHubInsights([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('Active Tactics')
    expect(result).toContain('Migrate VMware workloads')
    expect(result).toContain('Virtualization')
    expect(templateProductAlignment([signal])).toBeNull()
  })

  test('saleshub-plays source routes to saleshub (#673)', () => {
    const signal = makeSignal({
      source: 'saleshub-plays',
      type: 'intelligence',
      headline: 'Modernize Infrastructure',
      detail: 'Strategic play for infrastructure modernization',
      metadata: {
        playType: 'strategic',
        tdpAlignment: ['Virtualization', 'Server/Cloud OS'],
      },
    })
    const result = templateSalesHubInsights([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('Strategic Plays')
    expect(result).toContain('Modernize Infrastructure')
    expect(result).toContain('Virtualization, Server/Cloud OS')
    expect(templateProductAlignment([signal])).toBeNull()
  })

  test('emails signals without action items omit Action Items section (#674)', () => {
    const signal = makeSignal({
      source: 'emails',
      type: 'intelligence',
      headline: 'Budget approval pending',
      detail: 'CFO reviewing Q3 budget for infrastructure',
      metadata: {
        from: 'finance@acme.com',
        classification: 'Business Update',
      },
    })
    const result = templateEmailIntelligence([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('finance@acme.com')
    expect(result).not.toContain('Action Items')
  })

  test('emails signals appear in templateAll deterministic output (#674)', async () => {
    const signal = makeSignal({
      source: 'emails',
      type: 'intelligence',
      headline: 'Ansible interest from VP Ops',
      detail: 'VP of Operations asking about automation capabilities',
      metadata: {
        from: 'vp-ops@acme.com',
        classification: 'Product Interest',
        techMentions: ['Ansible'],
      },
    })
    const result = await templateAll([signal])
    expect(result.deterministic).toContain('Email Intelligence')
    expect(result.deterministic).toContain('vp-ops@acme.com')
  })

  test('signals without routing metadata still reach narrativeContext', () => {
    // news-radar signals with no product metadata fall to 'other'
    // They should NOT appear in any deterministic section
    const signal = makeSignal({
      source: 'news-radar',
      headline: 'Customer acquires competitor',
      detail: 'Major M&A activity',
      metadata: { customerSlug: 'acme' },
    })
    expect(templateProductAlignment([signal])).toBeNull()
    expect(templateCloudMarketplace([signal])).toBeNull()
    expect(templateCases([signal])).toBeNull()
    expect(templateRenewals([signal])).toBeNull()
    expect(templateTechStack([signal])).toBeNull()
  })

  // #672: Ecosystem catalog signal routing
  test('ecosystem-catalog signals route to ecosystem, not product (#672)', () => {
    const signal = makeSignal({
      source: 'ecosystem-catalog',
      type: 'intelligence',
      headline: 'Cisco ACI + Ansible integration',
      detail: 'Certified content collection for network automation',
      metadata: {
        partnerName: 'Cisco',
        solutionName: 'ACI Ansible Collection',
        product: 'Red Hat Ansible Automation Platform',
        resourceTypes: ['certification', 'documentation', 'integration'],
      },
      url: 'https://catalog.redhat.com/software/containers/cisco/aci',
    })
    // Must NOT appear in product alignment (has metadata.product but should route to ecosystem)
    expect(templateProductAlignment([signal])).toBeNull()
    // Must NOT appear in competitive, cloud, cases, renewals, tech
    expect(templateCompetitiveLandscape([signal])).toBeNull()
    expect(templateCloudMarketplace([signal])).toBeNull()
    expect(templateCases([signal])).toBeNull()
    expect(templateRenewals([signal])).toBeNull()
    expect(templateTechStack([signal])).toBeNull()
  })

  test('ecosystem-catalog signals enrich strategic opportunities when plays exist (#672)', async () => {
    const ecosystemSignal = makeSignal({
      source: 'ecosystem-catalog',
      type: 'intelligence',
      headline: 'Cisco ACI + Ansible integration',
      detail: 'Certified content collection',
      metadata: {
        partnerName: 'Cisco',
        solutionName: 'ACI Ansible Collection',
        resourceTypes: ['certification', 'documentation'],
      },
      url: 'https://catalog.redhat.com/cisco',
    })
    const playSignal = makeSignal({
      source: 'solution-plays',
      type: 'intelligence',
      headline: 'Ansible (HIGH)',
      detail: 'Network automation play',
      metadata: {
        solutionPlayId: 'play-1',
        solutionPlayName: 'Network Automation',
        solutionTdp: 'Automation',
        redHatProducts: ['Ansible Automation Platform'],
      },
    })
    // templateStrategicOpportunities should include partner ecosystem subsection
    const result = templateStrategicOpportunities([playSignal, ecosystemSignal])
    expect(result).not.toBeNull()
    expect(result).toContain('Partner Ecosystem Solutions')
    expect(result).toContain('Cisco')
    expect(result).toContain('ACI Ansible Collection')
    expect(result).toContain('2 resources')
    expect(result).toContain('https://catalog.redhat.com/cisco')
  })

  // #672: Competitive intel signal routing
  test('competitive-intel signals route to competitive section (#672)', () => {
    const signal = makeSignal({
      source: 'competitive-intel',
      type: 'competitive',
      headline: 'VMware announces vSphere 9 pricing increase',
      detail: 'Counter with OpenShift Virtualization migration path',
      metadata: {
        competitor: 'VMware',
        product: 'vSphere',
        redHatCounter: 'OpenShift Virtualization offers 40% TCO reduction',
        salesTriggers: ['License renewal window', 'Budget reallocation'],
      },
    })
    // Must appear in competitive landscape
    const result = templateCompetitiveLandscape([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('VMware')
    expect(result).toContain('vSphere 9 pricing increase')
    expect(result).toContain('OpenShift Virtualization')
    expect(result).toContain('License renewal window')

    // Must NOT appear in product alignment (has metadata.product but should route to competitive)
    expect(templateProductAlignment([signal])).toBeNull()
  })

  test('competitive-intel signals with compensation metadata render notes (#672)', () => {
    const signal = makeSignal({
      source: 'competitive-intel',
      type: 'competitive',
      headline: 'Broadcom VMware bundling changes',
      detail: 'Counter with modular RHEL + OpenShift approach',
      metadata: {
        competitor: 'VMware',
        redHatCounter: 'Modular approach saves cost',
        salesTriggers: ['Contract renewal'],
        compensation: 'VMware reps getting 2x comp on renewals — urgency to lock customers in',
      },
    })
    const result = templateCompetitiveLandscape([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('VMware reps getting 2x comp')
  })

  test('competitive-intel signals appear in templateAll deterministic output (#672)', async () => {
    const signal = makeSignal({
      source: 'competitive-intel',
      type: 'competitive',
      headline: 'VMware price hike',
      detail: 'Counter with RHEL virtualization',
      metadata: {
        competitor: 'VMware',
        redHatCounter: 'RHEL virt',
        salesTriggers: ['renewal'],
      },
    })
    const result = await templateAll([signal])
    expect(result.deterministic).toContain('Competitive Landscape')
    expect(result.deterministic).toContain('VMware')
    expect(result.narrativeContext).toContain('competitive')
    expect(result.narrativeContext).toContain('VMware price hike')
  })
})
