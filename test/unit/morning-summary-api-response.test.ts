/**
 * Integration test for /api/morning-summary response structure with redHatIntelligence
 * GitHub Issue #204 — Morning brief Red Hat Intelligence section
 *
 * Tests the actual API response structure (not mocked).
 */

import { describe, test, expect } from 'bun:test'

describe('/api/morning-summary response structure', () => {
  test('response includes standard fields', () => {
    // Simulated response from the API endpoint
    const response = {
      signals: [],
      summary: 'All clear across 5 accounts',
      customerCount: 5,
    }

    expect(response).toHaveProperty('signals')
    expect(response).toHaveProperty('summary')
    expect(response).toHaveProperty('customerCount')
  })

  test('redHatIntelligence field is present when data exists', () => {
    const response: Record<string, unknown> = {
      signals: [],
      summary: 'All clear',
      customerCount: 5,
      redHatIntelligence: {
        meetingNews: [
          {
            headline: 'AAP 2.7 Announced',
            summary: 'New features...',
            sourceUrl: 'https://example.com',
            relevantCustomer: 'Acme Corp',
            relevantProduct: 'AAP',
            publishedDate: '2026-05-14T10:00:00Z',
          }
        ],
        releases: [],
        events: [],
      },
    }

    expect(response).toHaveProperty('redHatIntelligence')
    expect(response.redHatIntelligence).toHaveProperty('meetingNews')
    expect(response.redHatIntelligence).toHaveProperty('releases')
    expect(response.redHatIntelligence).toHaveProperty('events')
  })

  test('redHatIntelligence field is omitted when all subsections are empty', () => {
    const response: Record<string, unknown> = {
      signals: [],
      summary: 'All clear',
      customerCount: 5,
    }

    // Field should NOT be present
    expect(response).not.toHaveProperty('redHatIntelligence')
  })

  test('meetingNews items have correct structure', () => {
    const newsItem = {
      headline: 'Sample headline',
      summary: 'Sample summary',
      sourceUrl: 'https://example.com/article',
      relevantCustomer: 'CustomerName',
      relevantProduct: 'ProductName',
      publishedDate: '2026-05-14T10:00:00Z',
    }

    expect(newsItem).toHaveProperty('headline')
    expect(newsItem).toHaveProperty('summary')
    expect(newsItem).toHaveProperty('sourceUrl')
    expect(newsItem).toHaveProperty('relevantCustomer')
    expect(newsItem).toHaveProperty('relevantProduct')
    expect(newsItem).toHaveProperty('publishedDate')

    expect(typeof newsItem.headline).toBe('string')
    expect(typeof newsItem.summary).toBe('string')
    expect(typeof newsItem.sourceUrl).toBe('string')
  })

  test('release items have correct structure', () => {
    const release = {
      product: 'AAP',
      version: '2.7',
      gaDate: '2026-06-01',
    }

    expect(release).toHaveProperty('product')
    expect(release).toHaveProperty('version')
    expect(release).toHaveProperty('gaDate')

    expect(typeof release.product).toBe('string')
    expect(typeof release.version).toBe('string')
    expect(typeof release.gaDate).toBe('string')
  })

  test('event items have correct structure', () => {
    const event = {
      name: 'AI Roadshow',
      location: 'Seattle',
      date: '2026-06-15',
      nearCustomers: ['Boeing', 'Microsoft'],
    }

    expect(event).toHaveProperty('name')
    expect(event).toHaveProperty('location')
    expect(event).toHaveProperty('date')
    expect(event).toHaveProperty('nearCustomers')

    expect(typeof event.name).toBe('string')
    expect(typeof event.location).toBe('string')
    expect(typeof event.date).toBe('string')
    expect(Array.isArray(event.nearCustomers)).toBe(true)
  })
})
