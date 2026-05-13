/**
 * GitHub Issue #165: Campaign configurator component
 * Feature: Editable personas, style, value props preview
 *
 * Shared component for campaign configuration flow:
 * - Material URL input
 * - Extract material via POST /api/campaigns/extract-material
 * - Preview/edit personas, style, value props
 * - Confirm to generate campaign
 */

import { useState } from 'react'
import { RefreshCw, AlertCircle, Plus, Trash2 } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CampaignConfig {
  materialUrl: string
  materialTitle: string
  personas: Array<{ role: string; relevantVPs: string[]; enabled: boolean }>
  valueProps: Array<{ id: string; claim: string; detail: string }>
  style: string
}

export interface CampaignConfiguratorProps {
  customerName?: string  // optional — provided on Campaigns tab, not on batch page
  onConfirm: (config: CampaignConfig) => void
  onCancel?: () => void
}

interface MaterialExtractionResponse {
  materialTitle: string
  personas: Array<{ role: string; relevantVPs: string[] }>
  valueProps: Array<{ id: string; claim: string; detail: string }>
  style: string
}

type FlowState = 'input' | 'loading' | 'preview' | 'error'

// ── Component ─────────────────────────────────────────────────────────────────

export function CampaignConfigurator({ customerName, onConfirm, onCancel }: CampaignConfiguratorProps) {
  const [state, setState] = useState<FlowState>('input')
  const [materialUrl, setMaterialUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Preview state — editable config
  const [materialTitle, setMaterialTitle] = useState('')
  const [personas, setPersonas] = useState<Array<{ role: string; relevantVPs: string[]; enabled: boolean }>>([])
  const [valueProps, setValueProps] = useState<Array<{ id: string; claim: string; detail: string }>>([])
  const [style, setStyle] = useState('')

  // ── Material extraction ────────────────────────────────────────────────────

  async function handleAnalyze() {
    // Validate URL format
    if (!materialUrl.match(/docs\.google\.com\/(document|presentation)\/d\//)) {
      setError('Please enter a valid Google Doc or Slides URL')
      return
    }

    setState('loading')
    setError(null)

    try {
      const res = await fetch('/api/campaigns/extract-material', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materialUrl }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Material extraction failed' }))
        setError(err.error || 'Material extraction failed')
        setState('error')
        return
      }

      const data: MaterialExtractionResponse = await res.json()

      // Load into editable state, adding enabled:true to personas
      setMaterialTitle(data.materialTitle)
      setPersonas(data.personas.map(p => ({ ...p, enabled: true })))
      setValueProps(data.valueProps)
      setStyle(data.style)
      setState('preview')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Material extraction failed')
      setState('error')
    }
  }

  async function handleReanalyze() {
    setState('loading')
    setError(null)

    try {
      // DELETE to clear cache
      await fetch('/api/campaigns/extract-material', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materialUrl }),
      })

      // Re-extract
      await handleAnalyze()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Re-analysis failed')
      setState('error')
    }
  }

  function handleGenerate() {
    const config: CampaignConfig = {
      materialUrl,
      materialTitle,
      personas,
      valueProps,
      style,
    }
    onConfirm(config)
  }

  // ── Persona editing ────────────────────────────────────────────────────────

  function togglePersona(index: number) {
    setPersonas(prev => prev.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)))
  }

  function updatePersonaRole(index: number, newRole: string) {
    setPersonas(prev => prev.map((p, i) => (i === index ? { ...p, role: newRole } : p)))
  }

  function addPersona() {
    setPersonas(prev => [...prev, { role: 'New Persona', relevantVPs: [], enabled: true }])
  }

  function removePersona(index: number) {
    setPersonas(prev => prev.filter((_, i) => i !== index))
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  const hasEnabledPersona = personas.some(p => p.enabled)

  // ── Render ─────────────────────────────────────────────────────────────────

  // Input state
  if (state === 'input') {
    return (
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-text-primary">Material URL</h2>
        <div className="space-y-2">
          <input
            type="text"
            value={materialUrl}
            onChange={e => setMaterialUrl(e.target.value)}
            placeholder="https://docs.google.com/document/d/..."
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-text-primary placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
          <p className="text-xs text-zinc-500">Google Doc or Slides link</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs text-warning">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleAnalyze}
            disabled={!materialUrl.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Analyze Material
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-400 text-sm font-medium hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    )
  }

  // Loading state
  if (state === 'loading') {
    return (
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center space-y-3">
        <RefreshCw className="w-8 h-8 text-accent mx-auto animate-spin" />
        <p className="text-sm text-text-secondary">Extracting material...</p>
      </div>
    )
  }

  // Error state
  if (state === 'error') {
    return (
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-warning">
          <AlertCircle className="w-5 h-5" />
          <h2 className="text-base font-semibold">Extraction Failed</h2>
        </div>
        {error && <p className="text-sm text-text-secondary">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={() => setState('input')}
            className="flex-1 px-4 py-2.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Try Again
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-400 text-sm font-medium hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    )
  }

  // Preview state
  return (
    <div className="space-y-6">
      {/* Material title header */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
        <h2 className="text-base font-semibold text-text-primary">{materialTitle}</h2>
        <p className="text-xs text-zinc-500 mt-1">{materialUrl}</p>
      </div>

      {/* Personas */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Personas</h3>
        <div className="space-y-2">
          {personas.map((persona, idx) => (
            <div key={idx} className="flex items-center gap-3 p-3 bg-zinc-900 border border-zinc-700 rounded-lg">
              <input
                type="checkbox"
                checked={persona.enabled}
                onChange={() => togglePersona(idx)}
                className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-accent focus:ring-2 focus:ring-accent/50"
              />
              <input
                type="text"
                value={persona.role}
                onChange={e => updatePersonaRole(idx, e.target.value)}
                className="flex-1 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
              <button
                onClick={() => removePersona(idx)}
                className="p-1 text-zinc-500 hover:text-warning transition-colors"
                aria-label="Remove persona"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addPersona}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-400 text-sm font-medium hover:bg-zinc-800 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Persona
        </button>
      </div>

      {/* Style */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Style Guide</h3>
        <textarea
          value={style}
          onChange={e => setStyle(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-text-primary placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
        />
      </div>

      {/* Value props (read-only) */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Value Propositions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {valueProps.map(vp => (
            <div key={vp.id} className="p-3 bg-zinc-900 border border-zinc-700 rounded-lg space-y-1">
              <p className="text-xs font-medium text-accent">{vp.claim}</p>
              <p className="text-xs text-zinc-400">{vp.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleReanalyze}
          className="px-4 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-400 text-sm font-medium hover:bg-zinc-800 transition-colors"
        >
          Re-analyze
        </button>
        <button
          onClick={handleGenerate}
          disabled={!hasEnabledPersona}
          className="flex-1 px-4 py-2.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Generate Campaign
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-4 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-400 text-sm font-medium hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
