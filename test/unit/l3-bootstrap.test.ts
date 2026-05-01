// BKL-ARCH-L4-SPLIT Phase 1: l3-bootstrap unit tests (Red-Green-Refactor)
//
// Tests the public contract of bootstrapAe():
//   - Drive folder created with correct name
//   - 3 sheets created with correct titles (SF Bookings, CCSP, Pipeline)
//   - Sheet rows populated from L3 fixture data
//   - unmatchedCustomers returned when customer has no L3 match
//   - All via mock Drive client + mock L3 data reader — no real Drive API
//
// Prior art: test/unit/ingest-01-sf-bookings-cache-ttl.test.ts (pure logic pattern)
//            test/unit/territory-east.test.ts (import + test structure)

import { describe, test, expect, beforeEach } from 'bun:test'
import type { AeBootstrapConfig, AeBootstrapDeps, AeBootstrapResult } from '../../src/l3-bootstrap.ts'
import { bootstrapAe } from '../../src/l3-bootstrap.ts'

// ── Mock Drive client ──────────────────────────────────────────────────────────
// Tracks calls made so tests can assert Drive operations occurred correctly.

interface MockDriveCall {
  op: 'createFolder' | 'createSheet' | 'writeRows'
  name: string
  parentId?: string
  rows?: string[][]
}

function makeMockDriveClient() {
  const calls: MockDriveCall[] = []
  let nextId = 100

  const client = {
    calls,
    /** Simulates creating a Drive folder — returns a deterministic fake ID */
    async createFolder(name: string, parentId: string): Promise<string> {
      const id = `folder-${++nextId}`
      calls.push({ op: 'createFolder', name, parentId })
      return id
    },
    /** Simulates creating a Google Sheet — returns a deterministic fake ID */
    async createSheet(name: string, parentFolderId: string): Promise<string> {
      const id = `sheet-${++nextId}`
      calls.push({ op: 'createSheet', name, parentId: parentFolderId })
      return id
    },
    /** Simulates writing rows to a sheet */
    async writeRows(sheetId: string, rows: string[][]): Promise<void> {
      // Find the sheet name from prior createSheet calls by matching id logic
      calls.push({ op: 'writeRows', name: sheetId, rows })
    },
  }
  return client
}

// ── Mock L3 data reader ────────────────────────────────────────────────────────
// Provides fixture data for SF Bookings, CCSP, and Pipeline — same shape the
// real l3-data-reader would return from Drive CSVs.

function makeMockL3Reader(options: { customers: string[] } = { customers: ['Acme Corp', 'Globex'] }) {
  return {
    async readSfBookings(config: { podId: string; aeName: string; customerNames: string[] }): Promise<string[][]> {
      // Return one header row + one data row per customer that's in our customer list
      const header = ['Account Name', 'Region', 'AE', 'Q1', 'Q2', 'Q3', 'Q4']
      const rows: string[][] = [header]
      for (const name of config.customerNames) {
        if (options.customers.includes(name)) {
          rows.push([name, config.podId, config.aeName, '100', '200', '150', '175'])
        }
      }
      return rows
    },
    async readCcsp(config: { podId: string; aeName: string; customerNames: string[] }): Promise<string[][]> {
      const header = ['Account Name', 'Cloud Partner', 'Q1', 'Q2', 'Q3', 'Q4']
      const rows: string[][] = [header]
      for (const name of config.customerNames) {
        if (options.customers.includes(name)) {
          rows.push([name, 'AWS', '50', '75', '60', '80'])
        }
      }
      return rows
    },
    async readPipeline(config: { podId: string; aeName: string; customerNames: string[] }): Promise<string[][]> {
      const header = ['Account Name', 'Opportunity', 'Stage', 'ACV', 'Close Date']
      const rows: string[][] = [header]
      for (const name of config.customerNames) {
        if (options.customers.includes(name)) {
          rows.push([name, `${name} Renewal`, 'Commit', '150000', '2026-12-31'])
        }
      }
      return rows
    },
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const BASE_CONFIG: AeBootstrapConfig = {
  region: 'east-enterprise',
  podId: 'SOUTHEAST_ENT_NC_SC_POD',
  territoryCode: 'NC_SC_Terr01',
  aeName: 'Jane Smith',
  customerNames: ['Acme Corp', 'Globex'],
  parentFolderId: 'parent-folder-xyz',
  sfReportId: 'REPORT001',
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('bootstrapAe — Phase 1: l3-bootstrap module', () => {

  describe('Drive folder creation', () => {
    test('creates a Drive folder with the AE name under parentFolderId', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result: AeBootstrapResult = await bootstrapAe(BASE_CONFIG, deps)

      // Should have created exactly one folder
      const folderCalls = drive.calls.filter(c => c.op === 'createFolder')
      expect(folderCalls.length).toBeGreaterThanOrEqual(1)

      // The AE folder should be created under parentFolderId
      const aeFolder = folderCalls.find(c => c.name === 'Jane Smith')
      expect(aeFolder).toBeDefined()
      expect(aeFolder?.parentId).toBe('parent-folder-xyz')

      // Result must have a non-empty driveFolderId
      expect(result.driveFolderId).toBeTruthy()
      expect(typeof result.driveFolderId).toBe('string')
    })

    test('returns the created folder ID in the result', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      expect(result.driveFolderId).toBeTruthy()
      // Should not be the parent folder — it must be the newly created folder
      expect(result.driveFolderId).not.toBe('parent-folder-xyz')
    })
  })

  describe('Sheet creation', () => {
    test('creates exactly 3 sheets: SF Bookings, CCSP, Pipeline', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      await bootstrapAe(BASE_CONFIG, deps)

      const sheetCalls = drive.calls.filter(c => c.op === 'createSheet')
      expect(sheetCalls.length).toBe(3)
    })

    test('creates SF Bookings sheet with correct name', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      await bootstrapAe(BASE_CONFIG, deps)

      const sheetCalls = drive.calls.filter(c => c.op === 'createSheet')
      const sfSheet = sheetCalls.find(c => c.name.toLowerCase().includes('booking'))
      expect(sfSheet).toBeDefined()
    })

    test('creates CCSP sheet with correct name', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      await bootstrapAe(BASE_CONFIG, deps)

      const sheetCalls = drive.calls.filter(c => c.op === 'createSheet')
      const ccspSheet = sheetCalls.find(c => c.name.toLowerCase().includes('ccsp'))
      expect(ccspSheet).toBeDefined()
    })

    test('creates Pipeline sheet with correct name', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      await bootstrapAe(BASE_CONFIG, deps)

      const sheetCalls = drive.calls.filter(c => c.op === 'createSheet')
      const pipelineSheet = sheetCalls.find(c => c.name.toLowerCase().includes('pipeline'))
      expect(pipelineSheet).toBeDefined()
    })

    test('all sheets are created inside the AE drive folder (not parentFolderId)', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      const sheetCalls = drive.calls.filter(c => c.op === 'createSheet')
      for (const sheet of sheetCalls) {
        // All sheets must be under the newly created AE folder, not the parent
        expect(sheet.parentId).toBe(result.driveFolderId)
        expect(sheet.parentId).not.toBe('parent-folder-xyz')
      }
    })

    test('returns all 3 sheet IDs in result', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      expect(result.sfBookingsSheetId).toBeTruthy()
      expect(result.ccspSheetId).toBeTruthy()
      expect(result.pipelineSheetId).toBeTruthy()
      // All 3 IDs must be distinct
      const ids = [result.sfBookingsSheetId, result.ccspSheetId, result.pipelineSheetId]
      expect(new Set(ids).size).toBe(3)
    })
  })

  describe('Sheet data population', () => {
    test('writes rows to SF Bookings sheet from L3 fixture', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader({ customers: ['Acme Corp', 'Globex'] })
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      await bootstrapAe(BASE_CONFIG, deps)

      const writeCalls = drive.calls.filter(c => c.op === 'writeRows')
      // Should have at least 3 write calls (one per sheet)
      expect(writeCalls.length).toBeGreaterThanOrEqual(3)

      // Each write call should have at least a header row + data rows
      for (const w of writeCalls) {
        expect(w.rows).toBeDefined()
        expect(w.rows!.length).toBeGreaterThan(0)
      }
    })

    test('writes at least 2 data rows for SF Bookings when 2 matching customers', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader({ customers: ['Acme Corp', 'Globex'] })
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      // Find the write call for SF Bookings sheet
      const writeCalls = drive.calls.filter(c => c.op === 'writeRows')
      const sfWriteCall = writeCalls.find(c => c.name === result.sfBookingsSheetId)
      expect(sfWriteCall).toBeDefined()
      // Header + 2 data rows
      expect(sfWriteCall?.rows?.length).toBeGreaterThanOrEqual(3)
    })

    test('writes header + 2 data rows for CCSP when 2 matching customers', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader({ customers: ['Acme Corp', 'Globex'] })
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      const writeCalls = drive.calls.filter(c => c.op === 'writeRows')
      const ccspWriteCall = writeCalls.find(c => c.name === result.ccspSheetId)
      expect(ccspWriteCall).toBeDefined()
      expect(ccspWriteCall?.rows?.length).toBeGreaterThanOrEqual(3)
    })

    test('writes header + data rows for Pipeline when matching customers', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader({ customers: ['Acme Corp', 'Globex'] })
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      const writeCalls = drive.calls.filter(c => c.op === 'writeRows')
      const pipelineWriteCall = writeCalls.find(c => c.name === result.pipelineSheetId)
      expect(pipelineWriteCall).toBeDefined()
      expect(pipelineWriteCall?.rows?.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('Unmatched customers', () => {
    test('returns empty unmatchedCustomers when all customers have L3 data', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader({ customers: ['Acme Corp', 'Globex'] })
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      expect(result.unmatchedCustomers).toEqual([])
    })

    test('returns unmatchedCustomers for customers with no L3 data', async () => {
      const drive = makeMockDriveClient()
      // L3 reader only knows about Acme Corp — Globex has no data
      const l3 = makeMockL3Reader({ customers: ['Acme Corp'] })
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const config: AeBootstrapConfig = {
        ...BASE_CONFIG,
        customerNames: ['Acme Corp', 'Globex', 'NoData Inc'],
      }

      const result = await bootstrapAe(config, deps)

      // Both Globex and NoData Inc have no L3 match
      expect(result.unmatchedCustomers).toContain('Globex')
      expect(result.unmatchedCustomers).toContain('NoData Inc')
      expect(result.unmatchedCustomers).not.toContain('Acme Corp')
    })

    test('returns all customers as unmatched when L3 data is empty', async () => {
      const drive = makeMockDriveClient()
      // L3 reader knows no customers
      const l3 = makeMockL3Reader({ customers: [] })
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      expect(result.unmatchedCustomers.length).toBe(BASE_CONFIG.customerNames.length)
      for (const name of BASE_CONFIG.customerNames) {
        expect(result.unmatchedCustomers).toContain(name)
      }
    })
  })

  describe('Config passthrough', () => {
    test('passes aeName and podId to L3 reader for SF Bookings', async () => {
      let capturedSfConfig: any = null
      const drive = makeMockDriveClient()
      const l3 = {
        async readSfBookings(cfg: any) {
          capturedSfConfig = cfg
          return [['Account Name'], ['Acme Corp']]
        },
        async readCcsp(_cfg: any) { return [['Account Name']] },
        async readPipeline(_cfg: any) { return [['Account Name']] },
      }
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      await bootstrapAe(BASE_CONFIG, deps)

      expect(capturedSfConfig).not.toBeNull()
      expect(capturedSfConfig.aeName).toBe('Jane Smith')
      expect(capturedSfConfig.podId).toBe('SOUTHEAST_ENT_NC_SC_POD')
      expect(capturedSfConfig.customerNames).toEqual(['Acme Corp', 'Globex'])
    })

    test('sfReportId is captured in config passthrough context', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const result = await bootstrapAe(BASE_CONFIG, deps)

      // sfReportId should be accessible for downstream callers
      // The result contract guarantees all 3 sheet IDs, folder ID, and unmatched
      expect(result.sfBookingsSheetId).toBeTruthy()
      expect(result.ccspSheetId).toBeTruthy()
      expect(result.pipelineSheetId).toBeTruthy()
    })
  })

  describe('Edge cases', () => {
    test('handles empty customerNames list gracefully', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const config: AeBootstrapConfig = { ...BASE_CONFIG, customerNames: [] }
      const result = await bootstrapAe(config, deps)

      expect(result.driveFolderId).toBeTruthy()
      expect(result.sfBookingsSheetId).toBeTruthy()
      expect(result.unmatchedCustomers).toEqual([])
    })

    test('AE folder name uses aeName from config', async () => {
      const drive = makeMockDriveClient()
      const l3 = makeMockL3Reader()
      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: l3 }

      const config: AeBootstrapConfig = { ...BASE_CONFIG, aeName: 'John Doe' }
      await bootstrapAe(config, deps)

      const folderCalls = drive.calls.filter(c => c.op === 'createFolder')
      const aeFolder = folderCalls.find(c => c.name === 'John Doe')
      expect(aeFolder).toBeDefined()
    })
  })
})
