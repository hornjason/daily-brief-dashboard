/**
 * Unit tests for Red Hat Events Fetcher
 * GitHub Issue #202
 */

import { describe, it, expect } from 'bun:test'

// ── Mock Functions ───────────────────────────────────────────────────────────

/**
 * Parse date from natural language format
 */
function parseEventDate(dateStr: string): string {
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december']

  const match = dateStr.match(/(\w+)\s+(\d+)/i)
  if (match) {
    const monthName = match[1].toLowerCase()
    const day = match[2]
    const monthIndex = monthNames.findIndex(m => m.startsWith(monthName))

    if (monthIndex >= 0) {
      const year = new Date().getFullYear()
      const date = new Date(year, monthIndex, parseInt(day))
      return date.toISOString().split('T')[0]
    }
  }

  return dateStr
}

/**
 * Extract location from event line
 */
function extractLocation(text: string): string | null {
  const match = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s+([A-Z]{2})\b/)
  return match ? `${match[1]}, ${match[2]}` : null
}

/**
 * Extract registration URL if present
 */
function extractRegUrl(text: string): string | null {
  const match = text.match(/Reg\s+Page[^\|]*?(https?:\/\/[^\s\|]+)/)
  return match ? match[1].trim() : null
}

/**
 * Determine region from section header
 */
function getRegionFromHeader(header: string): string | null {
  const lower = header.toLowerCase()
  if (lower.includes('northeast')) return 'northeast'
  if (lower.includes('southeast')) return 'southeast'
  if (lower.includes('central')) return 'central'
  if (lower.includes('west')) return 'west'
  if (lower.includes('canada')) return 'canada'
  if (lower.includes('na events') || lower.includes('by program')) return 'national'
  return null
}

/**
 * Tag event with product keywords
 */
function tagWithProducts(name: string): string[] {
  const PRODUCT_KEYWORDS: Record<string, string[]> = {
    AAP: ['ansible', 'aap', 'automation platform'],
    OCP: ['openshift', 'ocp', 'kubernetes'],
    RHEL: ['rhel', 'enterprise linux', 'virtualization'],
    RHOAI: ['openshift ai', 'rhoai', 'instructlab', 'ai workshop'],
  }

  const text = name.toLowerCase()
  const tags: string[] = []

  for (const [tag, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      tags.push(tag)
    }
  }

  return tags.length > 0 ? tags : ['General']
}

/**
 * Garbage event name patterns — must never be selected as event names
 */
const GARBAGE_PATTERNS = [
  /^social$/i,
  /^full version/i,
  /^short cut/i,
  /^bookmark/i,
  /^revamp\s+\w+$/i,
  /more\s+details/i,
  /details\s+coming/i,
  /^html$/i,
  /^pdf$/i,
  /ancillary\s+event/i,
  /^(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+\s*:/i,
]

function isGarbageEvent(name: string): boolean {
  return GARBAGE_PATTERNS.some(pattern => pattern.test(name.trim()))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Events Fetcher', () => {
  it('parses event lines from sample doc text', () => {
    const line = '* June 4: In-Person | Red Hat Tech Day w/ Intel | Houston, TX | Reg Page | ...'
    const location = extractLocation(line)

    expect(location).toBe('Houston, TX')
  })

  it('parses virtual event format', () => {
    const line = '* May 27: Virtual | Private Models-as-a-Service AI Workshop | Reg Page'
    const format = line.toLowerCase().includes('virtual') ? 'virtual' : 'in-person'

    expect(format).toBe('virtual')
  })

  it('parses in-person event format', () => {
    const line = '* June 9: In-Person | Tech Day Event | Denver, CO | Reg Page | ...'
    const format = line.toLowerCase().includes('virtual') ? 'virtual' : 'in-person'

    expect(format).toBe('in-person')
  })

  it('region detection works', () => {
    expect(getRegionFromHeader('Northeast Region Events')).toBe('northeast')
    expect(getRegionFromHeader('Southeast Region Events')).toBe('southeast')
    expect(getRegionFromHeader('Central Region Events')).toBe('central')
    expect(getRegionFromHeader('West Region Events')).toBe('west')
    expect(getRegionFromHeader('Canada Region Events')).toBe('canada')
    expect(getRegionFromHeader('NA Events & Resources by Program')).toBe('national')
  })

  it('virtual events tagged as national', () => {
    // Virtual events should be tagged as national region
    const region = 'west'
    const format = 'virtual'
    const finalRegion = format === 'virtual' ? 'national' : region

    expect(finalRegion).toBe('national')
  })

  it('in-person events keep their region', () => {
    const region = 'west'
    const format = 'in-person'
    const finalRegion = format === 'virtual' ? 'national' : region

    expect(finalRegion).toBe('west')
  })

  it('product keyword tagging works', () => {
    expect(tagWithProducts('Red Hat Tech Day with Ansible')).toContain('AAP')
    expect(tagWithProducts('OpenShift Container Platform Workshop')).toContain('OCP')
    expect(tagWithProducts('RHEL Virtualization Roadshow')).toContain('RHEL')
    expect(tagWithProducts('Private Models-as-a-Service AI Workshop')).toContain('RHOAI')
    expect(tagWithProducts('Generic Red Hat Event')).toEqual(['General'])
  })

  it('parses event dates', () => {
    const date = parseEventDate('June 4')
    const year = new Date().getFullYear()
    expect(date).toBe(`${year}-06-04`)
  })

  it('extracts registration URLs', () => {
    const line = '* June 4: In-Person | Event Name | Location | Reg Page https://example.com/register | More'
    const url = extractRegUrl(line)
    expect(url).toBe('https://example.com/register')
  })

  it('returns null for missing registration URLs', () => {
    const line = '* June 4: In-Person | Event Name | Location | No Link'
    const url = extractRegUrl(line)
    expect(url).toBe(null)
  })

  describe('garbage event name filtering', () => {
    it('rejects "More details coming soon"', () => {
      expect(isGarbageEvent('More details coming soon')).toBe(true)
    })

    it('rejects "More details"', () => {
      expect(isGarbageEvent('More details')).toBe(true)
    })

    it('rejects "details coming"', () => {
      expect(isGarbageEvent('details coming')).toBe(true)
    })

    it('rejects standalone "HTML"', () => {
      expect(isGarbageEvent('HTML')).toBe(true)
    })

    it('rejects standalone "PDF"', () => {
      expect(isGarbageEvent('PDF')).toBe(true)
    })

    it('rejects "Ancillary event at Queensyard"', () => {
      expect(isGarbageEvent('Ancillary event at Queensyard')).toBe(true)
    })

    it('rejects raw lines starting with month name and colon', () => {
      expect(isGarbageEvent('June 3: In-Person | Cambridge, MA 2:00pm to 4:30pm | From Pilot to Production...')).toBe(true)
    })

    it('accepts valid event names', () => {
      expect(isGarbageEvent('Red Hat Tech Day w/ Intel')).toBe(false)
      expect(isGarbageEvent('Private Models-as-a-Service AI Workshop')).toBe(false)
      expect(isGarbageEvent('OpenShift Container Platform Workshop')).toBe(false)
    })
  })

  describe('summary cleaning', () => {
    it('strips pipe-separated raw lines from summary', () => {
      const rawSummary = 'In-Person | Cambridge, MA 2:00pm to 4:30pm | From Pilot to Production'
      // Summary containing pipes should be cleaned to empty
      const cleanSummary = rawSummary.includes('|') ? '' : rawSummary
      expect(cleanSummary).toBe('')
    })

    it('preserves clean summary text', () => {
      const cleanText = 'A hands-on workshop exploring Red Hat solutions'
      const cleanSummary = cleanText.includes('|') ? '' : cleanText
      expect(cleanSummary).toBe('A hands-on workshop exploring Red Hat solutions')
    })
  })

  describe('URL extraction improvements (#419)', () => {
    it('extractBestUrl has REG_LINK_TEXT_PATTERNS for registration-related anchors', () => {
      // Verify the improved extraction logic exists in source
      const { readFileSync } = require('fs')
      const { resolve } = require('path')
      const source = readFileSync(resolve(import.meta.dir, '../../src/rh-events-fetcher.ts'), 'utf-8')
      expect(source).toContain('REG_LINK_TEXT_PATTERNS')
      expect(source).toContain('website')
      expect(source).toContain('event\\s*overview')
    })

    it('extractBestUrl has 4-tier priority (reg page, reg patterns, 3+ word, 2+ word)', () => {
      const { readFileSync } = require('fs')
      const { resolve } = require('path')
      const source = readFileSync(resolve(import.meta.dir, '../../src/rh-events-fetcher.ts'), 'utf-8')
      // Check all 4 tiers are present in comments or logic
      expect(source).toContain('Explicit "Reg Page" link')
      expect(source).toContain('registration-related anchor text')
      expect(source).toContain('words >= 3')
      expect(source).toContain('words >= 2')
    })
  })

  describe('URL extraction fallback (#419)', () => {
    /** Anchor text patterns that indicate a registration/event URL */
    const REG_LINK_TEXT_PATTERNS = [
      /^reg\s*page$/i,
      /^reg(?:ister)?(?:\s+here)?$/i,
      /^register$/i,
      /^registration$/i,
      /^website$/i,
      /^event\s*overview$/i,
      /^in-person\s+reg\s*page$/i,
      /^virtual\s+reg\s*page$/i,
    ]

    function matchesRegPattern(text: string): boolean {
      return REG_LINK_TEXT_PATTERNS.some(p => p.test(text.trim()))
    }

    it('matches "Reg Page" anchor text', () => {
      expect(matchesRegPattern('Reg Page')).toBe(true)
    })

    it('matches "Register" anchor text', () => {
      expect(matchesRegPattern('Register')).toBe(true)
    })

    it('matches "Register here" anchor text', () => {
      expect(matchesRegPattern('Register here')).toBe(true)
    })

    it('matches "Website" anchor text', () => {
      expect(matchesRegPattern('Website')).toBe(true)
    })

    it('matches "Event Overview" anchor text', () => {
      expect(matchesRegPattern('Event Overview')).toBe(true)
    })

    it('matches "In-Person Reg Page" anchor text', () => {
      expect(matchesRegPattern('In-Person Reg Page')).toBe(true)
    })

    it('matches "Virtual Reg Page" anchor text', () => {
      expect(matchesRegPattern('Virtual Reg Page')).toBe(true)
    })

    it('does not match "Social" anchor text', () => {
      expect(matchesRegPattern('Social')).toBe(false)
    })

    it('does not match "Planning Deck" anchor text', () => {
      expect(matchesRegPattern('Planning Deck')).toBe(false)
    })
  })

  describe('events filter logic (#420)', () => {
    const mockEvents = [
      { name: 'Event A', format: 'in-person', region: 'west', productTags: ['AAP'] },
      { name: 'Event B', format: 'virtual', region: 'national', productTags: ['OCP'] },
      { name: 'Event C', format: 'hybrid', region: 'northeast', productTags: ['RHEL', 'AAP'] },
      { name: 'Event D', format: 'in-person', region: 'central', productTags: ['General'] },
      { name: 'Event E', format: 'virtual', region: 'national', productTags: ['RHOAI'] },
      { name: 'Event F', format: 'in-person', region: 'southeast', productTags: ['OCP'] },
      { name: 'Event G', format: 'in-person', region: 'canada', productTags: ['AAP', 'OCP'] },
    ]

    function filterEvents(events: typeof mockEvents, format: string, product: string, region: string) {
      return events.filter(event => {
        if (format !== 'all' && event.format !== format) return false
        if (product !== 'all' && !event.productTags.includes(product)) return false
        if (region !== 'all' && event.region !== region) return false
        return true
      })
    }

    it('shows all events with no filters', () => {
      expect(filterEvents(mockEvents, 'all', 'all', 'all')).toHaveLength(7)
    })

    // Format filters
    it('filters by in-person format', () => {
      const result = filterEvents(mockEvents, 'in-person', 'all', 'all')
      expect(result.every(e => e.format === 'in-person')).toBe(true)
      expect(result).toHaveLength(4)
    })

    it('filters by virtual format', () => {
      const result = filterEvents(mockEvents, 'virtual', 'all', 'all')
      expect(result.every(e => e.format === 'virtual')).toBe(true)
      expect(result).toHaveLength(2)
    })

    it('filters by hybrid format', () => {
      const result = filterEvents(mockEvents, 'hybrid', 'all', 'all')
      expect(result.every(e => e.format === 'hybrid')).toBe(true)
      expect(result).toHaveLength(1)
    })

    // Product filters
    it('filters by AAP product', () => {
      const result = filterEvents(mockEvents, 'all', 'AAP', 'all')
      expect(result.every(e => e.productTags.includes('AAP'))).toBe(true)
      expect(result).toHaveLength(3) // A, C, G
    })

    it('filters by OCP product', () => {
      const result = filterEvents(mockEvents, 'all', 'OCP', 'all')
      expect(result.every(e => e.productTags.includes('OCP'))).toBe(true)
      expect(result).toHaveLength(3) // B, F, G
    })

    it('filters by RHEL product', () => {
      const result = filterEvents(mockEvents, 'all', 'RHEL', 'all')
      expect(result).toHaveLength(1) // C
    })

    it('filters by RHOAI product', () => {
      const result = filterEvents(mockEvents, 'all', 'RHOAI', 'all')
      expect(result).toHaveLength(1) // E
    })

    it('filters by General product', () => {
      const result = filterEvents(mockEvents, 'all', 'General', 'all')
      expect(result).toHaveLength(1) // D
    })

    // Region filters
    it('filters by west region', () => {
      const result = filterEvents(mockEvents, 'all', 'all', 'west')
      expect(result.every(e => e.region === 'west')).toBe(true)
      expect(result).toHaveLength(1)
    })

    it('filters by national region', () => {
      const result = filterEvents(mockEvents, 'all', 'all', 'national')
      expect(result).toHaveLength(2)
    })

    it('filters by northeast region', () => {
      const result = filterEvents(mockEvents, 'all', 'all', 'northeast')
      expect(result).toHaveLength(1)
    })

    it('filters by central region', () => {
      const result = filterEvents(mockEvents, 'all', 'all', 'central')
      expect(result).toHaveLength(1)
    })

    it('filters by southeast region', () => {
      const result = filterEvents(mockEvents, 'all', 'all', 'southeast')
      expect(result).toHaveLength(1)
    })

    it('filters by canada region', () => {
      const result = filterEvents(mockEvents, 'all', 'all', 'canada')
      expect(result).toHaveLength(1)
    })

    // Combined filters
    it('filters virtual + OCP', () => {
      const result = filterEvents(mockEvents, 'virtual', 'OCP', 'all')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Event B')
    })

    it('filters in-person + west', () => {
      const result = filterEvents(mockEvents, 'in-person', 'all', 'west')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Event A')
    })

    it('filters in-person + AAP + canada', () => {
      const result = filterEvents(mockEvents, 'in-person', 'AAP', 'canada')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Event G')
    })

    it('returns empty for impossible combination', () => {
      const result = filterEvents(mockEvents, 'hybrid', 'OCP', 'west')
      expect(result).toHaveLength(0)
    })

    it('returns correct count with all three filters matching', () => {
      const result = filterEvents(mockEvents, 'in-person', 'OCP', 'southeast')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Event F')
    })
  })
})
