/**
 * BKL-ARCH-08 — Shared bootstrap state containers.
 *
 * Extracted from src/bootstrap-orchestrator.ts. Three concerns live here:
 *
 *   1. `autoBootstrapState` / `podBootstrapState` — the wizard progress
 *      structures the bootstrap state machine mutates and the status route
 *      reads. Held as `const` container objects so callers must use
 *      `Object.assign(state, …)` instead of bare reassignment (TypeScript
 *      forbids reassigning imported bindings).
 *
 *   2. `bootstrapFlags` — module-private guards (`inferenceRunning`,
 *      `autoBootstrapCancelRequested`) that the 409 gate, POD wait loop, and
 *      cancel route check between steps. Wrapped in a flags object so callers
 *      can mutate via `bootstrapFlags.X = …`.
 *
 *   3. `lockState.customerWriteLock` — a promise-chain mutex serializing
 *      writes to customers.json from the post-bootstrap domain inference IIFE.
 *
 * `podBootstrapCancelled` deliberately stays inside bootstrap-orchestrator.ts —
 * it is read/written only inside the orchestrator and never crosses module
 * boundaries.
 */

// ── Shared types ─────────────────────────────────────────────────────────────

export interface AutoBootstrapStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled'
  detail?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface AutoBootstrapResources {
  driveFolder?: { id: string; url: string }
  customerFolders?: Record<string, { id: string; url: string }>
  supportableSheet?: { id: string; url: string }
  ccspSheet?: { id: string; url: string }
  pipelineSheet?: { id: string; url: string }
  unmatchedCustomers?: string[]
  junkFiltered?: string[]
  domainInference?: { customerName: string; domain: string; confidence: 'high' | 'low'; sources: string[] }[]
  /** BKL-DOM-INF-05: human-readable warning listing customers whose domain remained null after all inference tiers (batch + retry + Clearbit + signal fallback). Surfaced in SetupPage so users know to set domains manually. */
  inferenceWarning?: string
}

export interface AutoBootstrapState {
  running: boolean
  aeName: string | null
  steps: AutoBootstrapStep[]
  error: string | null
  completedAt: string | null
  resources: AutoBootstrapResources
}

export interface PodAeResult {
  name: string
  status: 'skipped' | 'ok' | 'error' | 'pending' | 'retrying'
  error?: string
  customerCount?: number
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface PodBootstrapState {
  running: boolean
  total: number
  completed: number
  currentAE: string | null
  results: PodAeResult[]
  startedAt: string | null
  completedAt: string | null
  totalDurationMs?: number
  error: string | null
}

// ── Container objects ────────────────────────────────────────────────────────

export const autoBootstrapState: AutoBootstrapState = {
  running: false,
  aeName: null,
  steps: [],
  error: null,
  completedAt: null,
  resources: {},
}

export const podBootstrapState: PodBootstrapState = {
  running: false,
  total: 0,
  completed: 0,
  currentAE: null,
  results: [],
  startedAt: null,
  completedAt: null,
  error: null,
}

export const bootstrapFlags = {
  /**
   * BKL-DOM-INF-01: lets the 409 gate and POD wait loop see in-progress
   * domain inference even after autoBootstrapState.running has flipped to
   * false.
   */
  inferenceRunning: false,
  /** BKL-WIZ-02: single-AE cancellation flag — checked between bootstrap steps. */
  autoBootstrapCancelRequested: false,
}

export const lockState: { customerWriteLock: Promise<void> } = {
  /**
   * Promise-chain mutex serializing writes to customers.json from the
   * post-bootstrap domain inference auto-save block. Concurrent IIFEs across
   * overlapping AE bootstraps must not interleave read-modify-write.
   */
  customerWriteLock: Promise.resolve(),
}
