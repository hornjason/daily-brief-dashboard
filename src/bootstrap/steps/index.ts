/**
 * BKL-ARCH-01 (issue #54) — Auto-bootstrap step registry.
 *
 * The exported ALL_STEPS array IS the canonical step order. The corresponding
 * autoBootstrapState.steps[] entries are initialized in the route handler with
 * the same `name` strings.
 */
import { createDriveFolderStep } from './create-drive-folder.ts'
import { createCustomerFoldersStep } from './create-customer-folders.ts'
import { readSfBookingsStep } from './read-sf-bookings.ts'
import { populateDataSheetsStep } from './populate-data-sheets.ts'
import type { BootstrapStepDef } from './types.ts'

export const ALL_STEPS: readonly BootstrapStepDef[] = [
  createDriveFolderStep,
  createCustomerFoldersStep,
  readSfBookingsStep,
  populateDataSheetsStep,
] as const

export {
  createDriveFolderStep,
  createCustomerFoldersStep,
  readSfBookingsStep,
  populateDataSheetsStep,
}
export type { BootstrapStepDef, BootstrapContext } from './types.ts'
export { runBootstrapSteps, BootstrapCancelledError, STEP_TIMEOUT_MS } from './runner.ts'
