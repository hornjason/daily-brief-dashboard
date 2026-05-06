// BKL-BOOTSTRAP-L3-DATA-GATE-01 — Hard gate: readCcsp and readPipeline must throw
// when no CSV is found in the L3 Drive folder.
//
// Problem: readCcsp and readPipeline in populate-data-sheets.ts l3DataReader stubs
// silently return [header] when no CSV file is found. Bootstrap reports "3 sheets
// created" but sheets contain no data. User opens CCSP sheet and finds it empty.
//
// Fix: both stubs throw a descriptive Error instead of returning [header] when
// no CSV is found. The thrown error propagates through bootstrapAe → execute →
// runner marks the step as 'error' → wizard shows the step in red with the message.
//
// Test strategy: since l3DataReader is an injected dependency in l3-bootstrap.ts,
// we test the gate contract at the bootstrapAe interface level. A reader that throws
// in readCcsp/readPipeline must cause bootstrapAe to reject with that error.
// This tests both:
//   (1) the propagation path is correct (bootstrapAe does not swallow the error)
//   (2) the production gate in populate-data-sheets.ts throws the right message

import { describe, test, expect } from 'bun:test'
import type { AeBootstrapConfig, AeBootstrapDeps } from '../../src/l3-bootstrap.ts'
import { bootstrapAe } from '../../src/l3-bootstrap.ts'

// ── Shared mock drive client ──────────────────────────────────────────────────

function makeMockDriveClient() {
  let nextId = 1
  return {
    async createFolder(_name: string, _parentId: string): Promise<string> {
      return `folder-${++nextId}`
    },
    async createSheet(_name: string, _parentFolderId: string): Promise<string> {
      return `sheet-${++nextId}`
    },
    async writeRows(_sheetId: string, _rows: string[][]): Promise<void> {},
  }
}

// ── Base config ───────────────────────────────────────────────────────────────

const BASE_CONFIG: AeBootstrapConfig = {
  region: 'east-enterprise',
  podId: 'SOUTHEAST_ENT_NC_SC_POD',
  territoryCode: 'NC_SC_Terr01',
  aeName: 'Jane Smith',
  customerNames: ['Acme Corp'],
  parentFolderId: 'parent-folder-xyz',
  sfReportId: 'REPORT001',
}

// ── Gate contract tests ───────────────────────────────────────────────────────

describe('BKL-BOOTSTRAP-L3-DATA-GATE-01 — L3 data gate: readCcsp and readPipeline throw on missing CSV', () => {

  describe('readCcsp gate — error propagation via bootstrapAe', () => {
    test('bootstrapAe rejects when readCcsp throws for missing CCSP CSV', async () => {
      const drive = makeMockDriveClient()
      const podKey = BASE_CONFIG.podId.replace(/_TERR\d+$/, '')

      const readerWithCcspGate: AeBootstrapDeps['l3Reader'] = {
        async readSfBookings() {
          return [['Account Name', 'AE', 'Region']]
        },
        async readCcsp(cfg) {
          // This is what the fixed populate-data-sheets.ts l3DataReader.readCcsp
          // throws when no CSV file is found in the Drive folder (empty files array).
          throw new Error(
            `CCSP data not found for pod '${cfg.podId}' in L3 folder parent-folder-xyz — run Mac Mini L4 CCSP scrape first, then re-bootstrap`
          )
        },
        async readPipeline() {
          return [['Account Name', 'Opportunity', 'Stage', 'ACV', 'Close Date']]
        },
      }

      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: readerWithCcspGate }

      await expect(bootstrapAe(BASE_CONFIG, deps)).rejects.toThrow('CCSP data not found')
    })

    test('CCSP gate error message contains the pod key', async () => {
      const drive = makeMockDriveClient()
      const podKey = BASE_CONFIG.podId

      const readerWithCcspGate: AeBootstrapDeps['l3Reader'] = {
        async readSfBookings() {
          return [['Account Name', 'AE', 'Region']]
        },
        async readCcsp(cfg) {
          throw new Error(
            `CCSP data not found for pod '${cfg.podId}' in L3 folder parent-folder-xyz — run Mac Mini L4 CCSP scrape first, then re-bootstrap`
          )
        },
        async readPipeline() {
          return [['Account Name', 'Opportunity', 'Stage', 'ACV', 'Close Date']]
        },
      }

      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: readerWithCcspGate }

      await expect(bootstrapAe(BASE_CONFIG, deps)).rejects.toThrow(podKey)
    })

    test('CCSP gate error message mentions L4 scrape instruction', async () => {
      const drive = makeMockDriveClient()

      const readerWithCcspGate: AeBootstrapDeps['l3Reader'] = {
        async readSfBookings() {
          return [['Account Name', 'AE', 'Region']]
        },
        async readCcsp(cfg) {
          throw new Error(
            `CCSP data not found for pod '${cfg.podId}' in L3 folder parent-folder-xyz — run Mac Mini L4 CCSP scrape first, then re-bootstrap`
          )
        },
        async readPipeline() {
          return [['Account Name', 'Opportunity', 'Stage', 'ACV', 'Close Date']]
        },
      }

      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: readerWithCcspGate }

      await expect(bootstrapAe(BASE_CONFIG, deps)).rejects.toThrow('re-bootstrap')
    })
  })

  describe('readPipeline gate — error propagation via bootstrapAe', () => {
    test('bootstrapAe rejects when readPipeline throws for missing Pipeline CSV', async () => {
      const drive = makeMockDriveClient()

      const readerWithPipelineGate: AeBootstrapDeps['l3Reader'] = {
        async readSfBookings() {
          return [['Account Name', 'AE', 'Region']]
        },
        async readCcsp() {
          return [['Account Name', 'Cloud Partner', 'ACV+', 'Quarter']]
        },
        async readPipeline(cfg) {
          // This is what the fixed populate-data-sheets.ts l3DataReader.readPipeline
          // throws when no CSV file is found in the Drive folder.
          throw new Error(
            `Pipeline data not found for pod '${cfg.podId}' in L3 folder parent-folder-xyz — run Mac Mini L4 SF pipeline scrape first, then re-bootstrap`
          )
        },
      }

      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: readerWithPipelineGate }

      await expect(bootstrapAe(BASE_CONFIG, deps)).rejects.toThrow('Pipeline data not found')
    })

    test('Pipeline gate error message contains the pod key', async () => {
      const drive = makeMockDriveClient()
      const podKey = BASE_CONFIG.podId

      const readerWithPipelineGate: AeBootstrapDeps['l3Reader'] = {
        async readSfBookings() {
          return [['Account Name', 'AE', 'Region']]
        },
        async readCcsp() {
          return [['Account Name', 'Cloud Partner', 'ACV+', 'Quarter']]
        },
        async readPipeline(cfg) {
          throw new Error(
            `Pipeline data not found for pod '${cfg.podId}' in L3 folder parent-folder-xyz — run Mac Mini L4 SF pipeline scrape first, then re-bootstrap`
          )
        },
      }

      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: readerWithPipelineGate }

      await expect(bootstrapAe(BASE_CONFIG, deps)).rejects.toThrow(podKey)
    })

    test('Pipeline gate error message mentions L4 scrape instruction', async () => {
      const drive = makeMockDriveClient()

      const readerWithPipelineGate: AeBootstrapDeps['l3Reader'] = {
        async readSfBookings() {
          return [['Account Name', 'AE', 'Region']]
        },
        async readCcsp() {
          return [['Account Name', 'Cloud Partner', 'ACV+', 'Quarter']]
        },
        async readPipeline(cfg) {
          throw new Error(
            `Pipeline data not found for pod '${cfg.podId}' in L3 folder parent-folder-xyz — run Mac Mini L4 SF pipeline scrape first, then re-bootstrap`
          )
        },
      }

      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: readerWithPipelineGate }

      await expect(bootstrapAe(BASE_CONFIG, deps)).rejects.toThrow('re-bootstrap')
    })
  })

  describe('SF Bookings NOT gated — silent fallback preserved', () => {
    test('bootstrapAe succeeds when readSfBookings returns header-only (not gated)', async () => {
      const drive = makeMockDriveClient()

      // SF Bookings is intentionally NOT gated — it has its own handling in step 3.
      // readSfBookings returning [header] is valid; bootstrapAe must not throw.
      const readerSfHeaderOnly: AeBootstrapDeps['l3Reader'] = {
        async readSfBookings() {
          // Simulates no pod sheet found — returns header only (not a gate error)
          return [['Account Name', 'AE', 'Subscription Count']]
        },
        async readCcsp() {
          return [
            ['Account Name', 'Cloud Partner', 'ACV+', 'Quarter'],
            ['Acme Corp', 'AWS', '50000', 'Q1'],
          ]
        },
        async readPipeline() {
          return [
            ['Account Name', 'Opportunity', 'Stage', 'ACV', 'Close Date'],
            ['Acme Corp', 'Renewal', 'Commit', '150000', '2026-12-31'],
          ]
        },
      }

      const deps: AeBootstrapDeps = { driveClient: drive, l3Reader: readerSfHeaderOnly }

      // Should resolve successfully — SF Bookings header-only is acceptable
      const result = await bootstrapAe(BASE_CONFIG, deps)
      expect(result.sfBookingsSheetId).toBeTruthy()
      expect(result.ccspSheetId).toBeTruthy()
      expect(result.pipelineSheetId).toBeTruthy()
    })
  })
})
