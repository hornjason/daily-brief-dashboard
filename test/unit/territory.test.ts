import { describe, test, expect } from 'bun:test'
import { parseTerritoryParts } from '../../src/lib/territory.ts'
import { enterpriseTerritoryKey } from '../../src/territory-sync.ts'
import type { RegionConfig } from '../../src/region-config.ts'

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

  // ── #719: Multi-word enterprise subregion support ────────────────────────
  test('#719 AC-1: multi-word enterprise subregion (HIGH_PLAINS)', () => {
    const result = parseTerritoryParts('CENTRAL_ENT_HIGH_PLAINS_TERR03')
    expect(result).toEqual({
      pod: 'CENTRAL_ENT_HIGH_PLAINS_POD',
      subregion: 'CENTRAL_ENT_HIGH_PLAINS',
      segment: 'Enterprise',
      subsegment: 'Enterprise',
      region: 'CENTRAL',
    })
  })

  test('#719 AC-2: standard 4-part enterprise no regression', () => {
    const result = parseTerritoryParts('CENTRAL_ENT_TOLA_TERR03')
    expect(result).toEqual({
      pod: 'CENTRAL_ENT_TOLA_POD',
      subregion: 'CENTRAL_ENT_TOLA',
      segment: 'Enterprise',
      subsegment: 'Enterprise',
      region: 'CENTRAL',
    })
  })

  test('#719 AC-3: 5-part commercial territory no regression', () => {
    const result = parseTerritoryParts('WEST_COMM_CORP_NORTHWEST_TERR01')
    expect(result).toEqual({
      pod: 'WEST_COMM_CORP_NORTHWEST',
      subregion: 'WEST_COMM_CORP',
      segment: 'Commercial',
      subsegment: 'Commercial',
      region: 'NA_COMM_COMMERCIAL',
    })
  })
})

// ── #712: extractEnterpriseAeMap prefix preservation ──────────────────────

describe('extractEnterpriseAeMap — prefix preservation (#712)', () => {
  const { extractEnterpriseAeMap } = require('../../src/territory-sync.ts')

  test('AC-1: combined cell preserves territory prefix (High_Plains_Terr03)', () => {
    const rows: string[][] = [
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
      ['', 'Account Executive', 'Account Executive'],
      ['', 'Jeff Veldhuizen\nHigh_Plains_Terr03', 'Jane Smith\nTOLA_Terr01'],
    ]
    const result = extractEnterpriseAeMap(rows)
    expect(result['Jeff Veldhuizen']).toEqual(['High_Plains_Terr03'])
    expect(result['Jane Smith']).toEqual(['TOLA_Terr01'])
  })

  test('AC-1: separate-row format preserves territory prefix', () => {
    const rows: string[][] = [
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
      ['', 'Account Executive', ''],
      ['', 'Jeff Veldhuizen', ''],
      ['', 'High_Plains_Terr03', ''],
    ]
    const result = extractEnterpriseAeMap(rows)
    expect(result['Jeff Veldhuizen']).toEqual(['High_Plains_Terr03'])
  })

  test('bare Terr code (no prefix) still works', () => {
    const rows: string[][] = [
      ['Account Executive'],
      ['Bob Jones\nTerr05'],
    ]
    const result = extractEnterpriseAeMap(rows)
    expect(result['Bob Jones']).toEqual(['Terr05'])
  })
})

// ── enterpriseTerritoryKey — declarative prefix routing (#635) ──────────────

describe('enterpriseTerritoryKey — prefix routing (#635)', () => {
  const makeRegion = (pods: Record<string, { sfReportId: string; label: string; hidden?: boolean; prefixes?: string[] }>): RegionConfig => ({
    id: 'central-enterprise',
    label: 'Central Enterprise',
    type: 'enterprise',
    territorySheetUrl: '',
    podBookingsFolderId: '',
    parentFolderId: '',
    pods,
  })

  const multiPodRegion = makeRegion({
    CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
    CENTRAL_ENT_HIGH_PLAINS: { sfReportId: 'r2', label: 'High Plains', hidden: true, prefixes: ['High_Plains'] },
  })

  test('High_Plains_ prefix routes to HP pod', () => {
    expect(enterpriseTerritoryKey(multiPodRegion, 'High_Plains_Terr03')).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR03')
  })

  test('TOLA_ prefix routes to default (non-prefix) pod', () => {
    expect(enterpriseTerritoryKey(multiPodRegion, 'TOLA_Terr01')).toBe('CENTRAL_ENT_TOLA_TERR01')
  })

  test('bare Terr routes to default (non-prefix) pod', () => {
    expect(enterpriseTerritoryKey(multiPodRegion, 'Terr05')).toBe('CENTRAL_ENT_TOLA_TERR05')
  })

  test('prefix matching is case-insensitive', () => {
    expect(enterpriseTerritoryKey(multiPodRegion, 'high_plains_Terr07')).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR07')
  })

  test('hypothetical third prefix group routes correctly', () => {
    const threePodRegion = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
      CENTRAL_ENT_HIGH_PLAINS: { sfReportId: 'r2', label: 'High Plains', hidden: true, prefixes: ['High_Plains'] },
      CENTRAL_ENT_TOLA_MW: { sfReportId: 'r3', label: 'Mountain West', hidden: true, prefixes: ['Mountain_West'] },
    })
    expect(enterpriseTerritoryKey(threePodRegion, 'Mountain_West_Terr02')).toBe('CENTRAL_ENT_TOLA_MW_TERR02')
    // Non-prefixed still routes to default
    expect(enterpriseTerritoryKey(threePodRegion, 'Terr01')).toBe('CENTRAL_ENT_TOLA_TERR01')
  })

  test('single-pod region (no prefixes) still works', () => {
    const singlePod = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
    })
    expect(enterpriseTerritoryKey(singlePod, 'Terr04')).toBe('CENTRAL_ENT_TOLA_TERR04')
  })

  test('adding a new prefix group is config-only — no code change needed', () => {
    // This test proves AC-5: a new group just needs a prefixes entry
    const fourPodRegion = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
      CENTRAL_ENT_HIGH_PLAINS: { sfReportId: 'r2', label: 'High Plains', prefixes: ['High_Plains'] },
      CENTRAL_ENT_TOLA_MW: { sfReportId: 'r3', label: 'Mountain West', prefixes: ['Mountain_West'] },
      CENTRAL_ENT_TOLA_GL: { sfReportId: 'r4', label: 'Great Lakes', prefixes: ['Great_Lakes'] },
    })
    expect(enterpriseTerritoryKey(fourPodRegion, 'Great_Lakes_Terr09')).toBe('CENTRAL_ENT_TOLA_GL_TERR09')
    expect(enterpriseTerritoryKey(fourPodRegion, 'Mountain_West_Terr02')).toBe('CENTRAL_ENT_TOLA_MW_TERR02')
    expect(enterpriseTerritoryKey(fourPodRegion, 'High_Plains_Terr03')).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR03')
    expect(enterpriseTerritoryKey(fourPodRegion, 'Terr01')).toBe('CENTRAL_ENT_TOLA_TERR01')
  })
})

// ── #742: enterpriseTerritoryKey — prefix sorting longest-first ──────────────

describe('enterpriseTerritoryKey — prefix routing (#742)', () => {
  const makeRegion = (pods: Record<string, { sfReportId: string; label: string; hidden?: boolean; prefixes?: string[] }>): RegionConfig => ({
    id: 'central-enterprise',
    label: 'Central Enterprise',
    type: 'enterprise',
    territorySheetUrl: '',
    podBookingsFolderId: '',
    parentFolderId: '',
    pods,
  })

  test('AC-1: prefixes sorted longest-first — High_Plains matches before Plains', () => {
    const region = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
      CENTRAL_ENT_TOLA_P: { sfReportId: 'r2', label: 'Plains', hidden: true, prefixes: ['Plains'] },
      CENTRAL_ENT_HIGH_PLAINS: { sfReportId: 'r3', label: 'High Plains', hidden: true, prefixes: ['High_Plains'] },
    })
    // High_Plains must route to HP, not P (substring collision prevented)
    expect(enterpriseTerritoryKey(region, 'High_Plains_Terr03')).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR03')
    // Plains still routes to P
    expect(enterpriseTerritoryKey(region, 'Plains_Terr01')).toBe('CENTRAL_ENT_TOLA_P_TERR01')
  })

  test('AC-2: "Plains" prefix does not match "High_Plains" territory', () => {
    const region = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
      CENTRAL_ENT_TOLA_P: { sfReportId: 'r2', label: 'Plains', hidden: true, prefixes: ['Plains'] },
      CENTRAL_ENT_HIGH_PLAINS: { sfReportId: 'r3', label: 'High Plains', hidden: true, prefixes: ['High_Plains'] },
    })
    const result = enterpriseTerritoryKey(region, 'High_Plains_Terr05')
    expect(result).not.toContain('_P_TERR')
    expect(result).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR05')
  })

  test('AC-3: existing routing unchanged for non-colliding prefixes', () => {
    const region = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
      CENTRAL_ENT_HIGH_PLAINS: { sfReportId: 'r2', label: 'High Plains', hidden: true, prefixes: ['High_Plains'] },
    })
    expect(enterpriseTerritoryKey(region, 'High_Plains_Terr03')).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR03')
    expect(enterpriseTerritoryKey(region, 'TOLA_Terr01')).toBe('CENTRAL_ENT_TOLA_TERR01')
    expect(enterpriseTerritoryKey(region, 'Terr05')).toBe('CENTRAL_ENT_TOLA_TERR05')
  })

  test('bare Terr code routes to default (non-prefix) pod', () => {
    const region = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
    })
    expect(enterpriseTerritoryKey(region, 'Terr04')).toBe('CENTRAL_ENT_TOLA_TERR04')
  })

  test('prefix matching is case-insensitive', () => {
    const region = makeRegion({
      CENTRAL_ENT_TOLA: { sfReportId: 'r1', label: 'TOLA' },
      CENTRAL_ENT_HIGH_PLAINS: { sfReportId: 'r2', label: 'High Plains', hidden: true, prefixes: ['High_Plains'] },
    })
    expect(enterpriseTerritoryKey(region, 'high_plains_Terr07')).toBe('CENTRAL_ENT_HIGH_PLAINS_TERR07')
  })
})
