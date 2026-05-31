import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { getCustomerSolutionContext, resetCatalogCache } from '../../src/lib/customer-solution-context'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { resolve } from 'path'

const TEST_DIR = resolve(import.meta.dir, '.test-customer-solution-context')
const CONFIG_DIR = resolve(TEST_DIR, 'config')
const CACHE_DIR = resolve(TEST_DIR, 'cache')

const CATALOG = {
  version: 2,
  tdps: ['Automation', 'Virtualization', 'App Platform', 'Infrastructure', 'Cloud', 'IaC'],
  plays: [
    {
      id: 'vmware-migration',
      name: 'VMware to OpenShift Virtualization Migration',
      tdp: 'Virtualization',
      summary: 'Consolidate VMs and containers',
      triggerTechnologies: ['VMware', 'vSphere', 'ESXi'],
      redHatProducts: ['ocp', 'rhel'],
      valueProps: ['Eliminate VMware licensing costs'],
      cloudAmplifiers: ['AWS'],
      category: 'modernization',
    },
    {
      id: 'itsm-automation',
      name: 'ITSM Automation with EDA',
      tdp: 'Automation',
      summary: 'Automate ServiceNow workflows',
      triggerTechnologies: ['ServiceNow', 'SNOW'],
      redHatProducts: ['aap', 'rhel'],
      valueProps: ['Reduce MTTR by automating triage'],
      category: 'automation',
    },
    {
      id: 'cloud-native',
      name: 'Cloud-Native Application Platform',
      tdp: 'App Platform',
      summary: 'Standardize on OpenShift',
      triggerTechnologies: ['Kubernetes', 'Docker', 'EKS'],
      redHatProducts: ['ocp', 'acs'],
      valueProps: ['Enterprise K8s with security built in'],
      cloudAmplifiers: ['AWS', 'Azure'],
      category: 'platform',
    },
    {
      id: 'platform-modernization',
      name: 'Infrastructure Modernization with RHEL',
      tdp: 'Infrastructure',
      summary: 'Migrate from legacy OS to RHEL',
      triggerTechnologies: ['CentOS', 'Ubuntu', 'SUSE', 'Oracle Linux'],
      redHatProducts: ['rhel'],
      valueProps: ['Consolidate on enterprise Linux'],
      category: 'modernization',
    },
    {
      id: 'cloud-marketplace',
      name: 'Cloud Marketplace and CPPO',
      tdp: 'Cloud',
      summary: 'Leverage marketplace for procurement',
      triggerTechnologies: ['AWS', 'Azure', 'Google Cloud'],
      redHatProducts: ['ocp', 'rhel'],
      valueProps: ['Simplify procurement through marketplace'],
      category: 'marketplace',
    },
    {
      id: 'iac-modernization',
      name: 'IaC Modernization with AAP',
      tdp: 'IaC',
      summary: 'Replace legacy IaC with Ansible',
      triggerTechnologies: ['Terraform', 'Puppet', 'Chef', 'SaltStack'],
      redHatProducts: ['aap'],
      valueProps: ['Unified automation platform'],
      category: 'automation',
    },
  ],
}

function writeTechStackCache(slug: string, technologies: any[]) {
  mkdirSync(resolve(CACHE_DIR, 'tech-stack'), { recursive: true })
  writeFileSync(
    resolve(CACHE_DIR, 'tech-stack', `${slug}.json`),
    JSON.stringify({ contentHash: 'test', technologies, cachedAt: new Date().toISOString() })
  )
}

function writeCCSPCache(records: any[]) {
  writeFileSync(
    resolve(CACHE_DIR, 'ccsp.json'),
    JSON.stringify({ records, cachedAt: new Date().toISOString() })
  )
}

function writeCloudMarketplaceCache(clouds: any[]) {
  mkdirSync(resolve(CACHE_DIR, 'cloud-marketplace'), { recursive: true })
  writeFileSync(
    resolve(CACHE_DIR, 'cloud-marketplace', 'latest.json'),
    JSON.stringify({ clouds, cachedAt: new Date().toISOString() })
  )
}

function writeCasesCache(slug: string, cases: any[]) {
  mkdirSync(resolve(CACHE_DIR, 'rh-cases'), { recursive: true })
  writeFileSync(
    resolve(CACHE_DIR, 'rh-cases', `${slug}.json`),
    JSON.stringify({ cases })
  )
}

function writeLifecycleCache(events: any[]) {
  writeFileSync(
    resolve(CACHE_DIR, 'product-lifecycle.json'),
    JSON.stringify({ events })
  )
}

function writePipelineCache(records: any[]) {
  writeFileSync(
    resolve(CACHE_DIR, 'pipeline.json'),
    JSON.stringify({ records, cachedAt: new Date().toISOString() })
  )
}

function writeSheetsCache(slug: string, rows: any[]) {
  writeFileSync(
    resolve(CACHE_DIR, `${slug}-sheets.json`),
    JSON.stringify({ rows })
  )
}

beforeEach(() => {
  mkdirSync(CONFIG_DIR, { recursive: true })
  mkdirSync(CACHE_DIR, { recursive: true })
  process.env.CONFIG_DIR = CONFIG_DIR
  process.env.CACHE_DIR = CACHE_DIR
  writeFileSync(resolve(CONFIG_DIR, 'solution-plays.json'), JSON.stringify(CATALOG))
  resetCatalogCache()
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env.CONFIG_DIR
  delete process.env.CACHE_DIR
  resetCatalogCache()
})

// ── Phase 1: Solution Plays ──────────────────────────────────────────────

describe('activeSolutionPlays', () => {
  it('matches detected technologies against catalog trigger technologies', () => {
    writeTechStackCache('acme', [
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: ['ocp'], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays.length).toBe(1)
    expect(ctx.activeSolutionPlays[0].playId).toBe('vmware-migration')
    expect(ctx.activeSolutionPlays[0].matchedTechnologies).toEqual(['VMware'])
    expect(ctx.activeSolutionPlays[0].confidence).toBe('HIGH')
    expect(ctx.activeSolutionPlays[0].tdp).toBe('Virtualization')
  })

  it('matches multiple plays when customer has multiple technologies', () => {
    writeTechStackCache('acme', [
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: ['ocp'], infrastructure: [] },
      { name: 'ServiceNow', category: 'industry-tool', context: 'using', confidence: 'MEDIUM', redHatProducts: ['aap'], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays.length).toBe(2)
    const playIds = ctx.activeSolutionPlays.map(p => p.playId)
    expect(playIds).toContain('vmware-migration')
    expect(playIds).toContain('itsm-automation')
  })

  it('sorts by confidence then by matched technology count', () => {
    writeTechStackCache('acme', [
      { name: 'ServiceNow', category: 'industry-tool', context: 'using', confidence: 'LOW', redHatProducts: [], infrastructure: [] },
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays[0].confidence).toBe('HIGH')
    expect(ctx.activeSolutionPlays[1].confidence).toBe('LOW')
  })

  it('matches via infrastructure array', () => {
    writeTechStackCache('acme', [
      { name: 'CustomApp', category: 'proprietary', context: 'using', confidence: 'MEDIUM', redHatProducts: [], infrastructure: ['Kubernetes', 'AWS'] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays.length).toBeGreaterThanOrEqual(1)
    const playIds = ctx.activeSolutionPlays.map(p => p.playId)
    expect(playIds).toContain('cloud-native')
  })

  it('returns empty when no tech-stack cache exists', () => {
    const ctx = getCustomerSolutionContext('no-cache-customer')
    expect(ctx.activeSolutionPlays).toEqual([])
  })

  it('returns empty when no technologies match any play', () => {
    writeTechStackCache('acme', [
      { name: 'SomeObscureTool', category: 'proprietary', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays).toEqual([])
  })

  it('is case-insensitive on technology matching', () => {
    writeTechStackCache('acme', [
      { name: 'vmware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays.length).toBe(1)
    expect(ctx.activeSolutionPlays[0].playId).toBe('vmware-migration')
  })

  it('populates matchReasoning with detected tech, source, TDP, and play name', () => {
    writeTechStackCache('acme', [
      { name: 'ServiceNow', category: 'tech-stack', context: 'using', confidence: 'MEDIUM', redHatProducts: ['aap'], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays.length).toBe(1)
    const play = ctx.activeSolutionPlays[0]
    expect(play.matchReasoning).toBeDefined()
    expect(play.matchReasoning.length).toBeGreaterThan(0)
    expect(play.matchReasoning).toContain('ServiceNow')
    expect(play.matchReasoning).toContain('tech-stack')
    expect(play.matchReasoning).toContain('Automation')
    expect(play.matchReasoning).toContain('ITSM Automation')
  })

  it('includes multiple detected techs with their sources in matchReasoning', () => {
    writeTechStackCache('acme', [
      { name: 'VMware', category: 'subscription', context: 'using', confidence: 'HIGH', redHatProducts: ['ocp'], infrastructure: ['vSphere'] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    const play = ctx.activeSolutionPlays[0]
    // VMware matched directly, vSphere matched via infrastructure — both from 'subscription' source
    expect(play.matchReasoning).toContain('VMware (subscription)')
    expect(play.matchReasoning).toContain('vSphere (subscription)')
    expect(play.matchReasoning).toContain('Virtualization TDP')
  })

  it('includes valueProps and redHatProducts from catalog', () => {
    writeTechStackCache('acme', [
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays[0].valueProps).toEqual(['Eliminate VMware licensing costs'])
    expect(ctx.activeSolutionPlays[0].redHatProducts).toEqual(['ocp', 'rhel'])
  })

  // ── Fuzzy Matching: Trigger-is-Substring ─────────────────────────────

  it('matches "CentOS Linux" against trigger "CentOS" via substring', () => {
    writeTechStackCache('acme', [
      { name: 'CentOS Linux', category: 'os', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    const play = ctx.activeSolutionPlays.find(p => p.playId === 'platform-modernization')
    expect(play).toBeDefined()
    expect(play!.matchedTechnologies).toContain('CentOS Linux')
  })

  // ── Fuzzy Matching: Parenthetical Extraction ─────────────────────────

  it('matches "Amazon Web Services (AWS)" against trigger "AWS" via parenthetical extraction', () => {
    writeTechStackCache('acme', [
      { name: 'Amazon Web Services (AWS)', category: 'cloud', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    const play = ctx.activeSolutionPlays.find(p => p.playId === 'cloud-marketplace')
    expect(play).toBeDefined()
    expect(play!.matchedTechnologies).toContain('Amazon Web Services (AWS)')
  })

  // ── Fuzzy Matching: Vendor Prefix Stripping ──────────────────────────

  it('matches "HashiCorp Terraform" against trigger "Terraform" via vendor prefix stripping', () => {
    writeTechStackCache('acme', [
      { name: 'HashiCorp Terraform', category: 'iac', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    const play = ctx.activeSolutionPlays.find(p => p.playId === 'iac-modernization')
    expect(play).toBeDefined()
    expect(play!.matchedTechnologies).toContain('HashiCorp Terraform')
  })

  // ── No False Positives ───────────────────────────────────────────────

  it('does NOT match "Ansible" against a trigger "An" (word boundary protection)', () => {
    // Temporarily override catalog with a play that has a short trigger
    writeFileSync(resolve(CONFIG_DIR, 'solution-plays.json'), JSON.stringify({
      version: 2,
      plays: [{
        id: 'fake-play',
        name: 'Fake Play',
        tdp: 'Test',
        summary: 'Test',
        triggerTechnologies: ['An'],
        redHatProducts: ['test'],
        valueProps: ['test'],
        category: 'test',
      }],
    }))
    resetCatalogCache()
    writeTechStackCache('acme', [
      { name: 'Ansible', category: 'automation', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays).toEqual([])
  })

  it('does NOT match "Python" against a trigger "Py" (word boundary protection)', () => {
    writeFileSync(resolve(CONFIG_DIR, 'solution-plays.json'), JSON.stringify({
      version: 2,
      plays: [{
        id: 'fake-play',
        name: 'Fake Play',
        tdp: 'Test',
        summary: 'Test',
        triggerTechnologies: ['Py'],
        redHatProducts: ['test'],
        valueProps: ['test'],
        category: 'test',
      }],
    }))
    resetCatalogCache()
    writeTechStackCache('acme', [
      { name: 'Python', category: 'language', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.activeSolutionPlays).toEqual([])
  })

  it('exact match still works as fast path for "Docker"', () => {
    writeTechStackCache('acme', [
      { name: 'Docker', category: 'container', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    const play = ctx.activeSolutionPlays.find(p => p.playId === 'cloud-native')
    expect(play).toBeDefined()
    expect(play!.matchedTechnologies).toContain('Docker')
  })
})

// ── Phase 2: Marketplace Opportunities ───────────────────────────────────

describe('marketplaceOpportunities', () => {
  it('aggregates CCSP spend by provider', () => {
    writeTechStackCache('acme', [])
    writeCCSPCache([
      { accountName: 'Acme Corp', cloudPartner: 'AWS', acvPlus: 50000 },
      { accountName: 'Acme Corp', cloudPartner: 'AWS', acvPlus: 75000 },
      { accountName: 'Acme Corp', cloudPartner: 'Google', acvPlus: 30000 },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    expect(ctx.marketplaceOpportunities.length).toBe(2)
    const aws = ctx.marketplaceOpportunities.find(o => o.provider === 'AWS')
    expect(aws?.currentSpend).toBe(125000)
    expect(aws?.privateOfferEligible).toBe(true)
    const google = ctx.marketplaceOpportunities.find(o => o.provider === 'Google')
    expect(google?.currentSpend).toBe(30000)
    expect(google?.privateOfferEligible).toBe(false)
  })

  it('sorts by spend descending', () => {
    writeTechStackCache('acme', [])
    writeCCSPCache([
      { accountName: 'Acme Corp', cloudPartner: 'Google', acvPlus: 200000 },
      { accountName: 'Acme Corp', cloudPartner: 'AWS', acvPlus: 50000 },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    expect(ctx.marketplaceOpportunities[0].provider).toBe('Google')
    expect(ctx.marketplaceOpportunities[1].provider).toBe('AWS')
  })

  it('includes eligible programs from marketplace cache', () => {
    writeTechStackCache('acme', [])
    writeCCSPCache([
      { accountName: 'Acme Corp', cloudPartner: 'AWS', acvPlus: 150000 },
    ])
    writeCloudMarketplaceCache([
      { provider: 'AWS', programs: [{ name: 'CPPO', description: 'Channel partner' }, { name: 'EDP', description: 'Enterprise discount' }] },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    expect(ctx.marketplaceOpportunities[0].eligiblePrograms).toEqual(['CPPO', 'EDP'])
  })

  it('includes movable subscriptions from sheets cache', () => {
    writeTechStackCache('acme', [])
    writeCCSPCache([
      { accountName: 'Acme Corp', cloudPartner: 'AWS', acvPlus: 100000 },
    ])
    writeSheetsCache('acme-corp', [
      { productDescription: 'Red Hat OpenShift Container Platform' },
      { productDescription: 'Red Hat Enterprise Linux' },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    expect(ctx.marketplaceOpportunities[0].movableSubscriptions).toContain('OpenShift')
    expect(ctx.marketplaceOpportunities[0].movableSubscriptions).toContain('RHEL')
  })

  it('returns empty when no CCSP records for customer', () => {
    writeTechStackCache('acme', [])
    writeCCSPCache([
      { accountName: 'Other Corp', cloudPartner: 'AWS', acvPlus: 100000 },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.marketplaceOpportunities).toEqual([])
  })

  it('skips providers with zero spend', () => {
    writeTechStackCache('acme', [])
    writeCCSPCache([
      { accountName: 'Acme Corp', cloudPartner: 'AWS', acvPlus: 0 },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    expect(ctx.marketplaceOpportunities).toEqual([])
  })
})

// ── Phase 3: Version Correlations ────────────────────────────────────────

describe('versionCorrelations', () => {
  it('groups cases by product and finds lifecycle events', () => {
    writeTechStackCache('acme', [])
    writeCasesCache('acme', [
      { caseNumber: '001', severity: '2', product: 'RHEL', version: '8.6', status: 'Open' },
      { caseNumber: '002', severity: '1', product: 'RHEL', version: '8.6', status: 'Open' },
      { caseNumber: '003', severity: '3', product: 'RHEL', version: '8.6', status: 'Open' },
    ])
    writeLifecycleCache([
      { product: 'RHEL', version: '8', phase: 'EOL', date: '2026-06-30' },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.versionCorrelations.length).toBe(1)
    expect(ctx.versionCorrelations[0].product).toBe('RHEL')
    expect(ctx.versionCorrelations[0].activeCases).toBe(3)
    expect(ctx.versionCorrelations[0].amplified).toBe(true)
    expect(ctx.versionCorrelations[0].lifecycleEvent).toContain('EOL')
  })

  it('marks amplified=false when cases exist but no lifecycle event', () => {
    writeTechStackCache('acme', [])
    writeCasesCache('acme', [
      { caseNumber: '001', severity: '2', product: 'OpenShift', status: 'Open' },
      { caseNumber: '002', severity: '2', product: 'OpenShift', status: 'Open' },
    ])
    writeLifecycleCache([])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.versionCorrelations.length).toBe(1)
    expect(ctx.versionCorrelations[0].amplified).toBe(false)
  })

  it('excludes closed cases', () => {
    writeTechStackCache('acme', [])
    writeCasesCache('acme', [
      { caseNumber: '001', severity: '2', product: 'RHEL', status: 'Open' },
      { caseNumber: '002', severity: '2', product: 'RHEL', status: 'Closed' },
    ])
    writeLifecycleCache([])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.versionCorrelations).toEqual([])
  })

  it('returns empty when no cases exist', () => {
    writeTechStackCache('acme', [])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.versionCorrelations).toEqual([])
  })
})

// ── Phase 3: Cross-Sell Signals ──────────────────────────────────────────

describe('crossSellSignals', () => {
  it('finds cross-sell when pipeline deal + tech-stack + catalog align', () => {
    writeTechStackCache('acme-corp', [
      { name: 'VMware', category: 'industry-tool', context: 'migrating_from', confidence: 'HIGH', redHatProducts: ['ocp'], infrastructure: [] },
    ])
    writePipelineCache([
      { accountName: 'Acme Corp', oppName: 'OCP Deal', acv: 200000, forecastCategory: 'Commit', products: ['ocp'] },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    expect(ctx.crossSellSignals.length).toBeGreaterThanOrEqual(1)
    const rhel = ctx.crossSellSignals.find(s => s.crossSellProduct === 'rhel')
    expect(rhel).toBeDefined()
    expect(rhel?.pipelineProduct).toBe('ocp')
    expect(rhel?.relatedTech).toBe('VMware')
    expect(rhel?.stage).toBe('Commit')
  })

  it('dedupes by pipelineProduct:crossSellProduct', () => {
    writeTechStackCache('acme-corp', [
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
      { name: 'vSphere', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    writePipelineCache([
      { accountName: 'Acme Corp', oppName: 'OCP Deal', acv: 100000, forecastCategory: 'Pipeline', products: ['ocp'] },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    const rhelSignals = ctx.crossSellSignals.filter(s => s.crossSellProduct === 'rhel')
    expect(rhelSignals.length).toBe(1)
  })

  it('returns empty when no pipeline deals exist', () => {
    writeTechStackCache('acme', [
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const ctx = getCustomerSolutionContext('acme')
    expect(ctx.crossSellSignals).toEqual([])
  })

  it('returns empty when no tech-stack detected', () => {
    writePipelineCache([
      { accountName: 'Acme Corp', oppName: 'Deal', acv: 100000, forecastCategory: 'Pipeline', products: ['ocp'] },
    ])
    const ctx = getCustomerSolutionContext('acme-corp')
    expect(ctx.crossSellSignals).toEqual([])
  })
})

// ── Result Caching ───────────────────────────────────────────────────────

describe('result caching', () => {
  it('returns cached result within TTL', () => {
    writeTechStackCache('acme', [
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    const first = getCustomerSolutionContext('acme')
    expect(first.activeSolutionPlays.length).toBe(1)

    rmSync(resolve(CACHE_DIR, 'tech-stack', 'acme.json'))
    const second = getCustomerSolutionContext('acme')
    expect(second.activeSolutionPlays.length).toBe(1)
  })

  it('resetCatalogCache clears result cache', () => {
    writeTechStackCache('acme', [
      { name: 'VMware', category: 'industry-tool', context: 'using', confidence: 'HIGH', redHatProducts: [], infrastructure: [] },
    ])
    getCustomerSolutionContext('acme')
    resetCatalogCache()
    rmSync(resolve(CACHE_DIR, 'tech-stack', 'acme.json'))
    const fresh = getCustomerSolutionContext('acme')
    expect(fresh.activeSolutionPlays).toEqual([])
  })
})
