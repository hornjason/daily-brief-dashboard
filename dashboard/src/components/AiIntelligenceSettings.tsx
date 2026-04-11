import { useState, useEffect } from 'react'
import { Check, Loader2 } from 'lucide-react'

interface AiConfig {
  geminiModel: string
  briefSynthesisTemperature: number
  customerIntelTemperature: number
  featureExtractionMaxFeatures: number
  geminiInputCostPerM: number
  geminiOutputCostPerM: number
}

const DEFAULTS: AiConfig = {
  geminiModel: 'gemini-2.5-flash',
  briefSynthesisTemperature: 0.7,
  customerIntelTemperature: 0.3,
  featureExtractionMaxFeatures: 30,
  geminiInputCostPerM: 0.15,
  geminiOutputCostPerM: 0.60,
}

export function AiIntelligenceSettings() {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [draft, setDraft] = useState<AiConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [envModel, setEnvModel] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/ai')
      .then(r => r.json())
      .then((d: { config: AiConfig }) => {
        setConfig(d.config)
        setDraft(d.config)
      })
      .catch(() => {})
    // Check if GEMINI_MODEL env var is overriding the config
    fetch('/api/env/gemini-model')
      .then(r => r.json())
      .then((d: { model?: string; fromEnv?: boolean }) => {
        if (d.fromEnv && d.model) setEnvModel(d.model)
      })
      .catch(() => {})
  }, [])

  if (!draft) return (
    <div className="flex items-center gap-2 text-text-secondary text-sm py-6">
      <Loader2 className="w-4 h-4 animate-spin" />
      Loading settings...
    </div>
  )

  const handleSave = async () => {
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/settings/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      setConfig(data.config)
      setDraft(data.config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(config)
  const set = (key: keyof AiConfig, val: AiConfig[keyof AiConfig]) =>
    setDraft(prev => prev ? { ...prev, [key]: val } : prev)

  return (
    <div className="space-y-5">
      {/* Gemini Model */}
      <div className="bg-surface rounded-xl p-5 border border-border space-y-4">
        <p className="text-sm font-medium text-text-primary">Gemini Model</p>
        {envModel && (
          <p className="text-xs text-warning bg-warning/10 border border-warning/20 rounded-lg px-3 py-2">
            GEMINI_MODEL env var is set to <code className="font-mono">{envModel}</code> — overrides this setting.
          </p>
        )}
        <div className="flex gap-3">
          {(['gemini-2.5-flash', 'gemini-2.5-pro'] as const).map(m => (
            <button
              key={m}
              onClick={() => set('geminiModel', m)}
              className={`flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                draft.geminiModel === m
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface-hover border-border text-text-secondary hover:text-white'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-secondary">Flash is faster and cheaper; Pro is more capable for complex analysis.</p>
      </div>

      {/* Temperature sliders */}
      <div className="bg-surface rounded-xl p-5 border border-border space-y-5">
        <p className="text-sm font-medium text-text-primary">Generation Temperature</p>

        <TemperatureSlider
          label="Brief Synthesis"
          hint="Controls creativity in daily brief generation. Higher = more expressive, lower = more focused."
          value={draft.briefSynthesisTemperature}
          onChange={v => set('briefSynthesisTemperature', v)}
          defaultValue={DEFAULTS.briefSynthesisTemperature}
        />

        <TemperatureSlider
          label="Customer Product Intel"
          hint="Controls output variance in product/feature intelligence cards. Lower values produce more consistent, factual output."
          value={draft.customerIntelTemperature}
          onChange={v => set('customerIntelTemperature', v)}
          defaultValue={DEFAULTS.customerIntelTemperature}
        />
      </div>

      {/* Feature extraction */}
      <div className="bg-surface rounded-xl p-5 border border-border space-y-3">
        <p className="text-sm font-medium text-text-primary">Feature Extraction</p>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Max features per product</p>
            <p className="text-xs text-text-secondary">Maximum features extracted from product release notes per radar refresh.</p>
          </div>
          <input
            type="number"
            min={1}
            max={100}
            value={draft.featureExtractionMaxFeatures}
            onChange={e => set('featureExtractionMaxFeatures', Math.max(1, Math.min(100, Number(e.target.value))))}
            className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {/* Pricing */}
      <div className="bg-surface rounded-xl p-5 border border-border space-y-4">
        <p className="text-sm font-medium text-text-primary">Gemini Pricing (USD per 1M tokens)</p>
        <p className="text-xs text-text-secondary">Used for cost estimation in the usage dashboard. Update if Google changes pricing.</p>
        <div className="grid grid-cols-2 gap-4">
          <PriceField
            label="Input tokens"
            value={draft.geminiInputCostPerM}
            onChange={v => set('geminiInputCostPerM', v)}
          />
          <PriceField
            label="Output tokens"
            value={draft.geminiOutputCostPerM}
            onChange={v => set('geminiOutputCostPerM', v)}
          />
        </div>
      </div>

      {error && <p className="text-xs text-error">{error}</p>}

      <button
        onClick={handleSave}
        disabled={!dirty || saving}
        className="flex items-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
      >
        {saving
          ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
          : saved
          ? <><Check className="w-4 h-4" /> Saved</>
          : 'Save AI Settings'}
      </button>
    </div>
  )
}

function TemperatureSlider({
  label, hint, value, onChange, defaultValue,
}: {
  label: string; hint: string; value: number; onChange: (v: number) => void; defaultValue: number
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-primary">{label}</p>
          <p className="text-xs text-text-secondary">{hint}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          <span className="text-sm text-white w-8 text-right">{(value ?? 0).toFixed(1)}</span>
          {value !== defaultValue && (
            <button
              onClick={() => onChange(defaultValue)}
              className="text-xs text-text-secondary hover:text-white underline"
            >
              reset
            </button>
          )}
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
      <div className="flex justify-between text-xs text-text-secondary">
        <span>0.0 — focused</span>
        <span>1.0 — creative</span>
      </div>
    </div>
  )
}

function PriceField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-text-secondary">{label}</label>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-text-secondary">$</span>
        <input
          type="number"
          min={0}
          step={0.01}
          value={value}
          onChange={e => onChange(Math.max(0, Number(e.target.value)))}
          className="w-full bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
    </div>
  )
}
