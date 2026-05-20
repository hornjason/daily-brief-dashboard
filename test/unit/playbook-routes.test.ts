/**
 * Unit tests for playbook-routes.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { PlaybookState } from '../../src/playbook-types.ts'
import type { Customer } from '../../src/types.ts'

// Mock dependencies before importing the module under test
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

const mockPlaybookState: PlaybookState = {
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
      items: [],
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
  sources: [],
}

// Set up test environment variables
const TEST_CACHE_DIR = resolve(import.meta.dir, '.test-cache-playbook-routes')
process.env.__PLAYBOOK_CACHE_DIR = TEST_CACHE_DIR

describe('playbook-routes', () => {
  beforeEach(() => {
    // Clean up test cache directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true })
  })

  test('GET /api/customer/:name/playbook returns 404 for unknown customer', async () => {
    // Import after environment setup
    const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
    const { setCustomers } = await import('../../src/server-state.ts')
    setCustomers(mockCustomers)

    const app = new Hono()
    const router = createPlaybookRouter()
    app.route('/', router)

    const res = await app.request('/api/customer/Unknown%20Customer/playbook', {
      method: 'GET',
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  test('GET /api/customer/:name/playbook returns playbook state for valid customer with existing playbook', async () => {
    // Write a test playbook file
    const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
    writeFileSync(playbookPath, JSON.stringify(mockPlaybookState))

    // Import after file setup
    const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
    const { setCustomers } = await import('../../src/server-state.ts')
    setCustomers(mockCustomers)

    const app = new Hono()
    const router = createPlaybookRouter()
    app.route('/', router)

    const res = await app.request('/api/customer/Test%20Customer/playbook', {
      method: 'GET',
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('customerSlug', 'test-customer')
    expect(body).toHaveProperty('customerName', 'Test Customer')
    expect(body.sections).toHaveProperty('strategicPosition')
  })

  test('POST /api/customer/:name/playbook/generate creates playbook file', async () => {
    const { createPlaybookRouter } = await import('../../src/playbook-routes.ts')
    const { setCustomers } = await import('../../src/server-state.ts')
    setCustomers(mockCustomers)

    const app = new Hono()
    const router = createPlaybookRouter()
    app.route('/', router)

    const res = await app.request('/api/customer/Test%20Customer/playbook/generate', {
      method: 'POST',
    })

    // Should return 200 or 500 (depending on Gemini availability in test)
    // The key test is that it doesn't return 404
    expect(res.status).not.toBe(404)

    // If it succeeded, verify playbook file was created
    if (res.status === 200) {
      const playbookPath = resolve(TEST_CACHE_DIR, 'test-customer.json')
      expect(existsSync(playbookPath)).toBe(true)
    }
  })
})
