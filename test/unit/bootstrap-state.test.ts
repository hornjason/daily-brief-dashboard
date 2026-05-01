/**
 * BKL-ARCH-08 Slice 1 — bootstrap-state container exports.
 *
 * Verifies that the new src/bootstrap-state.ts module exposes mutable container
 * objects that other modules can mutate via Object.assign / property writes.
 * The orchestrator is being refactored from `export let X = {…}` reassignment
 * to `Object.assign(X, …)` against a shared const container, so the test pins
 * down: (1) the exports exist, (2) they are object references whose property
 * mutations are visible across imports, (3) bootstrapFlags / lockState behave
 * the same way for primitive flags + the customer write lock.
 */
import { describe, it, expect } from 'bun:test'
import {
  autoBootstrapState,
  podBootstrapState,
  bootstrapFlags,
  lockState,
} from '../../src/bootstrap-state.ts'

describe('bootstrap-state', () => {
  it('autoBootstrapState exposes the expected initial shape', () => {
    expect(autoBootstrapState).toBeDefined()
    expect(typeof autoBootstrapState).toBe('object')
    expect(autoBootstrapState.running).toBe(false)
    expect(autoBootstrapState.aeName).toBeNull()
    expect(Array.isArray(autoBootstrapState.steps)).toBe(true)
    expect(autoBootstrapState.error).toBeNull()
    expect(autoBootstrapState.completedAt).toBeNull()
    expect(autoBootstrapState.resources).toBeDefined()
  })

  it('podBootstrapState exposes the expected initial shape', () => {
    expect(podBootstrapState).toBeDefined()
    expect(podBootstrapState.running).toBe(false)
    expect(podBootstrapState.total).toBe(0)
    expect(podBootstrapState.completed).toBe(0)
    expect(podBootstrapState.currentAE).toBeNull()
    expect(Array.isArray(podBootstrapState.results)).toBe(true)
    expect(podBootstrapState.startedAt).toBeNull()
    expect(podBootstrapState.completedAt).toBeNull()
    expect(podBootstrapState.error).toBeNull()
  })

  it('Object.assign on autoBootstrapState mutates the shared reference', () => {
    Object.assign(autoBootstrapState, { running: true, aeName: 'test-ae' })
    expect(autoBootstrapState.running).toBe(true)
    expect(autoBootstrapState.aeName).toBe('test-ae')
    // Reset for other tests
    Object.assign(autoBootstrapState, { running: false, aeName: null })
  })

  it('Object.assign on podBootstrapState mutates the shared reference', () => {
    Object.assign(podBootstrapState, { running: true, total: 5, currentAE: 'pod-ae' })
    expect(podBootstrapState.running).toBe(true)
    expect(podBootstrapState.total).toBe(5)
    expect(podBootstrapState.currentAE).toBe('pod-ae')
    Object.assign(podBootstrapState, { running: false, total: 0, currentAE: null })
  })

  it('bootstrapFlags exposes inferenceRunning and autoBootstrapCancelRequested', () => {
    expect(bootstrapFlags).toBeDefined()
    expect(bootstrapFlags.inferenceRunning).toBe(false)
    expect(bootstrapFlags.autoBootstrapCancelRequested).toBe(false)

    bootstrapFlags.inferenceRunning = true
    bootstrapFlags.autoBootstrapCancelRequested = true
    expect(bootstrapFlags.inferenceRunning).toBe(true)
    expect(bootstrapFlags.autoBootstrapCancelRequested).toBe(true)

    bootstrapFlags.inferenceRunning = false
    bootstrapFlags.autoBootstrapCancelRequested = false
  })

  it('lockState.customerWriteLock starts resolved and supports promise chaining', async () => {
    expect(lockState).toBeDefined()
    expect(lockState.customerWriteLock).toBeInstanceOf(Promise)

    let ran = false
    lockState.customerWriteLock = lockState.customerWriteLock.then(async () => {
      ran = true
    })
    await lockState.customerWriteLock
    expect(ran).toBe(true)
  })
})
