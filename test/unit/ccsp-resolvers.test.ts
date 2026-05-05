// BKL-ARCH-06: Tests for CcspSourceResolver chain extracted from fetchCCSPData.
//
// Each resolver gets a CcspResolverContext containing a Sheets client. The
// real client is replaced here with a hand-built mock that records calls and
// returns fixture data. No network, no Drive auth.

import { test, expect, describe, mock } from 'bun:test'
import {
  KnownSheetResolver,
  TabDiscoveryResolver,
  DriveFolderResolver,
  runResolverChain,
  parseCcspRows,
  type CcspResolverContext,
  type CcspSourceResolver,
} from '../../src/lib/ccsp-resolvers.ts'

// ── Sheets client mock ───────────────────────────────────────────────────────
//
// The googleapis Sheets client only needs three call sites for these tests:
//   sheets.spreadsheets.values.get({ spreadsheetId, range })
//   sheets.spreadsheets.get({ spreadsheetId, fields })
//
// We build per-test mocks that resolve each call using a small in-memory map
// keyed on spreadsheetId+tab.

interface MockSheet {
  fileName?: string
  tabs: string[]
  // tab → rows
  data: Record<string, unknown[][]>
}

function makeMockSheets(sheets: Record<string, MockSheet>): any {
  return {
    spreadsheets: {
      get: mock(async ({ spreadsheetId }: any) => {
        const s = sheets[spreadsheetId]
        if (!s) throw new Error(`mock: unknown spreadsheet ${spreadsheetId}`)
        return {
          data: {
            properties: { title: s.fileName ?? 'untitled' },
            sheets: s.tabs.map((title) => ({ properties: { title } })),
          },
        }
      }),
      values: {
        get: mock(async ({ spreadsheetId, range }: any) => {
          const s = sheets[spreadsheetId]
          if (!s) throw new Error(`mock: unknown spreadsheet ${spreadsheetId}`)
          // range looks like: 'TabName'!A:AM
          const m = /^'(.+)'!/.exec(range)
          const tab = m ? m[1].replace(/''/g, "'") : ''
          const rows = s.data[tab]
          if (rows === undefined) throw new Error(`mock: tab '${tab}' not found in ${spreadsheetId}`)
          return { data: { values: rows } }
        }),
      },
    },
  }
}

const HEADER_ROW = ['Account Name', 'Fiscal Year Quarter', 'Opportunity Close Date', 'Financial Partner', 'ACV Plus']
const SAMPLE_ROW = ['ACME', '2025-Q1', '2025-03-15', 'Amazon AWS', '12345.67']

// ── KnownSheetResolver ───────────────────────────────────────────────────────

describe('KnownSheetResolver', () => {
  test('returns rows when known tab has ≥2 rows', async () => {
    const sheets = makeMockSheets({
      sheet1: { tabs: ['CCSP Data'], data: { 'CCSP Data': [HEADER_ROW, SAMPLE_ROW] } },
    })
    const ctx: CcspResolverContext = { spreadsheetId: 'sheet1', knownTab: 'CCSP Data', sheets }
    const result = await KnownSheetResolver.resolve(ctx)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(2)
  })

  test('returns null when known tab has <2 rows', async () => {
    const sheets = makeMockSheets({
      sheet1: { tabs: ['CCSP Data'], data: { 'CCSP Data': [HEADER_ROW] } },
    })
    const ctx: CcspResolverContext = { spreadsheetId: 'sheet1', knownTab: 'CCSP Data', sheets }
    expect(await KnownSheetResolver.resolve(ctx)).toBeNull()
  })

  test('returns null when known tab does not exist (read throws)', async () => {
    const sheets = makeMockSheets({
      sheet1: { tabs: ['Other'], data: { Other: [HEADER_ROW, SAMPLE_ROW] } },
    })
    const ctx: CcspResolverContext = { spreadsheetId: 'sheet1', knownTab: 'CCSP Data', sheets }
    expect(await KnownSheetResolver.resolve(ctx)).toBeNull()
  })
})

// ── TabDiscoveryResolver ─────────────────────────────────────────────────────

describe('TabDiscoveryResolver', () => {
  test('finds a ccsp-named tab and returns its rows', async () => {
    const sheets = makeMockSheets({
      sheet1: {
        tabs: ['Summary', 'CCSP Data 2024'],
        data: {
          Summary: [],
          'CCSP Data 2024': [HEADER_ROW, SAMPLE_ROW, SAMPLE_ROW],
        },
      },
    })
    const ctx: CcspResolverContext = { spreadsheetId: 'sheet1', knownTab: 'CCSP Data', sheets }
    const result = await TabDiscoveryResolver.resolve(ctx)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(3)
  })

  test('returns null when no tabs have data', async () => {
    const sheets = makeMockSheets({
      sheet1: {
        tabs: ['Summary', 'Other'],
        data: { Summary: [], Other: [] },
      },
    })
    const ctx: CcspResolverContext = { spreadsheetId: 'sheet1', knownTab: 'CCSP Data', sheets }
    expect(await TabDiscoveryResolver.resolve(ctx)).toBeNull()
  })

  test('falls back to all tabs when no ccsp-named tab exists', async () => {
    const sheets = makeMockSheets({
      sheet1: {
        tabs: ['Sheet1', 'Sheet2'],
        data: {
          Sheet1: [],
          Sheet2: [HEADER_ROW, SAMPLE_ROW],
        },
      },
    })
    const ctx: CcspResolverContext = { spreadsheetId: 'sheet1', knownTab: 'CCSP Data', sheets }
    const result = await TabDiscoveryResolver.resolve(ctx)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(2)
  })
})

// ── DriveFolderResolver ──────────────────────────────────────────────────────

describe('DriveFolderResolver', () => {
  test('returns rows when drive folder has alternative ccsp spreadsheet', async () => {
    const sheets = makeMockSheets({
      empty1: { tabs: ['CCSP Data'], data: { 'CCSP Data': [HEADER_ROW] } },  // empty
      'ALT_SHEET_ID_aaaaaaaaaaaaaaaaa': {
        fileName: 'Q1 CCSP Report',
        tabs: ['CCSP Data'],
        data: { 'CCSP Data': [HEADER_ROW, SAMPLE_ROW] },
      },
    })
    const patchSpy = mock((_n: string, _f: any) => {})
    const ctx: CcspResolverContext = {
      spreadsheetId: 'empty1',
      knownTab: 'CCSP Data',
      aeName: 'Alice',
      sheets,
      lookupAe: () => ({ name: 'Alice', driveFolderId: 'folder_X' }),
      patchAe: patchSpy,
      listSpreadsheetsUnder: async (folder) => {
        expect(folder).toBe('folder_X')
        return ['empty1', 'ALT_SHEET_ID_aaaaaaaaaaaaaaaaa']
      },
    }
    const result = await DriveFolderResolver.resolve(ctx)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(2)
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy.mock.calls[0][0]).toBe('Alice')
    expect(patchSpy.mock.calls[0][1]).toEqual({ ccspSheetId: 'ALT_SHEET_ID_aaaaaaaaaaaaaaaaa' })
  })

  test('returns null when drive folder is empty', async () => {
    const sheets = makeMockSheets({
      empty1: { tabs: ['CCSP Data'], data: { 'CCSP Data': [HEADER_ROW] } },
    })
    const ctx: CcspResolverContext = {
      spreadsheetId: 'empty1',
      knownTab: 'CCSP Data',
      sheets,
      lookupAe: () => ({ name: 'Alice', driveFolderId: 'folder_empty' }),
      patchAe: () => {},
      listSpreadsheetsUnder: async () => [],
    }
    expect(await DriveFolderResolver.resolve(ctx)).toBeNull()
  })

  test('returns null when no AE entry / no driveFolderId', async () => {
    const sheets = makeMockSheets({
      empty1: { tabs: ['CCSP Data'], data: { 'CCSP Data': [HEADER_ROW] } },
    })
    const ctx: CcspResolverContext = {
      spreadsheetId: 'empty1',
      knownTab: 'CCSP Data',
      sheets,
      lookupAe: () => undefined,
      patchAe: () => {},
      listSpreadsheetsUnder: async () => [],
    }
    expect(await DriveFolderResolver.resolve(ctx)).toBeNull()
  })

  test('skips folder candidates whose filename does not contain ccsp', async () => {
    const sheets = makeMockSheets({
      empty1: { tabs: ['CCSP Data'], data: { 'CCSP Data': [HEADER_ROW] } },
      'NON_CCSP_aaaaaaaaaaaaaaaaaaaa': {
        fileName: 'Random Sheet',
        tabs: ['CCSP Data'],
        data: { 'CCSP Data': [HEADER_ROW, SAMPLE_ROW] },
      },
    })
    const ctx: CcspResolverContext = {
      spreadsheetId: 'empty1',
      knownTab: 'CCSP Data',
      sheets,
      lookupAe: () => ({ name: 'Alice', driveFolderId: 'folder_X' }),
      patchAe: () => {},
      listSpreadsheetsUnder: async () => ['NON_CCSP_aaaaaaaaaaaaaaaaaaaa'],
    }
    expect(await DriveFolderResolver.resolve(ctx)).toBeNull()
  })
})

// ── parseCcspRows (pure) ─────────────────────────────────────────────────────

describe('parseCcspRows', () => {
  test('parses a valid Tableau-format row', () => {
    const rows: unknown[][] = [HEADER_ROW, SAMPLE_ROW]
    const recs = parseCcspRows(rows, 'sheet1', 'Alice')
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      accountName: 'ACME',
      quarter: '2025-Q1',
      closeDate: '2025-03-15',
      cloudPartner: 'AWS',
      acvPlus: 12345.67,
      ae: 'Alice',
    })
  })

  test('skips row with non-numeric ACV', () => {
    const rows: unknown[][] = [
      HEADER_ROW,
      ['ACME', '2025-Q1', '2025-03-15', 'AWS', ''],   // empty ACV
      ['BETA', '2025-Q1', '2025-03-15', 'AWS', '99.00'],
    ]
    const recs = parseCcspRows(rows, 'sheet1')
    expect(recs).toHaveLength(1)
    expect(recs[0].accountName).toBe('BETA')
  })

  test('returns [] when account-name column is missing', () => {
    const rows: unknown[][] = [
      ['Other Header', 'ACV Plus'],
      ['x', '100'],
    ]
    expect(parseCcspRows(rows, 'sheet1')).toEqual([])
  })

  test('returns [] when ACV column is missing', () => {
    const rows: unknown[][] = [
      ['Account Name', 'Quarter'],
      ['ACME', '2025-Q1'],
    ]
    expect(parseCcspRows(rows, 'sheet1')).toEqual([])
  })

  test('strips $ and , from ACV values', () => {
    const rows: unknown[][] = [
      HEADER_ROW,
      ['ACME', '2025-Q1', '2025-03-15', 'AWS', '$1,234,567.89'],
    ]
    const recs = parseCcspRows(rows, 'sheet1')
    expect(recs).toHaveLength(1)
    expect(recs[0].acvPlus).toBe(1234567.89)
  })

  test('omits ae field when no aeName given', () => {
    const recs = parseCcspRows([HEADER_ROW, SAMPLE_ROW], 'sheet1')
    expect(recs[0].ae).toBeUndefined()
  })

  test('normalizes cloud partner names', () => {
    const rows: unknown[][] = [
      HEADER_ROW,
      ['A', 'Q', 'D', 'amazon web services', '1'],
      ['B', 'Q', 'D', 'Google Cloud', '1'],
      ['C', 'Q', 'D', 'Microsoft Azure', '1'],
      ['D', 'Q', 'D', 'Other Vendor', '1'],
    ]
    const recs = parseCcspRows(rows, 'sheet1')
    expect(recs.map((r) => r.cloudPartner)).toEqual(['AWS', 'Google', 'Microsoft', 'Other'])
  })
})

// ── Resolver chain ───────────────────────────────────────────────────────────

describe('runResolverChain', () => {
  test('returns first non-null resolver result', async () => {
    const r1: CcspSourceResolver = { name: 'r1', resolve: async () => null }
    const r2: CcspSourceResolver = { name: 'r2', resolve: async () => [['header'], ['data1'], ['data2']] }
    const r3: CcspSourceResolver = {
      name: 'r3',
      resolve: mock(async () => [['header'], ['unused']]),
    }
    const ctx: CcspResolverContext = { spreadsheetId: 's', knownTab: 't', sheets: {} as any }
    const result = await runResolverChain(ctx, [r1, r2, r3])
    expect(result).not.toBeNull()
    expect(result!.length).toBe(3)
    // r3 must NOT be called
    expect((r3.resolve as any).mock.calls.length).toBe(0)
  })

  test('returns null when all resolvers return null', async () => {
    const r1: CcspSourceResolver = { name: 'r1', resolve: async () => null }
    const r2: CcspSourceResolver = { name: 'r2', resolve: async () => null }
    const ctx: CcspResolverContext = { spreadsheetId: 's', knownTab: 't', sheets: {} as any }
    expect(await runResolverChain(ctx, [r1, r2])).toBeNull()
  })

  test('treats <2-row resolver result as no-data and continues', async () => {
    const r1: CcspSourceResolver = { name: 'r1', resolve: async () => [['header']] }  // only 1 row
    const r2: CcspSourceResolver = { name: 'r2', resolve: async () => [['h'], ['x'], ['y']] }
    const ctx: CcspResolverContext = { spreadsheetId: 's', knownTab: 't', sheets: {} as any }
    const result = await runResolverChain(ctx, [r1, r2])
    expect(result!.length).toBe(3)
  })
})
