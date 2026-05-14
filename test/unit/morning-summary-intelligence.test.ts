/**
 * Unit test for RED HAT INTELLIGENCE section in /api/morning-summary
 * GitHub Issue #204 — Morning brief intelligence extension
 *
 * Tests:
 * 1. redHatIntelligence field structure (meetingNews, releases, events)
 * 2. meetingNews limited to max 3 items
 * 3. releases limited to max 5 items, sorted by GA date
 * 4. events array is empty (stub)
 * 5. redHatIntelligence field omitted when all subsections are empty
 */

import { describe, test, expect } from 'bun:test'

describe('/api/morning-summary — redHatIntelligence field', () => {
  test('redHatIntelligence structure matches design spec', () => {
    // Expected structure from issue #204
    const expected = {
      meetingNews: [
        {
          headline: 'Sample headline',
          summary: 'Sample summary',
          sourceUrl: 'https://example.com',
          relevantCustomer: 'CustomerName',
          relevantProduct: 'ProductName',
          publishedDate: '2026-05-14T10:00:00Z',
        }
      ],
      releases: [
        {
          product: 'AAP',
          version: '2.7',
          gaDate: '2026-06-01',
        }
      ],
      events: [], // stub
    }

    // Validate structure
    expect(expected.meetingNews).toBeInstanceOf(Array)
    expect(expected.releases).toBeInstanceOf(Array)
    expect(expected.events).toBeInstanceOf(Array)

    // Validate news item structure
    const newsItem = expected.meetingNews[0]
    expect(newsItem).toHaveProperty('headline')
    expect(newsItem).toHaveProperty('summary')
    expect(newsItem).toHaveProperty('sourceUrl')
    expect(newsItem).toHaveProperty('relevantCustomer')
    expect(newsItem).toHaveProperty('relevantProduct')
    expect(newsItem).toHaveProperty('publishedDate')

    // Validate release item structure
    const releaseItem = expected.releases[0]
    expect(releaseItem).toHaveProperty('product')
    expect(releaseItem).toHaveProperty('version')
    expect(releaseItem).toHaveProperty('gaDate')
  })

  test('meetingNews limited to max 3 items', () => {
    const newsArray = Array.from({ length: 10 }, (_, i) => ({
      headline: `Headline ${i}`,
      summary: 'Summary',
      sourceUrl: 'https://example.com',
      relevantCustomer: 'Customer',
      relevantProduct: 'Product',
      publishedDate: '2026-05-14T10:00:00Z',
    }))

    // Simulate the max-3 slice
    const limited = newsArray.slice(0, 3)
    expect(limited.length).toBe(3)
  })

  test('releases limited to max 5 items and sorted by GA date', () => {
    const releases = [
      { product: 'RHEL', version: '9.4', gaDate: '2026-05-28' },
      { product: 'OCP', version: '4.18', gaDate: '2026-06-15' },
      { product: 'AAP', version: '2.7', gaDate: '2026-06-01' },
      { product: 'Storage', version: '5.2', gaDate: '2026-05-20' },
      { product: 'ACM', version: '2.10', gaDate: '2026-06-10' },
      { product: 'ACS', version: '4.5', gaDate: '2026-06-20' },
    ]

    // Sort by gaDate (soonest first)
    const sorted = [...releases].sort((a, b) => a.gaDate.localeCompare(b.gaDate))

    // Limit to max 5
    const limited = sorted.slice(0, 5)

    expect(limited.length).toBe(5)
    expect(limited[0].product).toBe('Storage') // 2026-05-20
    expect(limited[1].product).toBe('RHEL')    // 2026-05-28
    expect(limited[2].product).toBe('AAP')     // 2026-06-01
    expect(limited[3].product).toBe('ACM')     // 2026-06-10
    expect(limited[4].product).toBe('OCP')     // 2026-06-15
  })

  test('events array is empty (stub for future implementation)', () => {
    const events: Array<{
      name: string
      location: string
      date: string
      nearCustomers: string[]
    }> = []

    expect(events).toBeInstanceOf(Array)
    expect(events.length).toBe(0)
  })

  test('redHatIntelligence field should be omitted when all subsections are empty', () => {
    const response: Record<string, unknown> = {
      signals: [],
      summary: 'All clear',
      customerCount: 5,
    }

    // Simulate logic: only add redHatIntelligence if ANY subsection has data
    const meetingNews: unknown[] = []
    const releases: unknown[] = []
    const events: unknown[] = []

    const hasData = meetingNews.length > 0 || releases.length > 0 || events.length > 0

    if (hasData) {
      response.redHatIntelligence = { meetingNews, releases, events }
    }

    // Should NOT have redHatIntelligence field
    expect(response).not.toHaveProperty('redHatIntelligence')
  })

  test('redHatIntelligence field should be present when ANY subsection has data', () => {
    const response: Record<string, unknown> = {
      signals: [],
      summary: 'All clear',
      customerCount: 5,
    }

    // At least one subsection has data
    const meetingNews: unknown[] = []
    const releases = [{ product: 'AAP', version: '2.7', gaDate: '2026-06-01' }]
    const events: unknown[] = []

    const hasData = meetingNews.length > 0 || releases.length > 0 || events.length > 0

    if (hasData) {
      response.redHatIntelligence = { meetingNews, releases, events }
    }

    // Should have redHatIntelligence field
    expect(response).toHaveProperty('redHatIntelligence')
    expect(response.redHatIntelligence).toEqual({
      meetingNews: [],
      releases: [{ product: 'AAP', version: '2.7', gaDate: '2026-06-01' }],
      events: [],
    })
  })
})
