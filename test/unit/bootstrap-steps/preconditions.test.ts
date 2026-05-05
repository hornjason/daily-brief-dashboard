/**
 * BKL-ARCH-01 (issue #54) — Precondition tests for the 5 auto-bootstrap steps.
 *
 * Each step's `preconditions(ctx)` is a pure function over BootstrapContext.
 * These tests pin the contract: when a required ctx field is missing, the step
 * must report itself non-runnable so the runner skips it. This is the contract
 * the route handler relies on to short-circuit the "no Drive folder → skip
 * downstream" cases that the original IIFE encoded inline.
 */
import { describe, expect, it } from 'bun:test'
import { createDriveFolderStep } from '../../../src/bootstrap/steps/create-drive-folder.ts'
import { createCustomerFoldersStep } from '../../../src/bootstrap/steps/create-customer-folders.ts'
import { readSfBookingsStep } from '../../../src/bootstrap/steps/read-sf-bookings.ts'
import { writeSubscriptionsStep } from '../../../src/bootstrap/steps/write-subscriptions.ts'
import { populateDataSheetsStep } from '../../../src/bootstrap/steps/populate-data-sheets.ts'
import type { BootstrapContext } from '../../../src/bootstrap/steps/types.ts'

function makeMinCtx(overrides: Partial<BootstrapContext> = {}): BootstrapContext {
  return {
    aeName: 'Test AE',
    customerNames: ['Acme'],
    sfReportId: '00O0000000ABCDE',
    tableauTerritories: ['NA_FSI_COMM_TERR1'],
    parentFolderId: undefined,
    podName: undefined,
    aeFolderId: 'folder-id',
    podSheetId: null,
    sfBookingsResults: [{ customerName: 'Acme', rows: [] }] as any,
    setStep: () => {},
    cancelRequested: () => false,
    resources: {},
    ...overrides,
  }
}

describe('Step 1 — Create Drive Folder preconditions', () => {
  it('returns true with a valid aeName', () => {
    expect(createDriveFolderStep.preconditions(makeMinCtx())).toBe(true)
  })

  it('returns false when aeName is empty', () => {
    expect(createDriveFolderStep.preconditions(makeMinCtx({ aeName: '' }))).toBe(false)
  })
})

describe('Step 2 — Create Customer Folders preconditions', () => {
  it('returns true when aeFolderId is set', () => {
    expect(createCustomerFoldersStep.preconditions(makeMinCtx())).toBe(true)
  })

  it('returns false when aeFolderId is empty (drive folder creation failed)', () => {
    expect(createCustomerFoldersStep.preconditions(makeMinCtx({ aeFolderId: '' }))).toBe(false)
  })

  it('reports the drive-failed skip detail', () => {
    const detail = createCustomerFoldersStep.preconditionsSkipDetail?.(makeMinCtx({ aeFolderId: '' }))
    expect(detail).toBe('Skipped: Drive folder creation failed')
  })
})

describe('Step 3 — Read SF Bookings preconditions', () => {
  it('returns true with aeName and tableauTerritories', () => {
    expect(readSfBookingsStep.preconditions(makeMinCtx())).toBe(true)
  })

  it('returns false when tableauTerritories is empty', () => {
    expect(readSfBookingsStep.preconditions(makeMinCtx({ tableauTerritories: [] }))).toBe(false)
  })

  it('returns false when aeName is empty', () => {
    expect(readSfBookingsStep.preconditions(makeMinCtx({ aeName: '' }))).toBe(false)
  })
})

describe('Step 4 — Write Subscriptions preconditions', () => {
  it('returns true with aeFolderId and non-empty sfBookingsResults', () => {
    expect(writeSubscriptionsStep.preconditions(makeMinCtx())).toBe(true)
  })

  it('returns false when aeFolderId is empty', () => {
    expect(writeSubscriptionsStep.preconditions(makeMinCtx({ aeFolderId: '' }))).toBe(false)
  })

  it('returns false when sfBookingsResults is empty', () => {
    expect(writeSubscriptionsStep.preconditions(makeMinCtx({ sfBookingsResults: [] as any }))).toBe(false)
  })

  it('reports drive-failed detail when aeFolderId is empty', () => {
    const detail = writeSubscriptionsStep.preconditionsSkipDetail?.(makeMinCtx({ aeFolderId: '' }))
    expect(detail).toBe('Skipped: Drive folder creation failed')
  })

  it('reports no-results detail when sfBookingsResults is empty', () => {
    const detail = writeSubscriptionsStep.preconditionsSkipDetail?.(makeMinCtx({ sfBookingsResults: [] as any }))
    expect(detail).toBe('Skipped: no SF bookings results')
  })
})

describe('Step 5 — Populate Data Sheets preconditions', () => {
  it('returns true with aeFolderId set', () => {
    expect(populateDataSheetsStep.preconditions(makeMinCtx())).toBe(true)
  })

  it('returns false when aeFolderId is empty', () => {
    expect(populateDataSheetsStep.preconditions(makeMinCtx({ aeFolderId: '' }))).toBe(false)
  })

  it('declares the 60s timeoutMs override', () => {
    expect(populateDataSheetsStep.timeoutMs).toBe(60_000)
  })

  it('reports the drive-failed skip detail', () => {
    const detail = populateDataSheetsStep.preconditionsSkipDetail?.(makeMinCtx({ aeFolderId: '' }))
    expect(detail).toBe('Skipped: Drive folder creation failed')
  })
})

describe('Step registry — names match autoBootstrapState.steps initialization', () => {
  it('exports all 5 step names in canonical order', async () => {
    const { ALL_STEPS } = await import('../../../src/bootstrap/steps/index.ts')
    expect(ALL_STEPS.map(s => s.name)).toEqual([
      'Create Drive Folder',
      'Create Customer Folders',
      'Read SF Bookings Sheet',
      'Write Subscriptions Sheet',
      'Populate Data Sheets',
    ])
  })
})
