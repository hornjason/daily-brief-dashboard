/**
 * GitHub Issue #451 — Cloud marketplace L3 Drive-shared upgrade
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MODULE_PATH = resolve(import.meta.dir, '../../src/modules/cloud-marketplace-module.ts')
const content = readFileSync(MODULE_PATH, 'utf-8')

describe('Cloud marketplace L3 upgrade (#451)', () => {

  test('export uses type-aware mimeType selection', () => {
    expect(content).toContain("exportMime = 'text/html'")
    expect(content).toContain("exportMime = 'text/plain'")
    expect(content).toContain("fileMeta.data.mimeType")
  })

  test('extractCloudData accepts slideText, htmlBody, and newsletterDate', () => {
    expect(content).toContain('async function extractCloudData(slideText: string, htmlBody: string, newsletterDate: string)')
  })

  test('EXTRACTION_PROMPT instructs extraction of URLs, pricing, and availability', () => {
    expect(content).toContain('url')
    expect(content).toContain('pricing')
    expect(content).toContain('availability')
  })

  test('CloudOffering type has url, pricing, availability fields', () => {
    const offeringMatch = content.match(/interface CloudOffering \{[\s\S]*?\}/)
    expect(offeringMatch).not.toBeNull()
    const block = offeringMatch![0]
    expect(block).toContain('url?: string')
    expect(block).toContain('pricing?: string')
    expect(block).toContain('availability?: string')
  })

  test('CloudProgram type has url field', () => {
    const programMatch = content.match(/interface CloudProgram \{[\s\S]*?\}/)
    expect(programMatch).not.toBeNull()
    expect(programMatch![0]).toContain('url?: string')
  })

  test('CloudIncentive type has url field', () => {
    const incentiveMatch = content.match(/interface CloudIncentive \{[\s\S]*?\}/)
    expect(incentiveMatch).not.toBeNull()
    expect(incentiveMatch![0]).toContain('url?: string')
  })

  test('responseSchema includes url, pricing, availability in offerings', () => {
    const schemaSection = content.slice(content.indexOf('const RESPONSE_SCHEMA'))
    expect(schemaSection).toContain("url: { type: 'string' }")
    expect(schemaSection).toContain("pricing: { type: 'string' }")
    expect(schemaSection).toContain("availability: { type: 'string' }")
  })

  test('ensureCloudMarketplaceFolder function exists', () => {
    expect(content).toContain('async function ensureCloudMarketplaceFolder(parentFolderId: string): Promise<string>')
  })

  test('uploadCloudMarketplaceJson function exists', () => {
    expect(content).toContain('async function uploadCloudMarketplaceJson(folderId: string, data: CloudMarketplaceCache): Promise<void>')
  })

  test('copySlideDecksToFolder function exists', () => {
    expect(content).toContain('async function copySlideDecksToFolder(folderId: string, fileIds: string[]): Promise<void>')
  })

  test('syncFromDrive function exists for L3 read path', () => {
    expect(content).toContain('async function syncFromDrive(): Promise<boolean>')
  })

  test('ensureFresh tries Drive sync before Gmail fallback', () => {
    const ensureFreshStart = content.indexOf('async ensureFresh(')
    const ensureFreshBlock = content.slice(ensureFreshStart, content.indexOf('async fetch(', ensureFreshStart))
    expect(ensureFreshBlock).toContain('syncFromDrive()')
    expect(ensureFreshBlock).toContain("this.syncNow('')")
  })

  test('syncNow passes htmlBody to extractCloudData', () => {
    expect(content).toContain('extractCloudData(slideText, htmlBody, newsletterDate)')
  })

  test('syncNow writes to Drive after local cache write', () => {
    const syncNowStart = content.indexOf('async syncNow()')
    const syncNowBlock = content.slice(syncNowStart)
    expect(syncNowBlock).toContain('ensureCloudMarketplaceFolder(parentId)')
    expect(syncNowBlock).toContain('copySlideDecksToFolder(cmFolder, fileIds)')
    expect(syncNowBlock).toContain('uploadCloudMarketplaceJson(cmFolder, cache)')
  })

  test('tech-stack cloud detection for customers without CCSP spend', () => {
    expect(content).toContain('techStackClouds')
    expect(content).toContain('hasCloudIntel')
    expect(content).toContain("tech-stack")
  })

  test('signals skip providers with no customer relationship (#434)', () => {
    // Providers with no CCSP spend and no tech-stack cloud intel are skipped
    expect(content).toContain('if (!hasSpend && !hasCloudIntel) continue')
    // Providers with tech-stack intel but no spend get a positioning headline
    expect(content).toContain('position Red Hat solutions')
  })
})

describe('Cloud marketplace HTML block extraction (#707)', () => {

  test('extractProviderHtmlBlocks function exists with block-level tag splitting', () => {
    expect(content).toContain('function extractProviderHtmlBlocks(html: string, provider: string, maxChars: number = 15_000): string')
  })

  test('HTML extraction splits on block-level tags, not newlines', () => {
    // Must split on <p>, <div>, <tr>, <li>, <h1-6> — not \n
    expect(content).toContain('html.split(/(?=<(?:p|div|tr|li|h[1-6])\\b)/i)')
  })

  test('extractCloudData uses extractProviderHtmlBlocks for HTML (not extractProviderLines)', () => {
    // The HTML path must use block-based extraction, not line-based
    expect(content).toContain('extractProviderHtmlBlocks(htmlBody, provider)')
    // extractProviderLines is still used for slide text (line-separated)
    expect(content).toContain('extractProviderLines(slideText, provider)')
  })

  test('HTML extraction caps output at maxChars (default 15K)', () => {
    // maxChars parameter with 15_000 default prevents sending 110K+ chars to Gemini
    expect(content).toContain('maxChars: number = 15_000')
    expect(content).toContain('if (totalLen >= maxChars) break')
  })

  test('HTML extraction returns empty string for empty input', () => {
    expect(content).toContain("if (!html || html.length === 0) return ''")
  })

  test('HTML extraction falls back to slice when no patterns match', () => {
    // When no provider-relevant blocks found, return first maxChars of HTML
    expect(content).toContain('relevant.length > 0 ? relevant.join')
    expect(content).toContain('html.slice(0, maxChars)')
  })
})

describe('Cloud marketplace extraction fixes (#703)', () => {

  test('extraction prompt handles cross-provider content', () => {
    expect(content).not.toContain("Extract ONLY ${provider} content")
    expect(content).toContain("even when described alongside other cloud providers")
  })

  test('baseline JSON includes offerings for all 3 providers', () => {
    const baselinePath = resolve(import.meta.dir, '../../config-templates/cloud-marketplace-baseline.json')
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
    expect(baseline.providers).toHaveLength(3)
    for (const p of baseline.providers) {
      expect(p.offerings).toBeDefined()
      expect(p.offerings.length).toBeGreaterThanOrEqual(3)
      const names = p.offerings.map((o: any) => o.name.toLowerCase())
      expect(names.some((n: string) => n.includes('rhel'))).toBe(true)
      expect(names.some((n: string) => n.includes('openshift'))).toBe(true)
      expect(names.some((n: string) => n.includes('ansible'))).toBe(true)
    }
  })

  test('mergeWithBaseline merges offerings not just programs', () => {
    expect(content).toContain("bp.offerings")
    expect(content).toContain("existing.offerings.push(off)")
  })

  test('syncNow clears delta cache before re-extraction', () => {
    expect(content).toContain("cleared delta cache for")
    expect(content).toContain("cloud-marketplace-${provider}")
  })
})
// ── #704: Canonical product name normalization ─────────────────────────────

// Import the exported functions for direct testing
const { normalizeOfferingName, splitCompoundOfferings } = await import('../../src/modules/cloud-marketplace-module.ts')

describe('Cloud marketplace name normalization (#704)', () => {

  describe('normalizeOfferingName()', () => {

    test('AC-3: RHAIE variants normalize to RHEL AI canonical name', () => {
      expect(normalizeOfferingName('RHAIE (Red Hat AI Enablement)')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
      expect(normalizeOfferingName('RHAIE (Red Hat AI for the Enterprise)')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
      expect(normalizeOfferingName('RHAIE')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
    })

    test('RHEL AI variants normalize to canonical form', () => {
      expect(normalizeOfferingName('RHEL AI')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
      expect(normalizeOfferingName('Red Hat Enterprise Linux AI (RHEL AI)')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
      expect(normalizeOfferingName('Red Hat Enterprise Linux AI')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
      expect(normalizeOfferingName('Red Hat AI')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
    })

    test('RHEL variants normalize to canonical form', () => {
      expect(normalizeOfferingName('RHEL')).toBe('Red Hat Enterprise Linux (RHEL)')
      expect(normalizeOfferingName('Red Hat Enterprise Linux')).toBe('Red Hat Enterprise Linux (RHEL)')
    })

    test('RHEL SAP normalizes correctly (not to base RHEL)', () => {
      expect(normalizeOfferingName('RHEL SAP')).toBe('Red Hat Enterprise Linux for SAP')
      expect(normalizeOfferingName('Red Hat Enterprise Linux for SAP')).toBe('Red Hat Enterprise Linux for SAP')
      expect(normalizeOfferingName('RHEL for SAP')).toBe('Red Hat Enterprise Linux for SAP')
    })

    test('OpenShift variants normalize', () => {
      expect(normalizeOfferingName('OpenShift')).toBe('Red Hat OpenShift')
      expect(normalizeOfferingName('Red Hat OpenShift')).toBe('Red Hat OpenShift')
      expect(normalizeOfferingName('ROSA')).toBe('Red Hat OpenShift')
    })

    test('Ansible variants normalize', () => {
      expect(normalizeOfferingName('Ansible Automation Platform')).toBe('Red Hat Ansible Automation Platform')
      expect(normalizeOfferingName('Red Hat Ansible Automation Platform')).toBe('Red Hat Ansible Automation Platform')
      expect(normalizeOfferingName('Ansible as a Service')).toBe('Red Hat Ansible Automation Platform')
      expect(normalizeOfferingName('Red Hat Ansible Automation Platform Service on AWS')).toBe('Red Hat Ansible Automation Platform')
      expect(normalizeOfferingName('AAP')).toBe('Red Hat Ansible Automation Platform')
    })

    test('RHACM variants normalize', () => {
      expect(normalizeOfferingName('RHACM')).toBe('Red Hat Advanced Cluster Management')
      expect(normalizeOfferingName('Advanced Cluster Management')).toBe('Red Hat Advanced Cluster Management')
    })

    test('RHLS variants normalize', () => {
      expect(normalizeOfferingName('RHLS')).toBe('Red Hat Learning Subscription')
      expect(normalizeOfferingName('Red Hat Learning Subscription')).toBe('Red Hat Learning Subscription')
    })

    test('unknown names pass through unchanged', () => {
      expect(normalizeOfferingName('Something Else')).toBe('Something Else')
      expect(normalizeOfferingName('Custom Product')).toBe('Custom Product')
    })

    test('normalization is case-insensitive', () => {
      expect(normalizeOfferingName('rhel ai')).toBe('Red Hat Enterprise Linux AI (RHEL AI)')
      expect(normalizeOfferingName('OPENSHIFT')).toBe('Red Hat OpenShift')
      expect(normalizeOfferingName('rosa')).toBe('Red Hat OpenShift')
    })
  })

  describe('splitCompoundOfferings()', () => {

    test('AC-2: splits comma-separated compound entries', () => {
      const items = [{ name: 'RHEL, RHEL SAP, RHEL Arm', description: 'compound' }]
      const result = splitCompoundOfferings(items)
      expect(result.length).toBeGreaterThanOrEqual(3)
      const names = result.map((r: any) => r.name)
      expect(names).toContain('Red Hat Enterprise Linux (RHEL)')
      expect(names).toContain('Red Hat Enterprise Linux for SAP')
    })

    test('does not split non-compound entries', () => {
      const items = [{ name: 'Red Hat OpenShift', description: 'single' }]
      const result = splitCompoundOfferings(items)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Red Hat OpenShift')
    })

    test('splits semicolon-separated entries', () => {
      const items = [{ name: 'RHEL; OpenShift', description: 'compound' }]
      const result = splitCompoundOfferings(items)
      expect(result.length).toBeGreaterThanOrEqual(2)
    })

    test('preserves description from original entry on split items', () => {
      const items = [{ name: 'RHEL, OpenShift', description: 'important desc' }]
      const result = splitCompoundOfferings(items)
      expect(result.every((r: any) => r.description === 'important desc')).toBe(true)
    })
  })

  describe('dedupeByName integration with normalization', () => {

    test('AC-1: dedupeByName uses canonical name mapping', () => {
      expect(content).toContain('normalizeOfferingName')
      const dedupeStart = content.indexOf('function dedupeByName')
      const dedupeBlock = content.slice(dedupeStart, content.indexOf('\n}', dedupeStart) + 2)
      expect(dedupeBlock).toContain('normalizeOfferingName')
    })

    test('AC-4: duplicate product names with different surface forms deduplicate', () => {
      const testNames = [
        'RHEL AI',
        'Red Hat Enterprise Linux AI (RHEL AI)',
        'Red Hat Enterprise Linux AI',
        'Red Hat AI',
        'RHAIE (Red Hat AI Enablement)',
        'RHEL, RHEL SAP, RHEL Arm',
        'Ansible as a Service',
        'Red Hat Ansible Automation Platform Service on AWS',
        'Red Hat Ansible Automation Platform',
        'RHEL',
        'OpenShift',
        'ROSA',
        'Red Hat OpenShift',
        'RHACM',
        'Red Hat Learning Subscription',
        'RHLS',
      ]
      // After normalization and dedup, unique canonical names should be <= 10
      const normalized = new Set(testNames.map(n => normalizeOfferingName(n).toLowerCase().trim()))
      expect(normalized.size).toBeLessThanOrEqual(10)
    })
  })
})

// ── #704: Purchasing recommendation synthesis ──────────────────────────────

const { generatePurchasingRecommendation } = await import('../../src/modules/cloud-marketplace-module.ts')

describe('Cloud marketplace purchasing recommendation (#704)', () => {

  describe('generatePurchasingRecommendation()', () => {

    test('AC-3: expiring incentives rank highest (rank 1)', () => {
      const signals = [
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.8, timestamp: '',
          metadata: {
            provider: 'AWS', hasCloudSpend: true, hasCloudIntel: true, acvPlus: 50000,
            incentives: [{ name: 'AWS Marketplace Credit', value: '2% TCV credits', validThrough: '2026-12-31' }],
            programs: [], offerings: [],
          },
        },
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.65, timestamp: '',
          metadata: {
            provider: 'Google', hasCloudSpend: false, hasCloudIntel: true, acvPlus: 0,
            incentives: [], programs: [], offerings: [],
          },
        },
      ]
      const result = generatePurchasingRecommendation(signals as any, 'fred-hutch')
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThanOrEqual(2)
      const awsRec = result.find((r: any) => r.recommendedProvider === 'AWS')
      expect(awsRec).toBeDefined()
      expect(awsRec!.rank).toBe(1)
      const googleRec = result.find((r: any) => r.recommendedProvider === 'Google')
      expect(googleRec).toBeDefined()
      expect(googleRec!.rank).toBeGreaterThan(awsRec!.rank)
    })

    test('AC-3: active CCSP spend ranks second (rank 2) over tech-stack only', () => {
      const signals = [
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.8, timestamp: '',
          metadata: {
            provider: 'Microsoft', hasCloudSpend: true, hasCloudIntel: true, acvPlus: 400000,
            incentives: [], programs: [], offerings: [],
          },
        },
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.65, timestamp: '',
          metadata: {
            provider: 'Google', hasCloudSpend: false, hasCloudIntel: true, acvPlus: 0,
            incentives: [], programs: [], offerings: [],
          },
        },
      ]
      const result = generatePurchasingRecommendation(signals as any, 'fred-hutch')
      const msRec = result.find((r: any) => r.recommendedProvider === 'Microsoft')
      const googleRec = result.find((r: any) => r.recommendedProvider === 'Google')
      expect(msRec!.rank).toBeLessThan(googleRec!.rank)
    })

    test('AC-2: conversationOpener is a non-empty descriptive string', () => {
      const signals = [
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.8, timestamp: '',
          metadata: {
            provider: 'AWS', hasCloudSpend: true, hasCloudIntel: true, acvPlus: 50000,
            incentives: [{ name: 'Credit Incentive', value: '2% TCV', validThrough: '2026-12-31' }],
            programs: [], offerings: [],
          },
        },
      ]
      const result = generatePurchasingRecommendation(signals as any, 'fred-hutch')
      expect(result[0].conversationOpener).toBeTruthy()
      expect(typeof result[0].conversationOpener).toBe('string')
      expect(result[0].conversationOpener.length).toBeGreaterThan(20)
    })

    test('AC-5: fallback opener for tech-stack-only provider', () => {
      const signals = [
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.65, timestamp: '',
          metadata: {
            provider: 'Google', hasCloudSpend: false, hasCloudIntel: true, acvPlus: 0,
            incentives: [], programs: [], offerings: [],
          },
        },
      ]
      const result = generatePurchasingRecommendation(signals as any, 'fred-hutch')
      expect(result[0].conversationOpener).toContain('Position Red Hat on Google')
    })

    test('returns empty array when no cloud signals', () => {
      const result = generatePurchasingRecommendation([], 'fred-hutch')
      expect(result).toEqual([])
    })

    test('incentive opener mentions the incentive name and value', () => {
      const signals = [
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.8, timestamp: '',
          metadata: {
            provider: 'AWS', hasCloudSpend: true, hasCloudIntel: true, acvPlus: 75000,
            incentives: [{ name: 'Marketplace Credit Incentive', value: '2% TCV credits', validThrough: '2026-12-31' }],
            programs: [], offerings: [],
          },
        },
      ]
      const result = generatePurchasingRecommendation(signals as any, 'test-customer')
      expect(result[0].conversationOpener).toContain('Marketplace Credit Incentive')
    })

    test('spend opener mentions ACV dollar amount', () => {
      const signals = [
        {
          source: 'cloud-marketplace', type: 'product-intel', headline: '', detail: '', rawRelevance: 0.8, timestamp: '',
          metadata: {
            provider: 'Microsoft', hasCloudSpend: true, hasCloudIntel: true, acvPlus: 400000,
            incentives: [], programs: [], offerings: [],
          },
        },
      ]
      const result = generatePurchasingRecommendation(signals as any, 'test-customer')
      expect(result[0].conversationOpener).toContain('400,000')
    })
  })

  describe('signal metadata includes recommendation fields (AC-1)', () => {

    test('signals() output includes recommendedProvider, providerRank, conversationOpener in metadata', () => {
      expect(content).toContain('recommendedProvider')
      expect(content).toContain('providerRank')
      expect(content).toContain('conversationOpener')
    })
  })

  describe('template renders recommendation section (AC-4)', () => {

    test('cloud template renders Purchasing Recommendation heading', () => {
      const templatePath = resolve(import.meta.dir, '../../src/lib/templates/cloud.ts')
      const templateContent = readFileSync(templatePath, 'utf-8')
      expect(templateContent).toContain('Purchasing Recommendation')
      expect(templateContent).toContain('recommendedProvider')
      expect(templateContent).toContain('conversationOpener')
    })
  })
})
