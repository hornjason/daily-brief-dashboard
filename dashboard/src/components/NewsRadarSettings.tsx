/**
 * GitHub Issue #179 — News Radar Settings UI
 *
 * Settings panel for managing news radar configuration:
 * - Signal types (event categories to search)
 * - Custom keywords
 * - Critical keywords (red badges)
 * - Exclude keywords (noise filter)
 * - Default significance threshold
 * - Search depth in days
 */

import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { SettingsCard } from './SettingsCard'

interface NewsConfig {
  signalTypes: string[]
  criticalKeywords: string[]
  excludeKeywords: string[]
  defaultThreshold: number
  searchDepthDays: number
}

function TagList({
  label,
  items,
  onAdd,
  onRemove,
  variant = 'default',
}: {
  label: string
  items: string[]
  onAdd: (value: string) => void
  onRemove: (index: number) => void
  variant?: 'default' | 'critical' | 'exclude'
}) {
  const [input, setInput] = useState('')

  const handleAdd = () => {
    const trimmed = input.trim()
    if (!trimmed || items.includes(trimmed)) return
    onAdd(trimmed)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAdd()
    }
  }

  const tagColor =
    variant === 'critical'
      ? 'bg-red-500/20 text-red-400 border-red-500/30'
      : variant === 'exclude'
        ? 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'
        : 'bg-accent/10 text-accent border-accent/20'

  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary mb-2">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {items.map((item, i) => (
          <span key={i} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${tagColor}`}>
            {item}
            <button onClick={() => onRemove(i)} className="hover:opacity-70 transition-opacity">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {items.length === 0 && (
          <span className="text-xs text-text-secondary italic">None configured</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type and press Enter..."
          className="flex-1 px-3 py-1.5 bg-bg border border-border rounded-lg text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <button
          onClick={handleAdd}
          disabled={!input.trim()}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-xs text-text-secondary hover:text-accent hover:border-accent/50 transition-colors disabled:opacity-40"
        >
          <Plus className="w-3 h-3" />
          Add
        </button>
      </div>
    </div>
  )
}

export function NewsRadarSettings() {
  const { draft, setDraft, saving, saved, error, dirty, handleSave } =
    useSettingsForm<NewsConfig>({
      fetchUrl: '/api/admin/news-config',
      saveUrl: '/api/admin/news-config',
    })

  if (!draft) return null

  const updateField = <K extends keyof NewsConfig>(field: K, value: NewsConfig[K]) => {
    setDraft(prev => prev ? { ...prev, [field]: value } : prev)
  }

  const addToList = (field: 'signalTypes' | 'criticalKeywords' | 'excludeKeywords', value: string) => {
    updateField(field, [...draft[field], value])
  }

  const removeFromList = (field: 'signalTypes' | 'criticalKeywords' | 'excludeKeywords', index: number) => {
    updateField(field, draft[field].filter((_, i) => i !== index))
  }

  return (
    <SettingsCard
      title="News Radar Configuration"
      error={error}
      dirty={dirty}
      saving={saving}
      saved={saved}
      onSave={handleSave}
    >
      <p className="text-xs text-text-secondary -mt-2">
        Configure what the news radar searches for and how it scores articles.
      </p>

      {/* Signal Types */}
      <TagList
        label="Signal Types"
        items={draft.signalTypes}
        onAdd={(v) => addToList('signalTypes', v)}
        onRemove={(i) => removeFromList('signalTypes', i)}
      />

      {/* Critical Keywords */}
      <TagList
        label="Critical Keywords (score 9-10)"
        items={draft.criticalKeywords}
        onAdd={(v) => addToList('criticalKeywords', v)}
        onRemove={(i) => removeFromList('criticalKeywords', i)}
        variant="critical"
      />

      {/* Exclude Keywords */}
      <TagList
        label="Exclude Keywords (noise filter)"
        items={draft.excludeKeywords}
        onAdd={(v) => addToList('excludeKeywords', v)}
        onRemove={(i) => removeFromList('excludeKeywords', i)}
        variant="exclude"
      />

      {/* Threshold */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          Default Significance Threshold (1-10)
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={10}
            value={draft.defaultThreshold}
            onChange={(e) => updateField('defaultThreshold', parseInt(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="text-sm font-mono text-text-primary w-6 text-center">
            {draft.defaultThreshold}
          </span>
        </div>
        <p className="text-xs text-text-secondary/60 mt-1">
          Articles below this score are hidden from the dashboard
        </p>
      </div>

      {/* Search Depth */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          Search Depth (days)
        </label>
        <input
          type="number"
          min={1}
          max={30}
          value={draft.searchDepthDays}
          onChange={(e) => updateField('searchDepthDays', Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))}
          className="w-20 px-3 py-1.5 bg-bg border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <p className="text-xs text-text-secondary/60 mt-1">
          How far back to search for news (1-30 days)
        </p>
      </div>
    </SettingsCard>
  )
}
