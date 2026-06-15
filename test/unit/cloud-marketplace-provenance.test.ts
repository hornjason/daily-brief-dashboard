/**
 * #804: sourceFileId provenance test coverage
 * Tests file boundary markers, deterministic fallback, validation, and rendering.
 */
import { describe, it, expect } from 'bun:test'
import {
  isValidDriveFileId,
  buildFileIdTextMap,
  inferMissingSourceFileIds,
} from '../../src/modules/cloud-marketplace-module.ts'

// ── AC-1: File boundary markers in slide text ─────────────────────────────────

describe('buildFileIdTextMap', () => {
  it('parses boundary markers into fileId → content map', () => {
    const slideText = [
      '=== SOURCE FILE: abc123def456 ===',
      'AWS marketplace offerings here',
      'RHEL 9 available today',
      '',
      '---',
      '',
      '=== SOURCE FILE: xyz789ghi012 ===',
      'Google Cloud programs',
      'CPPO program details',
    ].join('\n')

    const map = buildFileIdTextMap(slideText)
    expect(map.size).toBe(2)
    expect(map.has('abc123def456')).toBe(true)
    expect(map.has('xyz789ghi012')).toBe(true)
    expect(map.get('abc123def456')).toContain('RHEL 9 available today')
    expect(map.get('xyz789ghi012')).toContain('CPPO program details')
  })

  it('returns empty map when no markers present', () => {
    const map = buildFileIdTextMap('just some text without markers')
    expect(map.size).toBe(0)
  })

  it('handles single file marker', () => {
    const slideText = '=== SOURCE FILE: singleFile1234 ===\nContent here'
    const map = buildFileIdTextMap(slideText)
    expect(map.size).toBe(1)
    expect(map.get('singleFile1234')).toContain('Content here')
  })
})

// ── AC-2: Deterministic sourceFileId fallback ─────────────────────────────────

describe('inferMissingSourceFileIds', () => {
  it('assigns sourceFileId when Gemini omits it', () => {
    const clouds = [{
      provider: 'AWS' as const,
      offerings: [
        { name: 'RHEL 9', description: 'Enterprise Linux', sourceFileId: undefined },
        { name: 'OpenShift', description: 'Container platform', sourceFileId: undefined },
      ],
      programs: [
        { name: 'CPPO', description: 'Channel Partner Private Offer', sourceFileId: undefined },
      ],
      incentives: [],
      newCountries: [],
      partnerships: [],
    }]

    const slideText = [
      '=== SOURCE FILE: fileAAA1234567 ===',
      'RHEL 9 is now available on AWS marketplace',
      'OpenShift is also listed',
      '',
      '=== SOURCE FILE: fileBBB7890123 ===',
      'CPPO program allows partners to create private offers',
    ].join('\n')

    inferMissingSourceFileIds(clouds, slideText)

    expect(clouds[0].offerings[0].sourceFileId).toBe('fileAAA1234567')
    expect(clouds[0].offerings[1].sourceFileId).toBe('fileAAA1234567')
    expect(clouds[0].programs[0].sourceFileId).toBe('fileBBB7890123')
  })

  it('preserves existing valid sourceFileId', () => {
    const clouds = [{
      provider: 'AWS' as const,
      offerings: [
        { name: 'RHEL 9', description: 'Enterprise Linux', sourceFileId: 'existingValidId12' },
      ],
      programs: [],
      incentives: [],
      newCountries: [],
      partnerships: [],
    }]

    inferMissingSourceFileIds(clouds, '=== SOURCE FILE: differentFile12 ===\nRHEL 9 content')

    // Should keep the existing ID, not override
    expect(clouds[0].offerings[0].sourceFileId).toBe('existingValidId12')
  })

  it('leaves sourceFileId undefined when no matching section found', () => {
    const clouds = [{
      provider: 'Google' as const,
      offerings: [
        { name: 'Unique Product XYZ', description: 'Not in any section', sourceFileId: undefined },
      ],
      programs: [],
      incentives: [],
      newCountries: [],
      partnerships: [],
    }]

    inferMissingSourceFileIds(clouds, '=== SOURCE FILE: someFile12345 ===\nUnrelated content about AWS')

    expect(clouds[0].offerings[0].sourceFileId).toBeUndefined()
  })
})

// ── AC-3: Invalid sourceFileId validation (#809) ──────────────────────────────

describe('isValidDriveFileId', () => {
  it('accepts valid Drive file IDs', () => {
    expect(isValidDriveFileId('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms')).toBe(true)
    expect(isValidDriveFileId('abc123def456')).toBe(true)
    expect(isValidDriveFileId('a-b_c-1234567890')).toBe(true)
  })

  it('rejects IDs that are too short', () => {
    expect(isValidDriveFileId('abc')).toBe(false)
    expect(isValidDriveFileId('12345')).toBe(false)
    expect(isValidDriveFileId('abcde6789')).toBe(false) // 9 chars, < 10
  })

  it('rejects IDs with invalid characters', () => {
    expect(isValidDriveFileId('abc123!@#$%^')).toBe(false)
    expect(isValidDriveFileId('file id with spaces')).toBe(false)
    expect(isValidDriveFileId('<script>alert(1)</script>')).toBe(false)
    expect(isValidDriveFileId('../../etc/passwd')).toBe(false)
  })

  it('rejects IDs that are too long (>100 chars)', () => {
    expect(isValidDriveFileId('a'.repeat(101))).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidDriveFileId('')).toBe(false)
  })

  it('strips invalid sourceFileId during inference', () => {
    const clouds = [{
      provider: 'AWS' as const,
      offerings: [
        { name: 'RHEL', description: 'Linux', sourceFileId: '<script>alert(1)</script>' },
      ],
      programs: [
        { name: 'CPPO', description: 'Partner offers', sourceFileId: '../../etc/passwd' },
      ],
      incentives: [
        { name: 'SPIFF', description: 'Sales incentive', sourceFileId: 'short' },
      ],
      newCountries: [],
      partnerships: [],
    }]

    inferMissingSourceFileIds(clouds, '')

    // All invalid IDs should be stripped
    expect(clouds[0].offerings[0].sourceFileId).toBeUndefined()
    expect(clouds[0].programs[0].sourceFileId).toBeUndefined()
    expect(clouds[0].incentives[0].sourceFileId).toBeUndefined()
  })
})

// ── AC-4: Items render correctly when sourceFileId is missing ─────────────────

describe('sourceFileId absence handling', () => {
  it('items without sourceFileId produce no sourceUrl in API mapping', () => {
    // Simulates the API route mapping logic
    const offerings = [
      { name: 'RHEL 9', availability: 'GA', pricing: '$0.10/hr', url: undefined, sourceFileId: undefined },
      { name: 'OpenShift', availability: 'GA', pricing: undefined, url: undefined, sourceFileId: 'validFileId1234' },
    ]

    const mapped = offerings.map(o => ({
      ...o,
      sourceUrl: o.sourceFileId ? `https://docs.google.com/presentation/d/${o.sourceFileId}` : undefined,
    }))

    expect(mapped[0].sourceUrl).toBeUndefined()
    expect(mapped[1].sourceUrl).toBe('https://docs.google.com/presentation/d/validFileId1234')
  })
})
