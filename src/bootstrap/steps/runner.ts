/**
 * BKL-ARCH-01 (issue #54) — Sequential runner for the 5 auto-bootstrap steps.
 *
 * Behavior preserved exactly from the inner IIFE in `createBootstrapRouter()`:
 *
 *   1. Pre-step cancellation check via `ctx.cancelRequested()` — the original
 *      `checkCancelled()` helper short-circuits and returns; runner mirrors by
 *      throwing a sentinel that the route handler catches.
 *   2. Preconditions: if false → mark step 'skipped' and continue. If a step's
 *      execute already pre-marked this step (e.g., upstream error), runner
 *      respects the existing terminal status and does NOT overwrite.
 *   3. Watchdog timer (`makeStepTimeout`) per step — default 90s, override via
 *      `step.timeoutMs`. Fires `setStep(idx, 'error', '…timed out…')` and trips
 *      the cancel flag exactly as the original code did.
 *   4. setStep(idx, 'running') → execute(ctx) → setStep(idx, 'done').
 *      On thrown error: setStep(idx, 'error', e.message); the runner stops
 *      processing further steps and rethrows so the route handler can record
 *      autoBootstrapState.error.
 *   5. Post-step cancellation check.
 */
import { autoBootstrapState, bootstrapFlags } from '../../bootstrap-state.ts'
import type { BootstrapContext, BootstrapStepDef } from './types.ts'

export const STEP_TIMEOUT_MS = 90_000

/** Sentinel thrown when cancellation is requested between steps. */
export class BootstrapCancelledError extends Error {
  constructor() {
    super('Bootstrap cancelled by user')
    this.name = 'BootstrapCancelledError'
  }
}

/**
 * BKL-BOOTSTRAP-CANCEL-01 — per-step watchdog. Fires if a step is still 'running'
 * after `timeoutMs`. Marks the step as errored and trips the cancel flag so the
 * runner halts before the next step.
 */
function makeStepTimeout(
  idx: number,
  label: string,
  timeoutMs: number,
  setStep: BootstrapContext['setStep'],
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (autoBootstrapState.steps[idx]?.status === 'running') {
      console.warn(`[auto-bootstrap] Step ${idx} (${label}) timed out after ${timeoutMs / 1000}s`)
      setStep(idx, 'error', `Step timed out after ${timeoutMs / 1000}s`)
      bootstrapFlags.autoBootstrapCancelRequested = true
    }
  }, timeoutMs)
}

/**
 * Returns true if the step has already been moved to a terminal status by an
 * earlier step (e.g., Step 3 marking Step 4 'error' when SF read fails).
 */
function isAlreadyTerminal(idx: number): boolean {
  const s = autoBootstrapState.steps[idx]?.status
  return s === 'done' || s === 'error' || s === 'skipped' || s === 'cancelled'
}

/**
 * Iterates the step list sequentially, applying the lifecycle described above.
 * Throws `BootstrapCancelledError` when the user-cancel flag is observed —
 * the route handler catches it and marks remaining pending steps 'cancelled'.
 */
export async function runBootstrapSteps(
  steps: BootstrapStepDef[],
  ctx: BootstrapContext,
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    if (ctx.cancelRequested()) throw new BootstrapCancelledError()

    // Skip if an earlier step pre-marked this one (preserves original "Step 3
    // catches SF read failure and pre-errors Step 4" semantics).
    if (isAlreadyTerminal(i)) continue

    // Preconditions — runner-level skip without invoking execute().
    if (!step.preconditions(ctx)) {
      const detail = step.preconditionsSkipDetail?.(ctx) ?? 'precondition not met'
      ctx.setStep(i, 'skipped', detail)
      continue
    }

    const timeoutMs = step.timeoutMs ?? STEP_TIMEOUT_MS
    const tid = makeStepTimeout(i, step.name, timeoutMs, ctx.setStep)

    try {
      ctx.setStep(i, 'running')
      await step.execute(ctx)
      // Steps may have set their own 'done' status with a custom detail message.
      // Only auto-promote to 'done' if the step is still 'running'.
      if (autoBootstrapState.steps[i]?.status === 'running') {
        ctx.setStep(i, 'done')
      }
    } catch (e: any) {
      ctx.setStep(i, 'error', e?.message ?? String(e))
      throw e
    } finally {
      clearTimeout(tid)
    }

    if (ctx.cancelRequested()) throw new BootstrapCancelledError()
  }
}
