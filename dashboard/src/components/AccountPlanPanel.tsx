import { useState, useEffect } from 'react'
import { FileText, Download, RefreshCw, ChevronDown, ChevronUp, Eye, AlertCircle, ExternalLink } from 'lucide-react'
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
  status?: string
}

export function AccountPlanPanel({ customerName }: AccountPlanPanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [plan, setPlan] = useState<PlanData | null>(null)
  const [notGenerated, setNotGenerated] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  useEffect(() => {
    fetch(`/api/customers/${encodeURIComponent(customerName)}/account-plan/cy27`)
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
  }, [customerName])

  const { data: planStatus } = usePolledStatus<PlanResponse>(
    `/api/customers/${encodeURIComponent(customerName)}/account-plan/cy27`,
    {
      intervalMs: 5000,
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
      const res = await fetch(`/api/customers/${encodeURIComponent(customerName)}/account-plan/generate-cy27`, {
        method: 'POST',
      })
      let data: any
      try {
        data = await res.json()
      } catch {
        setError(`Server error (${res.status} ${res.statusText}) — check server logs`)
        setGenerating(false)
        return
      }
      if (data.status === 'generating') {
        // Async — backend is generating, usePolledStatus will pick up the result
      } else if (data.error) {
        setError(data.error)
        setGenerating(false)
      }
    } catch (e: any) {
      setError(`Network error: ${e?.message ?? 'Could not reach server'}`)
      setGenerating(false)
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
            {generating && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
                <span>Generating your account plan&hellip; This may take a few minutes.</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-xs text-warning">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{error}</span>
              </div>
            )}

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
                {plan.driveUrl && (
                  <a
                    href={plan.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-surface-hover text-text-secondary hover:bg-border/40 border border-border transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open in Google Drive
                  </a>
                )}
              </div>
            )}

            {notGenerated && !generating && !hasPlan && (
              <div className="space-y-2">
                <p className="text-xs text-text-secondary">
                  Generate a structured account plan using AI-powered intelligence data.
                </p>
                <button
                  onClick={handleGenerate}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Generate Account Plan
                </button>
              </div>
            )}
          </div>
        )}
      </div>

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
    </>
  )
}
