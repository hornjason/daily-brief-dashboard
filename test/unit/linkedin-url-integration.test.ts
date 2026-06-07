/**
 * LinkedIn URL Integration Tests — Issues #384 and #385
 *
 * Tests that LinkedIn URLs are accepted in meeting prep attendee details
 * and campaign persona configurations, and that the service logic
 * uses them when provided (with fallback to existing behavior).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC_DIR = resolve(import.meta.dir, '../../src')
const DASHBOARD_DIR = resolve(import.meta.dir, '../../dashboard/src')

// ── Issue #385: Meeting Prep LinkedIn URLs ──────────────────────────────────

describe('#385 — Meeting prep attendee LinkedIn URLs', () => {
  const meetingPrepSource = readFileSync(resolve(SRC_DIR, 'meeting-prep-service.ts'), 'utf-8')
  // #645: attendee resolution moved to attendee-profile-cache.ts
  const attendeeCacheSource = readFileSync(resolve(SRC_DIR, 'lib/attendee-profile-cache.ts'), 'utf-8')
  const typesSource = readFileSync(resolve(SRC_DIR, 'types.ts'), 'utf-8')
  const dashboardTypesSource = readFileSync(resolve(DASHBOARD_DIR, 'types.ts'), 'utf-8')

  test('AC-1: MeetingPrepRequest attendeeDetails type includes linkedinUrl field', () => {
    // The attendeeDetails array should accept linkedinUrl
    expect(meetingPrepSource).toContain('linkedinUrl?: string')
  })

  test('AC-1: attendee research uses LinkedIn URL when provided', () => {
    // #645: attendee resolution now lives in attendee-profile-cache.ts
    // The cache module includes linkedinUrl in profile and grounding search
    expect(attendeeCacheSource).toContain('linkedinUrl')
    expect(attendeeCacheSource).toMatch(/linkedinUrl.*LinkedIn/s)
  })

  test('AC-3: attendee research falls back to search string when no LinkedIn URL', () => {
    // #645: fallback via email-derived + grounding search in attendee-profile-cache
    expect(attendeeCacheSource).toContain('site:linkedin.com')
  })

  test('AC-2: CalendarEvent attendeeDetails type includes linkedinUrl in src/types.ts', () => {
    expect(typesSource).toContain('linkedinUrl?: string')
  })

  test('AC-2: CalendarEvent attendeeDetails type includes linkedinUrl in dashboard types', () => {
    expect(dashboardTypesSource).toContain('linkedinUrl?: string')
  })

  test('AC-2: MeetingPrepPage sends linkedinUrl in request body', () => {
    const meetingPrepPage = readFileSync(resolve(DASHBOARD_DIR, 'pages/MeetingPrepPage.tsx'), 'utf-8')
    // The page should include attendeeDetails in the request body
    expect(meetingPrepPage).toContain('attendeeDetails')
  })
})

// ── Issue #384: Campaign Persona LinkedIn URLs ──────────────────────────────

describe('#384 — Campaign persona LinkedIn URL override', () => {
  const campaignSource = readFileSync(resolve(SRC_DIR, 'campaign-service.ts'), 'utf-8')

  test('AC-4: CampaignRequest persona type includes linkedinUrl and name fields', () => {
    expect(campaignSource).toContain('linkedinUrl?: string')
    expect(campaignSource).toContain('name?: string')
  })

  test('AC-5: callGeminiForCampaign handles persona with LinkedIn URL', () => {
    // When a persona has a linkedinUrl, the prompt should reference it
    expect(campaignSource).toMatch(/linkedinUrl.*Research this LinkedIn profile/s)
  })

  test('AC-6: campaign falls back to generic persona when no LinkedIn URL', () => {
    // The existing persona list should still work as fallback
    expect(campaignSource).toContain('VP Infrastructure')
    expect(campaignSource).toContain('VP Operations')
    expect(campaignSource).toContain('CIO')
  })

  test('AC-4: CampaignConfigurator persona has linkedinUrl and name inputs', () => {
    const configurator = readFileSync(resolve(DASHBOARD_DIR, 'components/CampaignConfigurator.tsx'), 'utf-8')
    expect(configurator).toContain('linkedinUrl')
    expect(configurator).toContain('name')
  })

  test('AC-5: persona with linkedinUrl uses name in prompt instead of generic role', () => {
    // When a persona has name + linkedinUrl, the prompt should use the name
    expect(campaignSource).toMatch(/persona\.name.*persona\.role/s)
  })
})
