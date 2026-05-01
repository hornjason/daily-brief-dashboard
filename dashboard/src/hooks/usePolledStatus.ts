// BKL-ARCH-05: Unified polled-status hook.
// Replaces 6 ad-hoc setInterval+useRef polling contexts with a single primitive.
//
// Semantics (intentional, do NOT conflate):
// - `enabled`: pause/resume gate. Polling stops when false, restarts when true.
// - `until`:   one-way terminal latch. Once predicate returns true, polling
//              stops PERMANENTLY for the lifetime of the component, even if
//              `enabled` flips back to true. Used for "complete"/"error" states.
//
// AbortController contract:
// - One controller per fetch tick; aborted before the next tick fires.
// - Aborted on unmount.
// - AbortError is suppressed (does not set error state).
// - Non-abort errors set error state but keep the interval running.
//
// Activation behavior:
// - Fires one immediate fetch on activation (mount with enabled=true OR
//   enabled false→true transition). Does not wait for the first interval tick.
import { useEffect, useRef, useState } from 'react'

export interface UsePolledStatusOptions<T> {
  intervalMs: number
  enabled?: boolean
  until?: (data: T) => boolean
}

export interface UsePolledStatusResult<T> {
  data: T | null
  error: string | null
  polling: boolean
}

// Exported for unit testing only — verifies the URL/signal contract that the
// hook depends on. The setInterval lifecycle is exercised by Playwright.
export async function executeFetch<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export function usePolledStatus<T>(
  url: string,
  options: UsePolledStatusOptions<T>,
): UsePolledStatusResult<T> {
  const { intervalMs, enabled = true, until } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)

  // One-way latch — once tripped by the `until` predicate, polling never
  // restarts even if `enabled` toggles back to true.
  const latchedRef = useRef(false)
  // Keep a stable reference to the latest predicate so the effect doesn't
  // re-run every render when the caller passes an inline arrow function.
  const untilRef = useRef(until)
  useEffect(() => { untilRef.current = until }, [until])

  useEffect(() => {
    if (!enabled || latchedRef.current) {
      setPolling(false)
      return
    }

    let intervalId: ReturnType<typeof setInterval> | null = null
    let currentController: AbortController | null = null
    let cancelled = false

    const tick = async () => {
      // Abort any in-flight fetch from the previous tick before starting a new one.
      if (currentController) currentController.abort()
      const controller = new AbortController()
      currentController = controller

      try {
        const result = await executeFetch<T>(url, controller.signal)
        if (cancelled) return
        setData(result)
        setError(null)
        if (untilRef.current && untilRef.current(result)) {
          latchedRef.current = true
          if (intervalId) { clearInterval(intervalId); intervalId = null }
          setPolling(false)
        }
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === 'AbortError') return
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        // Keep the interval running on non-abort errors — transient network
        // failures should not stop polling.
      }
    }

    setPolling(true)
    // Immediate fetch on activation — don't wait for the first interval tick.
    void tick()
    intervalId = setInterval(() => { void tick() }, intervalMs)

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
      if (currentController) currentController.abort()
      setPolling(false)
    }
  }, [url, intervalMs, enabled])

  return { data, error, polling }
}
