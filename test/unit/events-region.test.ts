import { describe, test, expect } from 'bun:test'

// Test the city fallback logic for bug #258
// Root cause: extractLocation() only matches "City, ST" patterns.
// Events like "AWS Summit New York City" have city in name but no state abbreviation.
// These fall back to doc section header region, which can be wrong.

describe('Events region filter — city name fallback (#258)', () => {
  // Import the functions from rh-events-fetcher
  // Note: We need to export these functions to test them
  const { extractLocation, extractLocationFromCityName, getRegionFromLocation } =
    require('../../src/rh-events-fetcher')

  test('NYC in event name maps to northeast', () => {
    const loc = extractLocationFromCityName('AWS Summit New York City')
    expect(loc).toContain('NY')
    expect(getRegionFromLocation(loc)).toBe('northeast')
  })

  test('Washington D.C in event name maps to northeast', () => {
    const loc = extractLocationFromCityName('Ansible Automates Washington D.C')
    expect(loc).toContain('DC')
    expect(getRegionFromLocation(loc)).toBe('northeast')
  })

  test('standard City, ST pattern still works', () => {
    const loc = extractLocation('Event in Las Vegas, NV')
    expect(loc).toBe('Las Vegas, NV')
    expect(getRegionFromLocation(loc)).toBe('west')
  })

  test('Venetian Convention Center maps to west/NV', () => {
    const loc = extractLocationFromCityName('The Venetian Convention and Expo Center')
    expect(loc).toContain('NV')
    expect(getRegionFromLocation(loc)).toBe('west')
  })

  test('extractLocationFromCityName returns null when no city matches', () => {
    const loc = extractLocationFromCityName('Random Event Name With No City')
    expect(loc).toBe(null)
  })

  test('city name fallback is case-insensitive', () => {
    const loc1 = extractLocationFromCityName('Event in new york city')
    const loc2 = extractLocationFromCityName('Event in NEW YORK CITY')
    expect(loc1).toContain('NY')
    expect(loc2).toContain('NY')
  })

  test('Mandalay Bay venue maps to NV/west', () => {
    const loc = extractLocationFromCityName('Red Hat Summit at Mandalay Bay')
    expect(loc).toContain('NV')
    expect(getRegionFromLocation(loc)).toBe('west')
  })

  test('multiple cities: first match wins', () => {
    // "Chicago" appears before "Dallas" in the event name
    const loc = extractLocationFromCityName('Chicago to Dallas flight event')
    expect(loc).toContain('IL') // Chicago is IL, not TX
  })
})
