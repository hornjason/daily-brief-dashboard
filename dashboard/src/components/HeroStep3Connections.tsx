/**
 * BKL-HERO-01 Phase 3 — Step 3 Red Hat Connection component.
 *
 * Renders when isL3Only === true on SetupPage. Allows hero installs to paste
 * and validate their Red Hat offline token. POSTs to the existing
 * POST /api/settings/offline-token route (which now validates via SSO before saving).
 *
 * Visual pattern mirrors Step0RegionAccess.tsx exactly:
 *   section card · CheckCircle summary · [Edit] link · Loader2 spinner · XCircle error
 */
import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'

interface HeroStep3Props {
  onSave?: () => void
}

export function HeroStep3Connections({ onSave }: HeroStep3Props) {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [summaryMode, setSummaryMode] = useState(false)
  const [loading, setLoading] = useState(true)

  // Check on mount whether a token is already configured
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/settings/offline-token', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { configured: boolean }) => {
        if (d.configured === true) setSummaryMode(true)
      })
      .catch(e => {
        if (e.name !== 'AbortError') console.warn('[HeroStep3] failed to check token status:', e.message)
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  const handleSave = async () => {
    setSaveError(null)
    setSaving(true)
    try {
      const res = await fetch('/api/settings/offline-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error ?? `Save failed (${res.status})`)
      }
      setToken('')
      setSummaryMode(true)
      onSave?.()
    } catch (e: any) {
      setSaveError(e.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Loading state — checking whether token is already configured
  if (loading) {
    return (
      <section className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4">
          <h2 className="text-base font-semibold text-white mb-1">Red Hat Connection</h2>
        </div>
        <div className="px-6 pb-6 pt-4 flex items-center gap-2 text-text-secondary text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Checking token status...
        </div>
      </section>
    )
  }

  // Summary mode — token is already configured
  if (summaryMode) {
    return (
      <section
        data-testid="hero-step3-summary"
        className="bg-surface rounded-xl border border-border overflow-hidden"
      >
        <div className="px-6 py-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-success shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-white">Red Hat Token Configured</p>
              <p className="text-xs text-text-secondary mt-0.5">Token is saved and active</p>
            </div>
          </div>
          <button
            data-testid="rh-token-edit"
            onClick={() => setSummaryMode(false)}
            className="text-xs text-accent hover:text-accent/80 underline shrink-0"
          >
            [Edit]
          </button>
        </div>
      </section>
    )
  }

  // Form mode — paste and validate token
  return (
    <section
      data-testid="hero-step3-connections"
      className="bg-surface rounded-xl border border-border overflow-hidden"
    >
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-white mb-1">Red Hat Connection</h2>
        <p className="text-sm text-text-secondary">
          Enter your Red Hat offline token to enable RH Cases.
        </p>
      </div>
      <div className="px-6 py-5 space-y-4">
        <div>
          <a
            data-testid="rh-token-help"
            href="https://access.redhat.com/management/api"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent underline"
          >
            Get your offline token →
          </a>
        </div>
        <textarea
          data-testid="rh-token-input"
          value={token}
          onChange={e => setToken(e.target.value)}
          rows={4}
          placeholder="Paste offline token here..."
          className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono text-white resize-none focus:outline-none focus:border-accent"
        />
        {saveError && (
          <div className="flex items-start gap-2 text-error text-sm">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p data-testid="rh-token-error">{saveError}</p>
          </div>
        )}
        <button
          data-testid="rh-token-save"
          onClick={handleSave}
          disabled={token.trim() === '' || saving}
          className="flex items-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? 'Validating...' : 'Validate & Save'}
        </button>
      </div>
    </section>
  )
}
