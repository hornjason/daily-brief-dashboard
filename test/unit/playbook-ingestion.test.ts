/**
 * Playbook Ingestion — Unit Tests (GitHub Issue #294)
 *
 * Tests for ingestMeetingNotes(): merges Google Doc meeting notes
 * into an existing playbook via Gemini, updating action items,
 * engagement history, sources, and lastMeetingNoteAt.
 *
 * Gemini is mocked — we test the merge/assembly logic, not Gemini output.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type {
  PlaybookState,
  PlaybookSection,
  ActionItem,
  EngagementEntry,
  PlaybookSource,
} from '../../src/playbook-types.ts'

// ── Test helpers ────────────────────────────────────────────────────────────

const TEST_CACHE_DIR = resolve(import.meta.dir, '../.test-playbook-ingestion-cache')
const PLAYBOOKS_DIR = resolve(TEST_CACHE_DIR, 'playbooks')

/** Create a valid PlaybookState fixture with existing data */
function makePlaybookFixture(overrides: Partial<PlaybookState> = {}): PlaybookState {
  const now = '2026-05-17T10:00:00.000Z'
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
      strategicPosition: { ...defaultSection, content: 'Acme Corp is a strategic partner focused on cloud-native transformation with VMware migration as top priority.' },
      keyRelationships: { ...defaultSection, content: 'Primary contacts: VP Engineering Sarah Chen, Director Platform Mike Rodriguez.' },
      currentPriorities: { ...defaultSection, content: 'Migrating from VMware to OpenShift. Evaluating RHOAI for ML workloads.' },
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
            featureTalkingPoints: 'HCP: managed control planes',
            dashboardLink: '/dashboard/products/ocp',
          },
        ],
        updatedAt: now,
        sourceNotes: [],
      },
      openActionItems: {
        items: [
          {
            id: 'existing-item-1',
            text: 'Schedule POC review with platform team',
            owner: 'Jason Horn',
            sourceNoteId: null,
            createdAt: now,
            completedAt: null,
            status: 'open',
          },
        ],
        updatedAt: now,
      },
      engagementHistory: {
        entries: [
          {
            date: '2026-05-10',
            type: 'meeting',
            summary: 'Initial discovery meeting with Acme platform team.',
            sourceNoteId: null,
            attendees: ['Sarah Chen', 'Jason Horn'],
          },
        ],
        updatedAt: now,
      },
      expansionOpportunities: { ...defaultSection, content: 'RHOAI expansion opportunity identified.' },
      renewalsAndRisk: { ...defaultSection, content: 'RHEL renewal due in 90 days.' },
      swotAnalysis: { ...defaultSection, content: 'Strengths: strong engineering team. Weaknesses: limited cloud experience.' },
      meddpicc: {
        entries: [],
        updatedAt: now,
      },
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

// Mock Gemini response for ingestion
const MOCK_GEMINI_INGESTION_RESPONSE = JSON.stringify({
  updatedSections: {
    strategicPosition: 'Acme Corp is a strategic partner focused on cloud-native transformation with VMware migration as top priority. They confirmed budget approval for Q3 expansion.',
    keyRelationships: 'Primary contacts: VP Engineering Sarah Chen, Director Platform Mike Rodriguez. New stakeholder: CTO David Park joined the initiative.',
    currentPriorities: 'VMware migration accelerated — targeting June completion. RHOAI pilot approved for ML team. Security compliance audit scheduled for July.',
    expansionOpportunities: 'RHOAI expansion confirmed — pilot approved. ACS evaluation requested by security team for compliance needs.',
    renewalsAndRisk: 'RHEL renewal due in 90 days. Risk mitigated — budget approved for multi-year commitment.',
  },
  newActionItems: [
    { text: 'Send RHOAI pilot architecture doc to David Park', owner: 'Jason Horn' },
    { text: 'Schedule ACS demo with security team', owner: 'Jane Smith' },
  ],
  engagementSummary: 'Quarterly business review with Acme leadership. Budget approved for Q3 expansion. RHOAI pilot greenlit. New CTO David Park engaged.',
  meetingDate: '2026-05-18',
  attendees: ['Sarah Chen', 'David Park', 'Jason Horn', 'Jane Smith'],
  sectionsUpdated: ['strategicPosition', 'keyRelationships', 'currentPriorities', 'expansionOpportunities', 'renewalsAndRisk'],
})

// ── Test suite ──────────────────────────────────────────────────────────────

describe('playbook-ingestion', () => {
  let ingestMeetingNotes: typeof import('../../src/playbook-generator.ts').ingestMeetingNotes

  beforeEach(async () => {
    // Clean test directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    mkdirSync(PLAYBOOKS_DIR, { recursive: true })

    // Set env to point at test cache dir
    process.env.__PLAYBOOK_CACHE_DIR = PLAYBOOKS_DIR

    // Mock callGemini before importing
    mock.module('../../src/gemini-call.ts', () => ({
      callGemini: async () => ({
        text: MOCK_GEMINI_INGESTION_RESPONSE,
        cached: false,
        inputTokens: 1000,
        outputTokens: 500,
        model: 'gemini-2.0-flash',
      }),
    }))

    // Dynamic import to pick up env and mocks
    const mod = await import('../../src/playbook-generator.ts')
    ingestMeetingNotes = mod.ingestMeetingNotes
  })

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    delete process.env.__PLAYBOOK_CACHE_DIR
  })

  // ── Action items ──────────────────────────────────────────────────────

  describe('action items', () => {
    it('adds new action items from meeting notes', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Meeting notes content here', 'https://docs.google.com/document/d/abc123/edit')

      // Should have existing + new items
      const items = result.sections.openActionItems.items
      expect(items.length).toBeGreaterThan(1) // existing 1 + at least 1 new

      // New items should have IDs
      const newItems = items.filter(i => i.sourceNoteId === 'abc123')
      expect(newItems.length).toBeGreaterThan(0)
      for (const item of newItems) {
        expect(item.id).toBeTruthy()
        expect(item.text).toBeTruthy()
        expect(item.owner).toBeTruthy()
        expect(item.status).toBe('open')
        expect(item.createdAt).toBeTruthy()
        expect(item.completedAt).toBeNull()
      }
    })

    it('preserves existing action items', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      const items = result.sections.openActionItems.items
      const preserved = items.find(i => i.id === 'existing-item-1')
      expect(preserved).toBeDefined()
      expect(preserved!.text).toBe('Schedule POC review with platform team')
    })
  })

  // ── Engagement history ─────────────────────────────────────────────────

  describe('engagement history', () => {
    it('adds new engagement entry', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      const entries = result.sections.engagementHistory.entries
      expect(entries.length).toBeGreaterThan(1) // existing 1 + new 1

      // Newest first — new entry should be at position 0
      const newEntry = entries[0]
      expect(newEntry.type).toBe('meeting')
      expect(newEntry.summary).toBeTruthy()
      expect(newEntry.sourceNoteId).toBe('abc123')
    })

    it('preserves existing engagement entries', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      const entries = result.sections.engagementHistory.entries
      const preserved = entries.find(e => e.summary.includes('Initial discovery'))
      expect(preserved).toBeDefined()
    })
  })

  // ── lastMeetingNoteAt ──────────────────────────────────────────────────

  describe('lastMeetingNoteAt', () => {
    it('updates lastMeetingNoteAt timestamp', async () => {
      const existing = makePlaybookFixture()
      expect(existing.lastMeetingNoteAt).toBeNull()

      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')
      expect(result.lastMeetingNoteAt).not.toBeNull()
      // Should be a valid ISO date
      expect(new Date(result.lastMeetingNoteAt!).getTime()).toBeGreaterThan(0)
    })
  })

  // ── Sources provenance ─────────────────────────────────────────────────

  describe('sources provenance', () => {
    it('adds meeting-note source entry', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      const meetingSource = result.sources.find(s => s.type === 'meeting-note')
      expect(meetingSource).toBeDefined()
      expect(meetingSource!.sourceId).toBe('abc123')
      expect(meetingSource!.ingestedAt).toBeTruthy()
      expect(meetingSource!.sectionsUpdated.length).toBeGreaterThan(0)
    })

    it('preserves existing source entries', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      const autoSource = result.sources.find(s => s.type === 'auto-generate')
      expect(autoSource).toBeDefined()
      expect(autoSource!.sourceId).toBe('auto')
    })
  })

  // ── Playbook data preservation ─────────────────────────────────────────

  describe('data preservation', () => {
    it('preserves deterministic data (subscriptions, cases, lifecycle)', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      expect(result.deterministic.subscriptions).toEqual(existing.deterministic.subscriptions)
      expect(result.deterministic.cases).toEqual(existing.deterministic.cases)
      expect(result.deterministic.lifecycle).toEqual(existing.deterministic.lifecycle)
      expect(result.deterministic.teamMembers).toEqual(existing.deterministic.teamMembers)
    })

    it('preserves version and customer identity', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      expect(result.version).toBe(1)
      expect(result.customerSlug).toBe('acme-corp')
      expect(result.customerName).toBe('Acme Corp')
    })

    it('preserves product alignment entries', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      // Product alignment is deterministic — should not be overwritten
      expect(result.sections.productAlignment.products.length).toBe(existing.sections.productAlignment.products.length)
      expect(result.sections.productAlignment.products[0].productSlug).toBe('ocp')
    })

    it('updates narrative section content from Gemini merge', async () => {
      const existing = makePlaybookFixture()
      const result = await ingestMeetingNotes(existing, 'Notes', 'https://docs.google.com/document/d/abc123/edit')

      // Updated sections should have new content from Gemini
      expect(result.sections.strategicPosition.content).toContain('budget approval')
      expect(result.sections.strategicPosition.sourceNotes).toContain('abc123')
    })
  })
})
