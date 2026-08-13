import { useState, useCallback } from 'react'

export interface QueryResult {
  answer: string
  sources: Array<{ title: string; url: string }>
  confidence: string
}

export interface HistoryEntry {
  question: string
  result: QueryResult
}

export function useCustomerQuery(customerName: string) {
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<QueryResult | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [history, setHistory]   = useState<HistoryEntry[]>([])

  const ask = useCallback(async (question: string) => {
    if (!question.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/customer-query', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question: question.trim(), customerName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any
        throw new Error(body?.error ?? `Server error ${res.status}`)
      }
      const data = (await res.json()) as QueryResult
      setResult(data)
      setHistory(prev => [{ question: question.trim(), result: data }, ...prev].slice(0, 10))
    } catch (e: any) {
      setError(e.message ?? 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [customerName])

  const clearHistory = useCallback(() => {
    setHistory([])
    setResult(null)
    setError(null)
  }, [])

  return { ask, loading, result, error, history, clearHistory }
}
