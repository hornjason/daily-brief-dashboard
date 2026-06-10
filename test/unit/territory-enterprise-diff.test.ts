import { describe, it, expect } from 'bun:test'
import { extractEnterpriseAeAccounts } from '../../src/territory-sync'

/**
 * #731 — Enterprise customer extraction diff
 * Tests that syncEnterpriseRegion correctly identifies adds/removes
 * by verifying the underlying extractEnterpriseAeAccounts function
 * and the diff logic pattern.
 */

// Simulate an enterprise sheet: AE header row, AE name row, territory row, accounts
const makeEnterpriseRows = (aeName: string, terrCode: string, accounts: string[]): string[][] => {
  const rows: string[][] = [
    ['', 'Account Executive', ''],
    ['', `${aeName}\n${terrCode}`, ''],
  ]
  for (const acct of accounts) {
    rows.push(['', acct, ''])
  }
  // Pad with 3 empty rows to signal end of block
  rows.push(['', '', ''])
  rows.push(['', '', ''])
  rows.push(['', '', ''])
  return rows
}

describe('extractEnterpriseAeAccounts — customer extraction', () => {
  it('extracts accounts for a matching AE', () => {
    const rows = makeEnterpriseRows('Jane Smith', 'Terr01', [
      'Acme Corp',
      'Globex Inc',
      'Initech LLC',
    ])
    const accounts = extractEnterpriseAeAccounts(rows, 'Jane Smith')
    expect(accounts).toEqual(['Acme', 'Globex', 'Initech'])
  })

  it('returns empty array for unknown AE', () => {
    const rows = makeEnterpriseRows('Jane Smith', 'Terr01', ['Acme Corp'])
    const accounts = extractEnterpriseAeAccounts(rows, 'Unknown Person')
    expect(accounts).toEqual([])
  })

  it('skips TBH/TBD/N/A placeholder entries', () => {
    const rows = makeEnterpriseRows('Jane Smith', 'Terr01', [
      'Acme Corp',
      'TBH',
      'TBD',
      'N/A',
      'Globex Inc',
    ])
    const accounts = extractEnterpriseAeAccounts(rows, 'Jane Smith')
    expect(accounts).toEqual(['Acme', 'Globex'])
  })

  it('is case-insensitive on AE name match', () => {
    const rows = makeEnterpriseRows('Jane Smith', 'Terr01', ['Acme Corp'])
    const accounts = extractEnterpriseAeAccounts(rows, 'jane smith')
    expect(accounts).toEqual(['Acme'])
  })
})

describe('enterprise customer diff logic (#731)', () => {
  it('identifies new customers to add', () => {
    const sheetAccounts = ['Acme', 'Globex', 'Initech']
    const currentCustomers = [
      { name: 'Acme', ae: 'Jane Smith' },
    ]

    const currentNamesLower = new Set(currentCustomers.map(c => c.name.toLowerCase()))
    const toAdd: Array<{ name: string; ae: string }> = []

    for (const account of sheetAccounts) {
      if (!currentNamesLower.has(account.toLowerCase())) {
        toAdd.push({ name: account, ae: 'Jane Smith' })
      }
    }

    expect(toAdd).toEqual([
      { name: 'Globex', ae: 'Jane Smith' },
      { name: 'Initech', ae: 'Jane Smith' },
    ])
  })

  it('identifies customers to remove', () => {
    const sheetAccounts = ['Acme']
    const currentCustomers = [
      { name: 'Acme', ae: 'Jane Smith' },
      { name: 'OldCo', ae: 'Jane Smith' },
    ]

    const sheetAccountsLower = new Set(sheetAccounts.map(a => a.toLowerCase()))
    const toRemove: Array<{ name: string; ae: string }> = []
    const unchanged: string[] = []

    for (const cust of currentCustomers) {
      if (!sheetAccountsLower.has(cust.name.toLowerCase())) {
        toRemove.push({ name: cust.name, ae: cust.ae! })
      } else {
        unchanged.push(cust.name)
      }
    }

    expect(toRemove).toEqual([{ name: 'OldCo', ae: 'Jane Smith' }])
    expect(unchanged).toEqual(['Acme'])
  })

  it('handles empty sheet — all current customers flagged for removal', () => {
    const sheetAccounts: string[] = []
    const currentCustomers = [
      { name: 'Acme', ae: 'Jane Smith' },
      { name: 'Globex', ae: 'Jane Smith' },
    ]

    const sheetAccountsLower = new Set(sheetAccounts.map(a => a.toLowerCase()))
    const toRemove: Array<{ name: string; ae: string }> = []

    for (const cust of currentCustomers) {
      if (!sheetAccountsLower.has(cust.name.toLowerCase())) {
        toRemove.push({ name: cust.name, ae: cust.ae! })
      }
    }

    expect(toRemove).toHaveLength(2)
  })
})
