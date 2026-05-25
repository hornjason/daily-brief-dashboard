/**
 * GitHub Issue #316 — Newsletter events extraction
 *
 * Tests that the cloud-marketplace module extracts event-type signals
 * (office hours, recordings, announcements) from newsletter content
 * and feeds them into the signal stack.
 */

import { describe, test, expect } from 'bun:test'
import {
  extractNewsletterEvents,
  type NewsletterEvent,
} from '../../src/newsletter-events.ts'

const SAMPLE_NEWSLETTER_HTML = `
<p>Join us for the May Cloud Marketplace Office Hours on May 13, 2026 10:00 AM EST.
<a href="https://calendar.google.com/calendar/event?eid=abc123">Add to calendar</a></p>
<p>Watch the recording of last month's session:
<a href="https://drive.google.com/file/d/1abc_recording_xyz/view">April Recording</a></p>
<p>Red Hat Summit Connect 2026 will be held June 15-17 in Boston.</p>
<p>New episode of the Power5 Sales Podcast: Cloud Marketplace Strategies
<a href="https://podcast.redhat.com/power5/ep42">Listen now</a></p>
<p>Upcoming webinar: Maximizing Marketplace ROI on June 5, 2026 2:00 PM EST
<a href="https://events.redhat.com/webinar/marketplace-roi">Register here</a></p>
`

describe('Newsletter event extraction (#316)', () => {
  test('extracts office hours with date and calendar link', () => {
    const events = extractNewsletterEvents(SAMPLE_NEWSLETTER_HTML)
    const officeHours = events.filter(e => e.eventType === 'office-hours')
    expect(officeHours.length).toBeGreaterThanOrEqual(1)
    const oh = officeHours[0]
    expect(oh.title).toContain('Office Hours')
    expect(oh.date).toBeTruthy()
    expect(oh.url).toBeTruthy()
  })

  test('extracts recordings with Drive links', () => {
    const events = extractNewsletterEvents(SAMPLE_NEWSLETTER_HTML)
    const recordings = events.filter(e => e.eventType === 'recording')
    expect(recordings.length).toBeGreaterThanOrEqual(1)
    expect(recordings[0].url).toContain('drive.google.com')
  })

  test('extracts announcements (summit, podcast, webinar)', () => {
    const events = extractNewsletterEvents(SAMPLE_NEWSLETTER_HTML)
    const announcements = events.filter(e => e.eventType === 'announcement')
    expect(announcements.length).toBeGreaterThanOrEqual(1)
  })

  test('returns empty array for content with no events', () => {
    const events = extractNewsletterEvents('<p>No events here, just marketplace data.</p>')
    expect(events).toEqual([])
  })

  test('each event has required fields', () => {
    const events = extractNewsletterEvents(SAMPLE_NEWSLETTER_HTML)
    for (const event of events) {
      expect(event.title).toBeTruthy()
      expect(event.eventType).toMatch(/^(office-hours|recording|announcement)$/)
      expect(event.source).toBe('cloud-marketplace-newsletter')
    }
  })

  test('generates valid signal-compatible output', () => {
    const events = extractNewsletterEvents(SAMPLE_NEWSLETTER_HTML)
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(typeof event.title).toBe('string')
      expect(typeof event.source).toBe('string')
    }
  })
})
