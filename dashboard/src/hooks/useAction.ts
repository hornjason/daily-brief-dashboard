import { useState, useCallback } from 'react'

export function useAction<T = unknown>() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const execute = useCallback(async (url: string, opts?: RequestInit): Promise<T | null> => {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(url, opts)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        const msg = (body as any).error ?? `${res.status}: ${res.statusText}`
        setError(msg)
        return null
      }
      return await res.json() as T
    } catch (e: any) {
      setError(e.message ?? 'Request failed')
      return null
    } finally {
      setPending(false)
    }
  }, [])

  return { execute, pending, error, clearError: () => setError(null) }
}
