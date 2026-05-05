import { describe, test, expect } from 'bun:test'
import { parseTerritoryParts } from '../../src/lib/territory.ts'

describe('parseTerritoryParts', () => {
  test('parses a 5-part commercial territory', () => {
    const result = parseTerritoryParts('WEST_COMM_CORP_NORTHWEST_TERR01')
    expect(result).toEqual({
      pod: 'WEST_COMM_CORP_NORTHWEST',
      subregion: 'WEST_COMM_CORP',
      segment: 'Commercial',
      subsegment: 'Commercial',
      region: 'NA_COMM_COMMERCIAL',
    })
  })

  test('parses a 4-part enterprise territory and appends _POD suffix', () => {
    const result = parseTerritoryParts('CENTRAL_ENT_TOLA_TERR02')
    expect(result).toEqual({
      pod: 'CENTRAL_ENT_TOLA_POD',
      subregion: 'CENTRAL_ENT_TOLA',
      segment: 'Enterprise',
      subsegment: 'Enterprise',
      region: 'CENTRAL',
    })
  })

  test('uses the first segment as region for enterprise (EAST)', () => {
    const result = parseTerritoryParts('EAST_ENT_FINANCE_TERR05')
    expect(result.region).toBe('EAST')
    expect(result.segment).toBe('Enterprise')
    expect(result.pod).toBe('EAST_ENT_FINANCE_POD')
    expect(result.subregion).toBe('EAST_ENT_FINANCE')
  })

  test('commercial pod is everything except the trailing segment', () => {
    const result = parseTerritoryParts('SOUTH_COMM_RETAIL_SOUTHEAST_TERR07')
    expect(result.pod).toBe('SOUTH_COMM_RETAIL_SOUTHEAST')
    expect(result.region).toBe('NA_COMM_COMMERCIAL')
    expect(result.segment).toBe('Commercial')
  })

  test('throws on invalid territory format containing dashes', () => {
    expect(() => parseTerritoryParts('WEST-COMM-CORP-TERR01')).toThrow(
      /Invalid territory format/,
    )
  })

  test('throws on invalid territory format with whitespace', () => {
    expect(() => parseTerritoryParts('WEST COMM CORP TERR01')).toThrow(
      /Invalid territory format/,
    )
  })
})
