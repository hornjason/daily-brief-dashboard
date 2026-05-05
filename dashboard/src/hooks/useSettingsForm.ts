import { useState, useEffect } from 'react'

interface UseSettingsFormOptions<T> {
  fetchUrl: string
  saveUrl: string
  saveMethod?: 'POST' | 'PUT'
  transform?: (raw: any) => T
}

interface UseSettingsFormReturn<T> {
  config: T | null
  draft: T | null
  setDraft: React.Dispatch<React.SetStateAction<T | null>>
  saving: boolean
  saved: boolean
  error: string | null
  setError: (e: string | null) => void
  dirty: boolean
  handleSave: (override?: T) => Promise<void>
}

/**
 * Encapsulates the standard settings-panel chrome:
 *  - fetch-on-mount (with optional transform of GET response)
 *  - dirty computation via JSON-string compare
 *  - handleSave with res.ok gate, saving/saved/error state, 2s saved-flash
 *
 * The hook intentionally does not handle field-level validation. Panels with
 * extra validation state (e.g. errorField) keep that local and call
 * handleSave only after their own pre-checks pass.
 */
export function useSettingsForm<T>(
  options: UseSettingsFormOptions<T>
): UseSettingsFormReturn<T> {
  const { fetchUrl, saveUrl, saveMethod = 'POST', transform } = options

  const [config, setConfig] = useState<T | null>(null)
  const [draft, setDraft] = useState<T | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(fetchUrl)
      .then(r => r.json())
      .then((raw: any) => {
        const next = transform ? transform(raw) : (raw as T)
        setConfig(next)
        setDraft(next)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchUrl])

  const dirty = JSON.stringify(draft) !== JSON.stringify(config)

  const handleSave = async (override?: T) => {
    const payload = override ?? draft
    if (payload === null || payload === undefined) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(saveUrl, {
        method: saveMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Save failed')
        return
      }
      const next = transform ? transform(data) : (data as T)
      setConfig(next)
      setDraft(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return { config, draft, setDraft, saving, saved, error, setError, dirty, handleSave }
}
