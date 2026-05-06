/**
 * BKL-ARCH-01 (issue #54) — Per-step bootstrap context + step interface.
 *
 * Extracted from the inner IIFE in `createBootstrapRouter()` (src/bootstrap-orchestrator.ts).
 * Each of the 5 auto-bootstrap steps lives in its own module under src/bootstrap/steps/
 * and conforms to `BootstrapStepDef`. The `runBootstrapSteps` runner in `runner.ts`
 * orchestrates pre-step cancel checks, watchdog timers, status transitions, and
 * precondition-driven skips.
 *
 * `BootstrapContext` is the shared scratchpad that flows through the 5 steps. Earlier
 * steps mutate it (driveFolderId, podSheetId, sfBookingsResults) and later steps read
 * those values. Module-level singletons (aes, customers) are NOT carried in context —
 * steps import them directly, identical to the pre-extraction inline code.
 */
import type { AutoBootstrapResources, AutoBootstrapStep } from '../../bootstrap-state.ts'

export interface BootstrapContext {
  // Inputs (set before runner starts)
  aeName: string
  customerNames: string[]
  sfReportId: string
  tableauTerritories: string[]
  parentFolderId?: string
  podName?: string

  // Mutated across steps
  /** Set by Step 1 (Create Drive Folder); pre-populated if AE already has a folder. */
  aeFolderId: string
  /** Set by Step 2 (Read SF Bookings) once a POD bookings sheet is matched. */
  podSheetId: string | null

  // State machine handles (closures over autoBootstrapState)
  setStep(idx: number, status: AutoBootstrapStep['status'], detail?: string): void
  cancelRequested(): boolean
  /** Mutated in-place by steps when they record drive/sheet resources. */
  resources: AutoBootstrapResources
}

export interface BootstrapStepDef {
  /** Display name — must match the name in autoBootstrapState.steps[idx]. */
  name: string
  /** Returns false when the step should be skipped (runner marks it 'skipped'). */
  preconditions(ctx: BootstrapContext): boolean
  /** Detail message attached when preconditions skip (runner uses 'precondition not met' if absent). */
  preconditionsSkipDetail?(ctx: BootstrapContext): string
  /** Override the default per-step watchdog timeout (default = STEP_TIMEOUT_MS = 90_000). */
  timeoutMs?: number
  /** Performs the step. Throws on failure (runner marks 'error' and stops further steps). */
  execute(ctx: BootstrapContext): Promise<void>
}
