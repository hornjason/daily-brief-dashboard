import { describe, it, expect } from 'bun:test'
import { derivePodKeywordMap } from '../../src/region-config'
import { isEnterpriseTab } from '../../src/territory-sync'

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
