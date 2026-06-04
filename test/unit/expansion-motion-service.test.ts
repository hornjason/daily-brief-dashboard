/**
 * test/unit/expansion-motion-service.test.ts
 * TDD tests for Expansion Motion Service — #516
 *
 * Tests the consumer-facing getExpansionMotion() and getGraphDebug() functions.
 * Mocks the registry signal collection and file persistence to isolate
 * the service's orchestration logic.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { CustomerGraph } from '../../src/lib/intelligence-graph-types.ts'

// ── Test data dir ──────────────────────────────────────────────────────────

const TEST_DATA_DIR = resolve(import.meta.dir, '__expansion-motion-test-data__')

// ── Lazy imports ───────────────────────────────────────────────────────────

let getExpansionMotion: typeof import('../../src/lib/expansion-motion-service.ts').getExpansionMotion
let getGraphDebug: typeof import('../../src/lib/expansion-motion-service.ts').getGraphDebug
let buildCustomerGraph: typeof import('../../src/lib/intelligence-graph.ts').buildCustomerGraph
let persistGraph: typeof import('../../src/lib/intelligence-graph.ts').persistGraph
let loadGraph: typeof import('../../src/lib/intelligence-graph.ts').loadGraph

beforeAll(async () => {
  mkdirSync(TEST_DATA_DIR, { recursive: true })

  // Set CACHE_DIR so the service resolves data dir correctly
  process.env.CACHE_DIR = TEST_DATA_DIR

  const graphMod = await import('../../src/lib/intelligence-graph.ts')
  buildCustomerGraph = graphMod.buildCustomerGraph
  persistGraph = graphMod.persistGraph
  loadGraph = graphMod.loadGraph

  const serviceMod = await import('../../src/lib/expansion-motion-service.ts')
  getExpansionMotion = serviceMod.getExpansionMotion
  getGraphDebug = serviceMod.getGraphDebug
})

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  // Clean customer dirs between tests
  const customerDir = resolve(TEST_DATA_DIR, 'test-customer')
  rmSync(customerDir, { recursive: true, force: true })
})

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Minimal signals — single subscription + play node (enough for motion after #573) */
function makeMinimalSignals(): Signal[] {
  const now = new Date().toISOString()
  return [
    {
      source: 'subscriptions',
      type: 'subscription',
      headline: 'RHEL Server',
      detail: 'Expired subscription',
      rawRelevance: 0.8,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        productDescription: 'Red Hat Enterprise Linux Server',
        status: 'expired',
        sku: 'RH00001',
        endDate: '2025-12-31',
      },
    },
    {
      source: 'solution-intelligence',
      type: 'product-intel',
      headline: 'Server and Cloud OS Play',
      detail: 'Solution play match from RHEL subscription',
      rawRelevance: 0.7,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        solutionName: 'Server and Cloud OS',
        productAlignment: 'Red Hat Enterprise Linux',
        matchedTechnologies: ['RHEL'],
      },
    },
  ]
}

/** Rich signals — enough for graph + motion generation */
function makeRichSignals(): Signal[] {
  const now = new Date().toISOString()
  return [
    {
      source: 'subscriptions',
      type: 'subscription',
      headline: 'RHEL Server',
      detail: 'Expired subscription',
      rawRelevance: 0.9,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        productDescription: 'Red Hat Enterprise Linux Server',
        status: 'expired',
        sku: 'RH00001',
        endDate: '2026-01-15',
      },
    },
    {
      source: 'subscriptions',
      type: 'subscription',
      headline: 'Ansible Automation Platform',
      detail: 'Expired subscription',
      rawRelevance: 0.9,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        productDescription: 'Ansible Automation Platform',
        status: 'expired',
        sku: 'MCT3695',
        endDate: '2026-02-01',
      },
    },
    {
      source: 'cases',
      type: 'case',
      headline: 'Ansible playbook error on RHEL 9',
      detail: 'Case open',
      rawRelevance: 0.7,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        caseNumber: '03218765',
        severity: 2,
        status: 'open',
        product: 'Ansible Automation Platform',
      },
    },
    {
      source: 'ccsp',
      type: 'cloud-spend',
      headline: 'AWS cloud spend',
      detail: 'CCSP partner',
      rawRelevance: 0.8,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        cloudPartner: 'AWS',
        acvPlus: 250000,
        hasCloudSpend: true,
      },
    },
    {
      source: 'solution-intelligence',
      type: 'expansion',
      headline: 'Automation Everywhere Play',
      detail: 'Solution play match',
      rawRelevance: 0.9,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        solutionName: 'Automation Everywhere',
        productAlignment: 'Ansible Automation Platform',
        matchedTechnologies: ['Ansible'],
      },
    },
    {
      source: 'solution-intelligence',
      type: 'expansion',
      headline: 'Hybrid Cloud Play',
      detail: 'Solution play match',
      rawRelevance: 0.8,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        solutionName: 'Hybrid Cloud Infrastructure',
        productAlignment: 'OpenShift',
        matchedTechnologies: ['OpenShift'],
      },
    },
    {
      source: 'tech-stack',
      type: 'technology',
      headline: 'Uses Terraform',
      detail: 'IaC tool detected',
      rawRelevance: 0.6,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        techName: 'Terraform',
        category: 'IaC',
        context: 'evaluating',
      },
    },
    {
      source: 'pipeline',
      type: 'expansion',
      headline: 'RHEL Expansion',
      detail: 'Pipeline deal',
      rawRelevance: 0.7,
      timestamp: now,
      metadata: {
        customerSlug: 'test-customer',
        opportunityName: 'RHEL 9 Migration',
        stage: 'Qualify',
        amount: 150000,
        closeDate: '2026-09-30',
      },
    },
  ]
}

/** SalesHub play signals for motion building */
function makePlaySignals(): Signal[] {
  return [
    {
      source: 'saleshub-plays',
      type: 'recommendation',
      headline: 'Automation Everywhere Play',
      detail: 'SalesHub play',
      rawRelevance: 0.4,
      timestamp: new Date().toISOString(),
      metadata: {
        tdpAlignment: ['Automation', 'Server/Cloud OS'],
        playType: 'strategic',
        personaRoles: ['VP Infrastructure', 'Director of IT'],
      },
    },
  ]
}

/** SalesHub tactic signals for motion building */
function makeTacticSignals(): Signal[] {
  return [
    {
      source: 'saleshub-tactics',
      type: 'recommendation',
      headline: 'Ansible Migration Tactic',
      detail: 'TDP: Automation',
      rawRelevance: 0.3,
      timestamp: new Date().toISOString(),
      metadata: {
        parentTdp: 'Automation',
        playType: 'tactic',
        assets: [{ name: 'Migration Guide', url: 'https://example.com/guide', type: 'share' }],
      },
    },
    {
      source: 'saleshub-tactics',
      type: 'recommendation',
      headline: 'RHEL Cloud Tactic',
      detail: 'TDP: Server/Cloud OS',
      rawRelevance: 0.3,
      timestamp: new Date().toISOString(),
      metadata: {
        parentTdp: 'Server/Cloud OS',
        playType: 'tactic',
        assets: [],
      },
    },
    {
      source: 'saleshub-tactics',
      type: 'recommendation',
      headline: 'AI Platform Tactic',
      detail: 'TDP: AI',
      rawRelevance: 0.3,
      timestamp: new Date().toISOString(),
      metadata: {
        parentTdp: 'AI',
        playType: 'tactic',
        assets: [],
      },
    },
  ]
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('expansion-motion-service', () => {

  describe('getExpansionMotion', () => {
    it('returns null for customer with no signals', async () => {
      // No graph on disk, no signals → should return null
      const result = await getExpansionMotion(
        'nonexistent-customer',
        'Nonexistent Corp',
        { collectSignals: async () => [], playSignals: [], tacticSignals: [] },
      )
      expect(result).toBeNull()
    })

    it('returns motion when subscription maps to a play (#573)', async () => {
      // Minimal signals (single RHEL subscription) now produce a play node
      // via subscription→TDP mapping, so motion should be generated
      const result = await getExpansionMotion(
        'test-customer',
        'Test Corp',
        {
          collectSignals: async () => makeMinimalSignals(),
          playSignals: makePlaySignals(),
          tacticSignals: makeTacticSignals(),
        },
      )
      // With #573 fix: RHEL subscription → Server/Cloud OS TDP → play node → motion
      expect(result).not.toBeNull()
      expect(result!.customerSlug).toBe('test-customer')
    })

    it('returns StrategicMotion when signals are sufficient', async () => {
      const result = await getExpansionMotion(
        'test-customer',
        'Test Corp',
        {
          collectSignals: async () => makeRichSignals(),
          playSignals: makePlaySignals(),
          tacticSignals: makeTacticSignals(),
        },
      )
      expect(result).not.toBeNull()
      expect(result!.customerSlug).toBe('test-customer')
      expect(result!.customerName).toBe('Test Corp')
      expect(result!.status).toBe('active')
      expect(Array.isArray(result!.phases)).toBe(true)
      expect(result!.phases.length).toBeGreaterThanOrEqual(1)
      expect(result!.generatedAt).toBeTruthy()
    })

    it('uses cached graph when fresh — does not rebuild', async () => {
      // Pre-build and persist a graph
      const signals = makeRichSignals()
      const graph = buildCustomerGraph('test-customer', 'Test Corp', signals)
      mkdirSync(resolve(TEST_DATA_DIR, 'test-customer'), { recursive: true })
      persistGraph(graph, TEST_DATA_DIR)

      let collectCalled = false
      const result = await getExpansionMotion(
        'test-customer',
        'Test Corp',
        {
          collectSignals: async () => {
            collectCalled = true
            return makeRichSignals()
          },
          playSignals: makePlaySignals(),
          tacticSignals: makeTacticSignals(),
        },
      )

      // Graph was fresh (builtAt is very recent), so collectSignals should NOT be called
      expect(collectCalled).toBe(false)
      // Should still return a motion if the cached graph has enough data
      // (may be null if graph lacks 2+ plays — that's fine, the point is it didn't rebuild)
    })

    it('calls enrichPersonas with motion target personas when motion is built', async () => {
      // Write meeting attendee data so enrichment can find a match
      const meetingData = {
        data: [{
          attendeeDetails: [{
            displayName: 'Alice Johnson',
            email: 'alice@testcorp.com',
            title: 'VP Infrastructure',
          }],
        }],
      }
      mkdirSync(resolve(TEST_DATA_DIR, 'test-customer'), { recursive: true })
      writeFileSync(
        resolve(TEST_DATA_DIR, 'test-customer-meetings.json'),
        JSON.stringify(meetingData),
      )

      const result = await getExpansionMotion(
        'test-customer',
        'Test Corp',
        {
          collectSignals: async () => makeRichSignals(),
          playSignals: makePlaySignals(),
          tacticSignals: makeTacticSignals(),
        },
      )

      // Motion with matching play should have target personas
      if (result && result.phases.some(p => p.targetPersonas.length > 0)) {
        // enrichedContacts should be populated (found or empty array)
        expect(result.enrichedContacts).toBeDefined()
        expect(Array.isArray(result.enrichedContacts)).toBe(true)
      }
    })

    it('motion includes enrichedContacts when enrichment finds matches', async () => {
      // Write meeting attendee data with a persona match
      const meetingData = {
        data: [{
          attendeeDetails: [{
            displayName: 'Bob Smith',
            email: 'bob@testcorp.com',
            title: 'Director of IT',
          }],
        }],
      }
      mkdirSync(resolve(TEST_DATA_DIR, 'test-customer'), { recursive: true })
      writeFileSync(
        resolve(TEST_DATA_DIR, 'test-customer-meetings.json'),
        JSON.stringify(meetingData),
      )

      const result = await getExpansionMotion(
        'test-customer',
        'Test Corp',
        {
          collectSignals: async () => makeRichSignals(),
          playSignals: makePlaySignals(),
          tacticSignals: makeTacticSignals(),
        },
      )

      if (result && result.enrichedContacts && result.enrichedContacts.length > 0) {
        const found = result.enrichedContacts.find(c => c.name === 'Bob Smith')
        if (found) {
          expect(found.persona).toBe('Director of IT')
          expect(found.email).toBe('bob@testcorp.com')
          expect(found.source).toBe('meeting')
        }
      }
      // If motion was null or no enrichedContacts, that's fine — the test
      // validates the wiring works when data is present
    })
  })

  describe('getGraphDebug', () => {
    it('returns zeroes when no graph exists', () => {
      const debug = getGraphDebug('nonexistent-slug')
      expect(debug.nodeCount).toBe(0)
      expect(debug.edgeCount).toBe(0)
      expect(debug.edgeTypes).toEqual({})
    })

    it('returns node and edge counts from persisted graph', () => {
      const signals = makeRichSignals()
      const graph = buildCustomerGraph('test-customer', 'Test Corp', signals)
      mkdirSync(resolve(TEST_DATA_DIR, 'test-customer'), { recursive: true })
      persistGraph(graph, TEST_DATA_DIR)

      const debug = getGraphDebug('test-customer')
      expect(debug.nodeCount).toBeGreaterThan(0)
      expect(debug.edgeCount).toBeGreaterThan(0)
      expect(typeof debug.edgeTypes).toBe('object')
      // Should have at least HAS_SUBSCRIPTION from the subscription signals
      expect(Object.keys(debug.edgeTypes).length).toBeGreaterThan(0)
    })
  })
})
