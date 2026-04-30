/**
 * BKL-HERO-01 Phase 1 — Step 0 Region & Pod Access component.
 *
 * First-boot UI for selecting which regions/pods this hero install can access.
 * Backend (Phase 0): GET /api/regions/catalog + POST /api/regions/access.
 *
 * Behavior:
 *   - Mount → fetch catalog (loading spinner)
 *   - Each region renders as a row: checkbox + label + chevron toggle
 *   - Selectable regions: checkbox + expand to choose pods
 *   - Coming Soon regions: checkbox disabled; expand reveals comingSoonReason
 *   - TOLA special case (single-pod region): when region is checked,
 *     the single pod auto-selects; no pod sub-selection UI shown
 *   - "Save & Next": disabled until ≥1 pod selected; POSTs to /api/regions/access
 *   - On 200: calls onSave(enabledRegions, enabledPods); parent collapses to summary
 *
 * Visual style mirrors existing setup wizard cards (bg-surface rounded-xl etc).
 */
import { useState, useEffect } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Clock,
  Loader2,
  XCircle,
} from 'lucide-react'

interface CatalogPod {
  key: string
  label: string
  qualifiedKey: string  // `${regionId}.${podKey}`
}

interface CatalogRegion {
  id: string
  label: string
  selectable: boolean
  comingSoonReason?: string
  pods: CatalogPod[]
}

interface Step0Props {
  onSave: (enabledRegions: string[], enabledPods: string[]) => void
  /** When provided, render the collapsed summary state instead of the form. */
  initialEnabledRegions?: string[]
  initialEnabledPods?: string[]
}

export function Step0RegionAccess({ onSave, initialEnabledRegions, initialEnabledPods }: Step0Props) {
  const [catalog, setCatalog] = useState<CatalogRegion[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(
    new Set(initialEnabledRegions ?? []),
  )
  const [selectedPods, setSelectedPods] = useState<Set<string>>(
    new Set(initialEnabledPods ?? []),
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Collapsed summary mode — initial when parent says "we already have a saved selection"
  const [summaryMode, setSummaryMode] = useState<boolean>(
    Array.isArray(initialEnabledRegions) && initialEnabledRegions.length > 0,
  )

  // Fetch the catalog on mount
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/regions/catalog', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { regions: CatalogRegion[] }) => {
        setCatalog(d.regions ?? [])
      })
      .catch(e => {
        if (e.name !== 'AbortError') setLoadError(e.message ?? 'Failed to load region catalog')
      })
    return () => controller.abort()
  }, [])

  const toggleExpand = (regionId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(regionId)) next.delete(regionId); else next.add(regionId)
      return next
    })
  }

  const isTolaSinglePod = (region: CatalogRegion) =>
    region.selectable && region.pods.length === 1

  const toggleRegion = (region: CatalogRegion) => {
    if (!region.selectable) return
    const checked = selectedRegions.has(region.id)
    setSelectedRegions(prev => {
      const next = new Set(prev)
      if (checked) next.delete(region.id); else next.add(region.id)
      return next
    })
    // Pod selection side-effects
    setSelectedPods(prev => {
      const next = new Set(prev)
      if (checked) {
        // Region unchecked → drop all its pods
        for (const pod of region.pods) next.delete(pod.qualifiedKey)
      } else if (isTolaSinglePod(region)) {
        // TOLA-style auto-select the lone pod
        next.add(region.pods[0].qualifiedKey)
      } else {
        // Multi-pod regions: check ALL pods when region is checked (header acts as select-all)
        for (const pod of region.pods) next.add(pod.qualifiedKey)
      }
      return next
    })
  }

  const togglePod = (region: CatalogRegion, pod: CatalogPod) => {
    if (!region.selectable) return
    setSelectedPods(prevPods => {
      const nextPods = new Set(prevPods)
      if (nextPods.has(pod.qualifiedKey)) nextPods.delete(pod.qualifiedKey)
      else nextPods.add(pod.qualifiedKey)
      // Keep region selection in sync with whether any of its pods are selected
      setSelectedRegions(prevRegions => {
        const nextRegions = new Set(prevRegions)
        const anyPodSelected = region.pods.some(p => nextPods.has(p.qualifiedKey))
        if (anyPodSelected) nextRegions.add(region.id)
        else nextRegions.delete(region.id)
        return nextRegions
      })
      return nextPods
    })
  }

  const handleSave = async () => {
    setSaveError(null)
    setSaving(true)
    try {
      // Derive final region set from pod selections — only include regions that
      // have at least one selected pod (matches catalog/validation expectations).
      const finalRegions: string[] = []
      const finalPods = Array.from(selectedPods)
      for (const region of catalog ?? []) {
        const anyPod = region.pods.some(p => finalPods.includes(p.qualifiedKey))
        if (anyPod) finalRegions.push(region.id)
      }

      const res = await fetch('/api/regions/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledRegions: finalRegions, enabledPods: finalPods }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error ?? `Save failed (${res.status})`)
      }
      // Success — flip to summary, notify parent
      setSummaryMode(true)
      onSave(finalRegions, finalPods)
    } catch (e: any) {
      setSaveError(e.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Collapsed summary ──────────────────────────────────────────────
  if (summaryMode) {
    // Group selected pods by region label for display
    const lines: { regionLabel: string; podLabels: string[] }[] = []
    for (const region of catalog ?? []) {
      const pods = region.pods.filter(p => selectedPods.has(p.qualifiedKey))
      if (pods.length === 0) continue
      lines.push({ regionLabel: region.label, podLabels: pods.map(p => p.label) })
    }

    return (
      <section
        data-testid="step0-summary"
        className="bg-surface rounded-xl border border-border overflow-hidden"
      >
        <div className="px-6 py-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <CheckCircle className="w-5 h-5 text-success shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">Region Access Configured</p>
              {lines.length === 0 ? (
                <p className="text-xs text-text-secondary mt-0.5">No pods selected</p>
              ) : (
                lines.map(line => (
                  <p key={line.regionLabel} className="text-xs text-text-secondary mt-0.5 truncate">
                    {line.regionLabel}: {line.podLabels.join(', ')}
                  </p>
                ))
              )}
            </div>
          </div>
          <button
            data-testid="step0-edit"
            onClick={() => setSummaryMode(false)}
            className="text-xs text-accent hover:text-accent/80 underline shrink-0"
          >
            [Edit]
          </button>
        </div>
      </section>
    )
  }

  // ── Loading ─────────────────────────────────────────────────────────
  if (catalog === null && !loadError) {
    return (
      <section className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4">
          <h2 className="text-base font-semibold text-white mb-1">Step 0 — Region & Pod Access</h2>
        </div>
        <div className="px-6 pb-6 pt-4 flex items-center gap-2 text-text-secondary text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading region catalog...
        </div>
      </section>
    )
  }

  if (loadError) {
    return (
      <section className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4">
          <h2 className="text-base font-semibold text-white mb-1">Step 0 — Region & Pod Access</h2>
        </div>
        <div className="px-6 pb-6 pt-4 flex items-center gap-2 text-critical text-sm">
          <XCircle className="w-4 h-4" />
          {loadError}
        </div>
      </section>
    )
  }

  // ── Form ────────────────────────────────────────────────────────────
  const podCount = selectedPods.size
  const regionCount = (catalog ?? []).filter(r =>
    r.pods.some(p => selectedPods.has(p.qualifiedKey)),
  ).length

  return (
    <section
      data-testid="step0-region-access"
      className="bg-surface rounded-xl border border-border overflow-hidden"
    >
      <div className="px-6 py-4 border-b border-border/50">
        <h2 className="text-base font-semibold text-white">Step 0 — Select Your Region & Pods</h2>
        <p className="text-xs text-text-secondary mt-1">
          Choose what you want access to. Saved once — editable later from Admin › Region Access.
        </p>
      </div>

      <div className="px-6 pb-6 pt-4 space-y-2">
        {(catalog ?? []).map(region => {
          const isOpen = expanded.has(region.id)
          const checked = selectedRegions.has(region.id)
          const tolaSingle = isTolaSinglePod(region)

          return (
            <div
              key={region.id}
              data-testid={`region-row-${region.id}`}
              className={`rounded-lg border ${region.selectable ? 'border-border/70' : 'border-border/40'}`}
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <input
                  type="checkbox"
                  data-testid={`region-checkbox-${region.id}`}
                  className="accent-accent w-4 h-4 shrink-0 disabled:opacity-40"
                  disabled={!region.selectable}
                  checked={checked}
                  onChange={() => toggleRegion(region)}
                />
                <button
                  type="button"
                  onClick={() => toggleExpand(region.id)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left hover:text-white"
                  data-testid={`region-toggle-${region.id}`}
                >
                  {isOpen
                    ? <ChevronDown className="w-4 h-4 text-text-secondary shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-text-secondary shrink-0" />}
                  <span className={`text-sm ${region.selectable ? 'text-white' : 'text-text-secondary'}`}>
                    {region.label}
                  </span>
                  {!region.selectable && (
                    <span className="ml-auto flex items-center gap-1 text-xs text-text-secondary">
                      <Clock className="w-3 h-3" />
                      Coming soon
                    </span>
                  )}
                  {tolaSingle && region.selectable && (
                    <span className="ml-auto text-xs text-text-secondary">
                      Single territory
                    </span>
                  )}
                </button>
              </div>

              {isOpen && (
                <div className="px-3 pb-3 pt-0 ml-7 border-t border-border/30">
                  {!region.selectable ? (
                    <p
                      className="text-xs text-text-secondary mt-2"
                      data-testid={`region-coming-soon-reason-${region.id}`}
                    >
                      {region.comingSoonReason ?? 'Coming soon — data reports pending'}
                    </p>
                  ) : tolaSingle ? (
                    <p className="text-xs text-text-secondary mt-2">
                      Single territory — auto-selected when region is checked.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {region.pods.map(pod => (
                        <li key={pod.qualifiedKey} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            data-testid={`pod-checkbox-${pod.qualifiedKey}`}
                            className="accent-accent w-4 h-4 shrink-0"
                            checked={selectedPods.has(pod.qualifiedKey)}
                            onChange={() => togglePod(region, pod)}
                          />
                          <span className="text-sm text-text-primary">{pod.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div className="flex items-center justify-between pt-4 mt-2 border-t border-border/50">
          <p className="text-xs text-text-secondary" data-testid="step0-counter">
            {podCount === 0
              ? 'No pods selected'
              : `${podCount} pod${podCount === 1 ? '' : 's'} selected across ${regionCount} region${regionCount === 1 ? '' : 's'}`}
          </p>
          <button
            data-testid="step0-save"
            onClick={handleSave}
            disabled={podCount === 0 || saving}
            className="bg-accent hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saving ? 'Saving...' : 'Save & Next'}
          </button>
        </div>

        {saveError && (
          <p className="text-sm text-critical flex items-center gap-1.5 pt-2" data-testid="step0-error">
            <XCircle className="w-4 h-4" />
            {saveError}
          </p>
        )}
      </div>
    </section>
  )
}
