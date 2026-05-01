import { useState, useEffect } from 'react'

// Module-level cache so multiple components on the same page share one fetch.
let _cached: boolean | null = null
let _promise: Promise<boolean> | null = null

function fetchNodeRole(): Promise<boolean> {
  if (_promise) return _promise
  _promise = fetch('/api/node-role')
    .then(r => r.json())
    .then((d: { isL3Only?: boolean }) => {
      const val = typeof d.isL3Only === 'boolean' ? d.isL3Only : false
      _cached = val
      return val
    })
    .catch(() => {
      _promise = null
      return false
    })
  return _promise
}

export function useNodeRole(): { isL3Only: boolean; loading: boolean } {
  const [isL3Only, setIsL3Only] = useState<boolean>(_cached ?? false)
  const [loading, setLoading] = useState(_cached === null)

  useEffect(() => {
    if (_cached !== null) {
      setIsL3Only(_cached)
      setLoading(false)
      return
    }
    let cancelled = false
    fetchNodeRole().then(val => {
      if (!cancelled) {
        setIsL3Only(val)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  return { isL3Only, loading }
}
