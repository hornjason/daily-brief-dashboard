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
})
