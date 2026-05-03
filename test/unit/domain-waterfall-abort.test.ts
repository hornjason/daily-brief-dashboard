// BKL-DOM-INF-02: AbortController plumbed into domain waterfall fetch calls so
// the bootstrap inference IIFE's 60s race can cancel in-flight network calls
// instead of orphaning them.

import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test'

// Mock gemini-auth before importing domain-waterfall so batchInferDomains
// gets a stub token instead of trying real ADC.
mock.module('../../src/gemini-auth.ts', () => ({
  getGeminiToken: async () => 'fake-token',
}))

import { batchInferDomains, tier1Clearbit } from '../../src/domain-waterfall.ts'

const realFetch = globalThis.fetch
let lastSignal: AbortSignal | undefined

function installHangingFetch() {
  // Mock fetch returns a Promise that never resolves on its own, but rejects
  // with the AbortError once the caller's signal aborts. This is exactly the
  // contract real fetch implements when AbortSignal.any feeds an aborted
  // outer signal.
  globalThis.fetch = ((_url: any, init?: any) => {
    const sig: AbortSignal | undefined = init?.signal
    lastSignal = sig
    return new Promise((_, reject) => {
      if (!sig) return  // never resolves
      if (sig.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      sig.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  }) as any
}

describe('BKL-DOM-INF-02: AbortController propagation', () => {
  beforeEach(() => {
    lastSignal = undefined
    installHangingFetch()
    // Set GOOGLE_CLOUD_PROJECT so batchInferDomains doesn't short-circuit.
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project'
    // Stub gemini-auth so getGeminiToken resolves cheaply.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/nope.json'
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('tier1Clearbit cancels when external signal aborts', async () => {
    const ctrl = new AbortController()
    const promise = tier1Clearbit('Acme Corp', ctrl.signal)
    // Abort after a tick — promise must resolve to null (caught internally).
    setTimeout(() => ctrl.abort(), 10)
    const result = await promise
    expect(result).toBeNull()
    // The fetch's effective signal should be a chained AbortSignal that
    // observes the aborted state.
    expect(lastSignal?.aborted).toBe(true)
  })

  test('tier1Clearbit without signal still works (timeout-only path)', async () => {
    // Restore fetch to a fast-resolver for this case so we don't sit on the
    // 5s internal timeout.
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [],
    })) as any
    const result = await tier1Clearbit('Nonexistent Co')
    expect(result).toBeNull()
  })

  test('batchInferDomains returns null map when caller aborts mid-flight', async () => {
    const ctrl = new AbortController()
    const promise = batchInferDomains(['Acme Corp', 'Beta Inc'], ctrl.signal)
    setTimeout(() => ctrl.abort(), 10)
    const result = await promise
    // Every name must appear in the returned map (default-null contract).
    expect(result.size).toBe(2)
    expect(result.get('Acme Corp')).toBeNull()
    expect(result.get('Beta Inc')).toBeNull()
    expect(lastSignal?.aborted).toBe(true)
  })

  test('batchInferDomains with empty input returns empty map without fetching', async () => {
    const result = await batchInferDomains([])
    expect(result.size).toBe(0)
    expect(lastSignal).toBeUndefined()
  })
})
