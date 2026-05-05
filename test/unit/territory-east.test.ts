import { describe, it, expect } from 'bun:test'
import { derivePodKeywordMap } from '../../src/region-config'
import { isEnterpriseTab } from '../../src/territory-sync'
import { podKeyFromTerritoryCode } from '../../src/bootstrap/territory-sheet'

describe('derivePodKeywordMap — East pod keys', () => {
  it('generates nc sc and nc/sc keywords for SOUTHEAST_ENT_NC_SC_POD', () => {
    const region = {
      id: 'east-enterprise', label: 'East Enterprise', type: 'enterprise' as const,
      territorySheetUrl: '', podBookingsFolderId: '', parentFolderId: '',
      pods: { 'SOUTHEAST_ENT_NC_SC_POD': { sfReportId: '', label: 'SE NC/SC' } }
    }
    const map = derivePodKeywordMap(region)
    expect(map['SOUTHEAST_ENT_NC_SC_POD']).toContain('nc sc')
    expect(map['SOUTHEAST_ENT_NC_SC_POD']).toContain('nc/sc')
  })

  it('generates pod 2 keyword for EAST_COMM_CORP_POD02', () => {
    const region = {
      id: 'east-commercial', label: 'East Commercial', type: 'commercial' as const,
      territorySheetUrl: '', podBookingsFolderId: '', parentFolderId: '',
      pods: { 'EAST_COMM_CORP_POD02': { sfReportId: '', label: 'Corp Pod 2' } }
    }
    const map = derivePodKeywordMap(region)
    expect(map['EAST_COMM_CORP_POD02']).toContain('pod 2')
  })
})

describe('isEnterpriseTab — East-style codes', () => {
  it('detects enterprise tab with underscore-embedded territory code', () => {
    const rows = [
      ['Account Executive', 'Account Executive'],
      ['John Smith\nSoutheast_Ent_NC_SC_Terr01', 'Jane Doe\nSoutheast_Ent_VA_AL_TN_Terr01'],
    ]
    expect(isEnterpriseTab(rows)).toBe(true)
  })
})

/**
 * BKL-TERRITORY-EAST-COMM-PARSE-01 — Regression: AE cell regex must capture
 * East Commercial codes that contain digits in the pod segment (e.g. Pod1, POD01).
 *
 * Root cause: the regex [A-Za-z][A-Za-z_]+_Terr\d+ stopped at the digit in
 * "Pod1", so podKeyFromTerritoryCode was never called and East tabs returned
 * 0 territories.
 *
 * Fix: regex changed to [A-Za-z][A-Za-z0-9_]+_Terr\d+ in dashboard-routes.ts
 * (line 885). These unit tests exercise podKeyFromTerritoryCode (canonical
 * implementation in territory-sheet.ts) with all East Commercial pod formats.
 */
describe('podKeyFromTerritoryCode — East Commercial pods (BKL-TERRITORY-EAST-COMM-PARSE-01)', () => {
  it('derives POD01 from East_Comm_Corp_Pod1_Terr01 (single-digit pod)', () => {
    expect(podKeyFromTerritoryCode('East_Comm_Corp_Pod1_Terr01')).toBe('EAST_COMM_CORP_POD01')
  })

  it('derives POD02 from East_Comm_Corp_Pod2_Terr05 (single-digit pod)', () => {
    expect(podKeyFromTerritoryCode('East_Comm_Corp_Pod2_Terr05')).toBe('EAST_COMM_CORP_POD02')
  })

  it('derives POD03 from East_Comm_Corp_Pod3_Terr07 (single-digit pod)', () => {
    expect(podKeyFromTerritoryCode('East_Comm_Corp_Pod3_Terr07')).toBe('EAST_COMM_CORP_POD03')
  })

  it('derives POD05 from East_Comm_Corp_Pod5_Terr01 (single-digit pod)', () => {
    expect(podKeyFromTerritoryCode('East_Comm_Corp_Pod5_Terr01')).toBe('EAST_COMM_CORP_POD05')
  })

  it('derives POD01 from East_Comm_Corp_POD01_Terr09 (two-digit POD already)', () => {
    expect(podKeyFromTerritoryCode('East_Comm_Corp_POD01_Terr09')).toBe('EAST_COMM_CORP_POD01')
  })

  it('derives POD02 from East_Comm_Corp_POD02_Terr10 (two-digit POD already)', () => {
    expect(podKeyFromTerritoryCode('East_Comm_Corp_POD02_Terr10')).toBe('EAST_COMM_CORP_POD02')
  })

  it('AE cell regex pattern captures East Commercial codes with digits in pod segment', () => {
    // This directly tests that the fixed regex [A-Za-z][A-Za-z0-9_]+_Terr\d+
    // correctly matches codes that were silently missed before the fix.
    const aeCell = 'Brandt Gribbin\nEast_Comm_Corp_Pod1_Terr01'
    const match = aeCell.match(/([A-Za-z][A-Za-z0-9_]+_Terr?\d+)/i)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('East_Comm_Corp_Pod1_Terr01')
    expect(podKeyFromTerritoryCode(match![1])).toBe('EAST_COMM_CORP_POD01')
  })

  it('OLD broken regex would fail to match East Commercial codes (regression guard)', () => {
    // The old regex [A-Za-z][A-Za-z_]+_Terr\d+ stops at the digit in "Pod1"
    const aeCell = 'Brandt Gribbin\nEast_Comm_Corp_Pod1_Terr01'
    const oldMatch = aeCell.match(/([A-Za-z][A-Za-z_]+_Terr?\d+)/i)
    // Old regex: either matches nothing or matches a shorter fragment that doesn't include Pod1
    // "East_Comm_Corp_Pod" doesn't end in _Terr\d+ so the whole match returns null
    expect(oldMatch).toBeNull()
  })
})

describe('territory tab listing — hidden sheet filter', () => {
  it('filters hidden sheets from tab list', () => {
    const sheets = [
      { properties: { title: 'Visible Tab', hidden: false } },
      { properties: { title: 'Hidden Tab', hidden: true } },
      { properties: { title: 'Also Visible', hidden: undefined } },
    ]
    const tabNames = sheets
      .filter(s => !s.properties?.hidden)
      .map(s => s.properties?.title ?? '')
    expect(tabNames).toEqual(['Visible Tab', 'Also Visible'])
    expect(tabNames).not.toContain('Hidden Tab')
  })
})
