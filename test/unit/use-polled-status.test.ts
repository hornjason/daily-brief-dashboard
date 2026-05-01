// BKL-ARCH-05: Unit tests for usePolledStatus's testable fetch primitive.
//
// We test executeFetch directly rather than the React hook itself.
// bun:test does NOT support advancing fake timers for setInterval —
// setSystemTime only affects Date.now/new Date(). The setInterval lifecycle
// (immediate fetch, retries on error, until latch, unmount abort) is
// exercised by the Playwright suite, which renders the components that
// consume the hook.
import { test, expect, describe, mock, afterEach } from 'bun:test'
import { executeFetch } from '../../dashboard/src/hooks/usePolledStatus'

const origFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = origFetch })

describe('executeFetch', () => {
  test('calls fetch with the provided URL', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch

    const controller = new AbortController()
    await executeFetch('/api/test', controller.signal)

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/api/test')
  })

  test('passes the AbortSignal to fetch', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    const controller = new AbortController()
    await executeFetch('/api/x', controller.signal)
    expect(calls[0][1]?.signal).toBe(controller.signal)
  })

  test('returns parsed JSON on success', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ status: 'complete', count: 7 }), { status: 200 })
    ) as unknown as typeof fetch

    const controller = new AbortController()
    const result = await executeFetch<{ status: string; count: number }>('/api/y', controller.signal)
    expect(result).toEqual({ status: 'complete', count: 7 })
  })

  test('throws on non-ok HTTP status', async () => {
    globalThis.fetch = mock(async () =>
      new Response('boom', { status: 500 })
    ) as unknown as typeof fetch

    const controller = new AbortController()
    await expect(executeFetch('/api/z', controller.signal)).rejects.toThrow(/HTTP 500/)
  })

  test('propagates AbortError when controller aborts', async () => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      // Real fetch rejects with an AbortError when its signal is aborted.
      // Simulate that contract here so executeFetch sees the same shape.
      return await new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal
        if (sig?.aborted) {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          reject(err)
          return
        }
        sig?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as unknown as typeof fetch

    const controller = new AbortController()
    const promise = executeFetch('/api/abort', controller.signal)
    controller.abort()
    let caught: unknown
    try { await promise } catch (e) { caught = e }
    expect((caught as { name?: string })?.name).toBe('AbortError')
  })

  test('propagates non-abort network errors', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const controller = new AbortController()
    await expect(executeFetch('/api/err', controller.signal)).rejects.toThrow(/network down/)
  })
})
