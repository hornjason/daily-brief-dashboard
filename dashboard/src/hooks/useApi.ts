import { useState, useEffect, useCallback } from 'react'

export function useApi<T>(url: string, options?: { enabled?: boolean }) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`)
      const json = await res.json()
      setData(json)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    if (options?.enabled === false) return
    refetch()
  }, [refetch, options?.enabled])

  return { data, loading, error, refetch }
}
