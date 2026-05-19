/**
 * Unit tests for playbook publish and action item management endpoints
 * GitHub Issue #297
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { PlaybookState } from '../../src/playbook-types.ts'
import type { Customer } from '../../src/types.ts'

// Mock customers
const mockCustomers: Customer[] = [
  {
    name: 'Test Customer',
    accountNumbers: ['12345'],
    ae: 'Test AE',
    asa: 'Test ASA',
    podParentFolderId: 'folder-id',
    podNumber: 1,
  },
]

// Mock playbook with action items
const mockPlaybookWithActions: PlaybookState = {
  version: 1,
  customerSlug: 'test-customer',
  customerName: 'Test Customer',
  generatedAt: '2026-05-18T00:00:00.000Z',
  lastMeetingNoteAt: null,
  sections: {
    strategicPosition: {
      content: 'Strategic position content',
      updatedAt: '2026-05-18T00:00:00.000Z',
      sourceNotes: [],
    },
    keyRelationships: {
      content: 'Key relationships content',
      updatedAt: '2026-05-18T00:00:00.000Z',
      sourceNotes: [],
    },
    currentPriorities: {
      content: 'Current priorities content',
      updatedAt: '2026-05-18T00:00:00.000Z',
      sourceNotes: [],
    },
    productAlignment: {
      products: [],
      updatedAt: '2026-05-18T00:00:00.000Z',
      sourceNotes: [],
    },
    openActionItems: {
      items: [
        {
          id: 'action-1',
          text: 'Follow up on Ansible expansion',
          owner: 'Test AE',
          sourceNoteId: 'note-1',
          createdAt: '2026-05-18T00:00:00.000Z',
          completedAt: null,
          status: 'open',
        },
        {
          id: 'action-2',
          text: 'Schedule renewal discussion',
          owner: 'Test ASA',
          sourceNoteId: 'note-1',
          createdAt: '2026-05-18T00:00:00.000Z',
          completedAt: null,
          status: 'open',
        },
      ],
      updatedAt: '2026-05-18T00:00:00.000Z',
    },
    engagementHistory: {
      entries: [],
      updatedAt: '2026-05-18T00:00:00.000Z',
    },
    expansionOpportunities: {
      content: 'Expansion opportunities content',
      updatedAt: '2026-05-18T00:00:00.000Z',
      sourceNotes: [],
    },
    renewalsAndRisk: {
      content: 'Renewals and risk content',
      updatedAt: '2026-05-18T00:00:00.000Z',
      sourceNotes: [],
    },
  },
  deterministic: {
    subscriptions: [],
    cases: [],
    lifecycle: [],
    teamMembers: [],
  },
  sources: [
    {
      type: 'auto-generate',
      sourceId: 'auto',
      ingestedAt: '2026-05-18T00:00:00.000Z',
      sectionsUpdated: ['strategicPosition'],
    },
  ],
}

// Set up test environment variables
const TEST_CACHE_DIR = resolve(import.meta.dir, '.test-cache-playbook-publish')
process.env.__PLAYBOOK_CACHE_DIR = TEST_CACHE_DIR

describe('playbook publish and action item endpoints', () => {
  beforeEach(() => {
    // Clean up test cache directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true })
  })

  describe('POST /api/customer/:name/playbook/publish', () => {
    test('returns 404 for unknown customer', async () => {
      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Unknown%20Customer/playbook/publish', {
        method: 'POST',
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Customer')
    })

    test('returns 404 when playbook does not exist', async () => {
      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/publish', {
        method: 'POST',
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Playbook not found')
    })

    // This test will be implementation-dependent on actual Drive access
    // Skipping full integration for now - implementation will handle Drive client
  })

  describe('PATCH /api/customer/:name/playbook/action-items/:id', () => {
    test('returns 404 for unknown customer', async () => {
      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Unknown%20Customer/playbook/action-items/action-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Customer')
    })

    test('returns 404 when playbook does not exist', async () => {
      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/action-items/action-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Playbook not found')
    })

    test('returns 404 when action item ID does not exist', async () => {
      // Write playbook file
      const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
      writeFileSync(playbookPath, JSON.stringify(mockPlaybookWithActions))

      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/action-items/nonexistent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Action item not found')
    })

    test('returns 400 when status is missing', async () => {
      // Write playbook file
      const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
      writeFileSync(playbookPath, JSON.stringify(mockPlaybookWithActions))

      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/action-items/action-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('status')
    })

    test('returns 400 when status is invalid', async () => {
      // Write playbook file
      const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
      writeFileSync(playbookPath, JSON.stringify(mockPlaybookWithActions))

      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/action-items/action-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'invalid-status' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid status')
    })

    test('successfully completes an action item', async () => {
      // Write playbook file
      const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
      writeFileSync(playbookPath, JSON.stringify(mockPlaybookWithActions))

      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/action-items/action-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe('action-1')
      expect(body.status).toBe('completed')
      expect(body.completedAt).toBeTruthy()
    })

    test('successfully reopens a completed action item', async () => {
      // Create playbook with completed item
      const playbookWithCompleted = JSON.parse(JSON.stringify(mockPlaybookWithActions))
      playbookWithCompleted.sections.openActionItems.items[0].status = 'completed'
      playbookWithCompleted.sections.openActionItems.items[0].completedAt = '2026-05-18T01:00:00.000Z'

      const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
      writeFileSync(playbookPath, JSON.stringify(playbookWithCompleted))

      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/action-items/action-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe('action-1')
      expect(body.status).toBe('open')
      expect(body.completedAt).toBeNull()
    })
  })

  describe('GET /api/customer/:name/playbook/history', () => {
    test('returns 404 for unknown customer', async () => {
      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Unknown%20Customer/playbook/history', {
        method: 'GET',
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Customer')
    })

    test('returns 404 when playbook does not exist', async () => {
      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/history', {
        method: 'GET',
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Playbook not found')
    })

    test('returns sources array when playbook exists', async () => {
      // Write playbook file
      const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
      writeFileSync(playbookPath, JSON.stringify(mockPlaybookWithActions))

      const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
      const { setCustomers } = await import('../../src/server-state.ts')
      setCustomers(mockCustomers)

      const app = new Hono()
      const router = createPlaybookRouter()
      app.route('/', router)

      const res = await app.request('/api/customer/Test%20Customer/playbook/history', {
        method: 'GET',
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBe(1)
      expect(body[0].type).toBe('auto-generate')
      expect(body[0].sourceId).toBe('auto')
    })
  })
})
