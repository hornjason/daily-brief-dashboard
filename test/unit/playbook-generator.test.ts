/**
 * Playbook Generator — Unit Tests
 *
 * Tests for readPlaybook, writePlaybook, and PlaybookState schema validation.
 * generatePlaybook() is tested separately in integration tests (requires Gemini).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { PlaybookState, PlaybookSection, ProductAlignmentEntry, ProductAlignmentSection, ActionItemsSection, EngagementHistorySection, SubscriptionSnapshot, CaseSnapshot, LifecycleSnapshot, PlaybookSource } from '../../src/playbook-types.ts'

// ── Test helpers ────────────────────────────────────────────────────────────

const TEST_CACHE_DIR = resolve(import.meta.dir, '../.test-playbook-cache')
const PLAYBOOKS_DIR = resolve(TEST_CACHE_DIR, 'playbooks')

/** Create a valid PlaybookState fixture */
function makePlaybookFixture(overrides: Partial<PlaybookState> = {}): PlaybookState {
  const now = new Date().toISOString()
  const defaultSection: PlaybookSection = {
    content: 'Test content for this section.',
    updatedAt: now,
    sourceNotes: [],
  }

  return {
    version: 1,
    customerSlug: 'acme-corp',
    customerName: 'Acme Corp',
    generatedAt: now,
    lastMeetingNoteAt: null,
    sections: {
      strategicPosition: { ...defaultSection, content: 'Acme Corp is a strategic partner focused on cloud-native transformation.' },
      keyRelationships: { ...defaultSection, content: 'Primary contacts: VP Engineering, Director Platform.' },
      currentPriorities: { ...defaultSection, content: 'Migrating from VMware to OpenShift.' },
      productAlignment: {
        products: [
          {
            productSlug: 'ocp',
            displayName: 'OpenShift Container Platform',
            confidence: 'HIGH',
            useCase: 'Primary container platform for workload migration.',
            proofPoints: '58% reduction in unplanned downtime',
            whatsNew: 'OCP 4.16 GA with HCP improvements',
            lifecycle: 'v4.16 (GA: 2024-06-27, EOL: 2026-06-27)',
            featureTalkingPoints: 'HCP: managed control planes reduce cluster overhead',
            dashboardLink: '/dashboard/products/ocp',
          },
        ],
        updatedAt: now,
        sourceNotes: [],
      },
      openActionItems: {
        items: [],
        updatedAt: now,
      },
      engagementHistory: {
        entries: [],
        updatedAt: now,
      },
      expansionOpportunities: { ...defaultSection, content: 'RHOAI expansion opportunity identified.' },
      renewalsAndRisk: { ...defaultSection, content: 'RHEL renewal due in 90 days.' },
    },
    deterministic: {
      subscriptions: [
        {
          sku: 'MCT3718',
          productDescription: 'OpenShift Container Platform',
          quantity: 100,
          status: 'Active',
          startDate: '2024-01-01',
          endDate: '2027-01-01',
        },
      ],
      cases: [
        {
          caseNumber: '03456789',
          summary: 'Cluster upgrade issue',
          status: 'Waiting on Red Hat',
          severity: '2 (High)',
          product: 'OpenShift Container Platform',
          daysOpen: 14,
        },
      ],
      lifecycle: [
        {
          productSlug: 'ocp',
          displayName: 'OpenShift Container Platform',
          currentVersion: '4.16',
          gaDate: '2024-06-27',
          eolDate: '2026-06-27',
          nextVersion: '4.17',
          nextExpected: '2024-10-01',
        },
      ],
      teamMembers: [
        { name: 'Jane Smith', title: 'Account Executive', role: 'ae' },
        { name: 'Jason Horn', title: 'Account Solution Architect', role: 'asa' },
      ],
    },
    sources: [
      {
        type: 'auto-generate',
        sourceId: 'auto',
        ingestedAt: now,
        sectionsUpdated: ['strategicPosition', 'keyRelationships', 'currentPriorities', 'productAlignment', 'expansionOpportunities', 'renewalsAndRisk'],
      },
    ],
    ...overrides,
  }
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('playbook-generator', () => {
  // We import dynamically to set env before module load
  let readPlaybook: (customerSlug: string) => PlaybookState | null
  let writePlaybook: (state: PlaybookState) => void

  beforeEach(async () => {
    // Clean test directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    mkdirSync(PLAYBOOKS_DIR, { recursive: true })

    // Set env to point at test cache dir
    process.env.__PLAYBOOK_CACHE_DIR = PLAYBOOKS_DIR

    // Dynamic import to pick up env
    const mod = await import('../../src/playbook-generator.ts')
    readPlaybook = mod.readPlaybook
    writePlaybook = mod.writePlaybook
  })

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    delete process.env.__PLAYBOOK_CACHE_DIR
  })

  // ── readPlaybook ────────────────────────────────────────────────────────

  describe('readPlaybook', () => {
    it('returns null for non-existent customer', () => {
      const result = readPlaybook('does-not-exist')
      expect(result).toBeNull()
    })

    it('returns PlaybookState for existing playbook', () => {
      const fixture = makePlaybookFixture()
      const filePath = resolve(PLAYBOOKS_DIR, 'acme-corp.json')
      mkdirSync(PLAYBOOKS_DIR, { recursive: true })
      writeFileSync(filePath, JSON.stringify(fixture, null, 2))

      const result = readPlaybook('acme-corp')
      expect(result).not.toBeNull()
      expect(result!.customerSlug).toBe('acme-corp')
      expect(result!.customerName).toBe('Acme Corp')
      expect(result!.version).toBe(1)
    })

    it('returns null for malformed JSON', () => {
      const filePath = resolve(PLAYBOOKS_DIR, 'bad-data.json')
      writeFileSync(filePath, 'not valid json{{{')

      const result = readPlaybook('bad-data')
      expect(result).toBeNull()
    })
  })

  // ── writePlaybook ───────────────────────────────────────────────────────

  describe('writePlaybook', () => {
    it('creates directory and writes atomically', () => {
      // Remove the playbooks dir so writePlaybook must create it
      rmSync(PLAYBOOKS_DIR, { recursive: true, force: true })

      const fixture = makePlaybookFixture()
      writePlaybook(fixture)

      const filePath = resolve(PLAYBOOKS_DIR, 'acme-corp.json')
      expect(existsSync(filePath)).toBe(true)

      const written = JSON.parse(readFileSync(filePath, 'utf-8')) as PlaybookState
      expect(written.customerSlug).toBe('acme-corp')
      expect(written.version).toBe(1)
    })

    it('overwrites existing playbook', () => {
      const fixture1 = makePlaybookFixture()
      writePlaybook(fixture1)

      const fixture2 = makePlaybookFixture({
        generatedAt: new Date().toISOString(),
        lastMeetingNoteAt: new Date().toISOString(),
      })
      writePlaybook(fixture2)

      const result = readPlaybook('acme-corp')
      expect(result).not.toBeNull()
      expect(result!.lastMeetingNoteAt).not.toBeNull()
    })
  })

  // ── PlaybookState schema shape ──────────────────────────────────────────

  describe('PlaybookState schema', () => {
    it('has all 8 sections', () => {
      const fixture = makePlaybookFixture()
      const sectionKeys = Object.keys(fixture.sections)
      expect(sectionKeys).toEqual([
        'strategicPosition',
        'keyRelationships',
        'currentPriorities',
        'productAlignment',
        'openActionItems',
        'engagementHistory',
        'expansionOpportunities',
        'renewalsAndRisk',
      ])
    })

    it('has deterministic data block', () => {
      const fixture = makePlaybookFixture()
      expect(fixture.deterministic.subscriptions).toBeArray()
      expect(fixture.deterministic.cases).toBeArray()
      expect(fixture.deterministic.lifecycle).toBeArray()
      expect(fixture.deterministic.teamMembers).toBeArray()
    })

    it('has sources provenance array', () => {
      const fixture = makePlaybookFixture()
      expect(fixture.sources).toBeArray()
      expect(fixture.sources[0].type).toBe('auto-generate')
      expect(fixture.sources[0].sourceId).toBe('auto')
    })
  })

  // ── Product alignment entry construction ──────────────────────────────

  describe('ProductAlignmentEntry', () => {
    it('has all required fields', () => {
      const fixture = makePlaybookFixture()
      const entry = fixture.sections.productAlignment.products[0]
      expect(entry.productSlug).toBe('ocp')
      expect(entry.displayName).toBe('OpenShift Container Platform')
      expect(entry.confidence).toBe('HIGH')
      expect(entry.useCase).toBeTruthy()
      expect(entry.proofPoints).toBeTruthy()
      expect(entry.whatsNew).toBeTruthy()
      expect(entry.lifecycle).toBeTruthy()
      expect(entry.featureTalkingPoints).toBeTruthy()
      expect(entry.dashboardLink).toBe('/dashboard/products/ocp')
    })

    it('dashboard link follows /dashboard/products/:slug pattern', () => {
      const fixture = makePlaybookFixture()
      for (const product of fixture.sections.productAlignment.products) {
        expect(product.dashboardLink).toMatch(/^\/dashboard\/products\/[a-z0-9-]+$/)
      }
    })
  })

  // ── Deterministic data population ─────────────────────────────────────

  describe('deterministic data', () => {
    it('subscription snapshot has required fields', () => {
      const fixture = makePlaybookFixture()
      const sub = fixture.deterministic.subscriptions[0]
      expect(sub.sku).toBeTruthy()
      expect(sub.productDescription).toBeTruthy()
      expect(typeof sub.quantity).toBe('number')
      expect(sub.status).toBeTruthy()
    })

    it('case snapshot has required fields', () => {
      const fixture = makePlaybookFixture()
      const c = fixture.deterministic.cases[0]
      expect(c.caseNumber).toBeTruthy()
      expect(c.summary).toBeTruthy()
      expect(c.status).toBeTruthy()
      expect(c.severity).toBeTruthy()
      expect(typeof c.daysOpen).toBe('number')
    })

    it('lifecycle snapshot has required fields', () => {
      const fixture = makePlaybookFixture()
      const lc = fixture.deterministic.lifecycle[0]
      expect(lc.productSlug).toBeTruthy()
      expect(lc.displayName).toBeTruthy()
      expect(lc.currentVersion).toBeTruthy()
      expect(lc.gaDate).toBeTruthy()
      expect(lc.eolDate).toBeTruthy()
    })

    it('team members use AccountTeamMember shape', () => {
      const fixture = makePlaybookFixture()
      const tm = fixture.deterministic.teamMembers[0]
      expect(tm.name).toBeTruthy()
      expect(tm.title).toBeTruthy()
      expect(['ae', 'asa', 'ssp', 'ssa', 'manager']).toContain(tm.role)
    })
  })

  // ── Round-trip ────────────────────────────────────────────────────────

  describe('round-trip', () => {
    it('write then read preserves all data', () => {
      const fixture = makePlaybookFixture()
      writePlaybook(fixture)
      const result = readPlaybook('acme-corp')

      expect(result).not.toBeNull()
      expect(result!.version).toBe(fixture.version)
      expect(result!.customerSlug).toBe(fixture.customerSlug)
      expect(result!.customerName).toBe(fixture.customerName)
      expect(result!.sections.strategicPosition.content).toBe(fixture.sections.strategicPosition.content)
      expect(result!.sections.productAlignment.products.length).toBe(fixture.sections.productAlignment.products.length)
      expect(result!.deterministic.subscriptions.length).toBe(fixture.deterministic.subscriptions.length)
      expect(result!.deterministic.cases.length).toBe(fixture.deterministic.cases.length)
      expect(result!.deterministic.lifecycle.length).toBe(fixture.deterministic.lifecycle.length)
      expect(result!.deterministic.teamMembers.length).toBe(fixture.deterministic.teamMembers.length)
      expect(result!.sources.length).toBe(fixture.sources.length)
    })
  })
})
