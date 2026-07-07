import { useState, useEffect } from 'react'
import { FileText, Download, RefreshCw, ChevronDown, ChevronUp, Eye, AlertCircle, Zap } from 'lucide-react'
import { formatRelTime } from '../lib/format'
import { MarkdownPreviewModal } from './MarkdownPreviewModal'
import { usePolledStatus } from '../hooks/usePolledStatus'

interface AccountPlanPanelProps {
  customerName: string
}

interface PlanData {
  markdown: string
  generatedAt: string
  driveUrl: string
}

interface PlanResponse {
  notGenerated?: boolean
  markdown?: string
  generatedAt?: string
  driveUrl?: string
}

interface MidyearSections {
  initiatives: string
  economicBuyer: string
  ecosystemStrategy: string
  securitySovereignty: string
  timeframeGuidance: string
}

interface MidyearData {
  sections: MidyearSections
  generatedAt: string
}

interface MidyearResponse {
  notGenerated?: boolean
  sections?: MidyearSections
  generatedAt?: string
}

function midyearSectionsToMarkdown(sections: MidyearSections): string {
  return [
    '## 2027 Initiatives\n' + sections.initiatives,
    '## Economic Buyer\n' + sections.economicBuyer,
    '## Ecosystem Strategy\n' + sections.ecosystemStrategy,
    '## Security & Sovereignty\n' + sections.securitySovereignty,
    '## Timeframe Guidance\n' + sections.timeframeGuidance,
  ].join('\n\n')
}

export function AccountPlanPanel({ customerName }: AccountPlanPanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [plan, setPlan] = useState<PlanData | null>(null)
  const [notGenerated, setNotGenerated] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const [midyear, setMidyear] = useState<MidyearData | null>(null)
  const [midyearGenerating, setMidyearGenerating] = useState(false)
  const [midyearError, setMidyearError] = useState<string | null>(null)
  const [showMidyearPreview, setShowMidyearPreview] = useState(false)

  // Fetch current state on mount
  useEffect(() => {
    fetch(`/api/customers/${encodeURIComponent(customerName)}/account-plan`)
      .then(r => r.json())
      .then((d: PlanResponse) => {
        if (d.notGenerated) {
          setNotGenerated(true)
          setPlan(null)
        } else if (d.markdown) {
          setPlan({ markdown: d.markdown, generatedAt: d.generatedAt ?? '', driveUrl: d.driveUrl ?? '' })
          setNotGenerated(false)
        }
      })
      .catch(() => {})

    fetch(`/api/customers/${encodeURIComponent(customerName)}/account-plan/midyear-update`)
      .then(r => r.json())
      .then((d: MidyearResponse) => {
        if (d.sections && d.generatedAt) {
          setMidyear({ sections: d.sections, generatedAt: d.generatedAt })
        }
      })
      .catch(() => {})
  }, [customerName])

  // BKL-ARCH-05: unified polled-status hook. Latches off once markdown is present.
  const { data: planStatus } = usePolledStatus<PlanResponse>(
    `/api/customers/${encodeURIComponent(customerName)}/account-plan`,
    {
      intervalMs: 3000,
      enabled: generating,
      until: d => !!d?.markdown,
    },
  )

  useEffect(() => {
    if (!planStatus?.markdown) return
    setPlan({
      markdown: planStatus.markdown,
      generatedAt: planStatus.generatedAt ?? '',
      driveUrl: planStatus.driveUrl ?? '',
    })
    setNotGenerated(false)
    setGenerating(false)
  }, [planStatus])

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customerName)}/account-plan/generate`, {
        method: 'POST',
      })
      // Parse response — non-JSON (e.g. HTML error page) will throw and be caught below
      let data: any
      try {
        data = await res.json()
      } catch {
        setError(`Server error (${res.status} ${res.statusText}) — check server logs`)
        setGenerating(false)
        return
      }
      if (data.ok) {
        // Generation complete synchronously
        setPlan({ markdown: '', generatedAt: data.generatedAt, driveUrl: data.driveUrl ?? '' })
        // Fetch full plan content
        const planRes = await fetch(`/api/customers/${encodeURIComponent(customerName)}/account-plan`)
        const planData = await planRes.json()
        if (planData.markdown) {
          setPlan({ markdown: planData.markdown, generatedAt: planData.generatedAt, driveUrl: planData.driveUrl ?? '' })
          setNotGenerated(false)
        }
        setGenerating(false)
      } else if (data.error) {
        // Show the actual server error (e.g. missing config file, Drive auth failure)
        setError(data.error)
        setGenerating(false)
      } else {
        setError(`Unexpected response from server (status ${res.status})`)
        setGenerating(false)
      }
    } catch (e: any) {
      // Network-level failure (server down, timeout, CORS)
      setError(`Network error: ${e?.message ?? 'Could not reach server'}`)
      setGenerating(false)
    }
  }

  async function handleMidyearGenerate() {
    setMidyearGenerating(true)
    setMidyearError(null)
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customerName)}/account-plan/midyear-update`, {
        method: 'POST',
      })
      let data: any
      try {
        data = await res.json()
      } catch {
        setMidyearError(`Server error (${res.status} ${res.statusText})`)
        setMidyearGenerating(false)
        return
      }
      if (data.sections) {
        setMidyear({ sections: data.sections, generatedAt: data.generatedAt })
        setMidyearGenerating(false)
      } else if (data.error) {
        setMidyearError(data.error)
        setMidyearGenerating(false)
      } else {
        setMidyearError(`Unexpected response (status ${res.status})`)
        setMidyearGenerating(false)
      }
    } catch (e: any) {
      setMidyearError(`Network error: ${e?.message ?? 'Could not reach server'}`)
      setMidyearGenerating(false)
    }
  }

  function handleDownload() {
    if (!plan?.markdown) return
    const blob = new Blob([plan.markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${customerName.toLowerCase().replace(/\s+/g, '-')}-account-plan.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const hasPlan = plan && plan.markdown && !notGenerated

  return (
    <>
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => setCollapsed(v => !v)}
          aria-expanded={!collapsed}
          className="w-full px-5 py-4 flex items-center justify-between border-b border-border/60 hover:bg-surface-hover transition-colors"
        >
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-text-primary">Account Plan</h3>
            {generating && (
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
            )}
          </div>
          {collapsed
            ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
            : <ChevronUp className="w-3.5 h-3.5 text-text-secondary" />
          }
        </button>

        {!collapsed && (
          <div className="px-5 py-4 space-y-3">
            {/* Generating state */}
            {generating && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
                <span>Generating your account plan&hellip;</span>
              </div>
            )}

            {/* Error state */}
            {error && (
              <div className="flex items-center gap-2 text-xs text-warning">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Midyear generating state */}
            {midyearGenerating && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
                <span>Generating CY27 Update&hellip;</span>
              </div>
            )}

            {/* Midyear error state */}
            {midyearError && (
              <div className="flex items-center gap-2 text-xs text-warning">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{midyearError}</span>
              </div>
            )}

            {/* Generated state — show date + action buttons */}
            {hasPlan && !generating && (
              <div className="space-y-3">
                <p className="text-[10px] text-text-secondary">
                  Generated {formatRelTime(plan.generatedAt)}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowPreview(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    View
                  </button>
                  <button
                    onClick={handleDownload}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-surface-hover text-text-primary hover:bg-border/40 border border-border transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                  <button
                    onClick={handleGenerate}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-surface-hover text-text-secondary hover:bg-border/40 border border-border transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Regenerate
                  </button>
                </div>
                <div className="flex gap-2">
                  {midyear ? (
                    <>
                      <button
                        onClick={() => setShowMidyearPreview(true)}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 border border-amber-500/20 transition-colors dark:text-amber-400"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        View CY27 Update
                      </button>
                      <button
                        onClick={handleMidyearGenerate}
                        disabled={midyearGenerating}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-surface-hover text-text-secondary hover:bg-border/40 border border-border transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Regenerate CY27
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={handleMidyearGenerate}
                      disabled={midyearGenerating}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 border border-amber-500/20 transition-colors dark:text-amber-400 disabled:opacity-50"
                    >
                      <Zap className="w-3.5 h-3.5" />
                      Generate CY27 Update
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Not generated state — show button */}
            {notGenerated && !generating && !hasPlan && (
              <div className="space-y-2">
                <p className="text-xs text-text-secondary">
                  Generate a structured account plan using AI-powered intelligence data.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleGenerate}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Generate Account Plan
                  </button>
                  {midyear ? (
                    <button
                      onClick={() => setShowMidyearPreview(true)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 border border-amber-500/20 transition-colors dark:text-amber-400"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      View CY27 Update
                    </button>
                  ) : (
                    <button
                      onClick={handleMidyearGenerate}
                      disabled={midyearGenerating}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 border border-amber-500/20 transition-colors dark:text-amber-400 disabled:opacity-50"
                    >
                      <Zap className="w-3.5 h-3.5" />
                      Generate CY27 Update
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Markdown Preview Modal */}
      {showPreview && plan && (
        <MarkdownPreviewModal
          open={showPreview}
          onClose={() => setShowPreview(false)}
          title={`${customerName} - Account Plan`}
          markdown={plan.markdown}
          generatedAt={plan.generatedAt}
          driveUrl={plan.driveUrl}
          onDownload={handleDownload}
        />
      )}

      {/* CY27 Midyear Update Preview Modal */}
      {showMidyearPreview && midyear && (
        <MarkdownPreviewModal
          open={showMidyearPreview}
          onClose={() => setShowMidyearPreview(false)}
          title={`${customerName} - CY27 Midyear Update`}
          markdown={midyearSectionsToMarkdown(midyear.sections)}
          generatedAt={midyear.generatedAt}
        />
      )}
    </>
  )
}
