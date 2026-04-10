import { useState, useEffect, useRef } from 'react'
import { Sparkles, FileText, ExternalLink, ChevronDown, ChevronUp, RefreshCw, AlertCircle } from 'lucide-react'
import { formatRelTime } from '../lib/format'

interface AccountIntelligencePanelProps {
  customerName: string
  driveFolderId?: string | null
}

interface IntelligenceStatus {
  status: string
  step?: string
  companyDocUrl?: string
  industryDocUrl?: string
  error?: string
  completedAt?: string
}

export function AccountIntelligencePanel({ customerName }: AccountIntelligencePanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [status, setStatus] = useState<IntelligenceStatus | null>(null)
  const [generating, setGenerating] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch initial status on mount
  useEffect(() => {
    fetch(`/api/customer/${encodeURIComponent(customerName)}/intelligence-status`)
      .then(r => r.json())
      .then((d: IntelligenceStatus) => {
        setStatus(d)
        if (d.status === 'running') setGenerating(true)
      })
      .catch(() => {})
  }, [customerName])

  // Poll every 3s while running, cleanup on unmount
  useEffect(() => {
    if (!generating) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => {
      fetch(`/api/customer/${encodeURIComponent(customerName)}/intelligence-status`)
        .then(r => r.json())
        .then((d: IntelligenceStatus) => {
          setStatus(d)
          if (d.status === 'complete' || d.status === 'error') setGenerating(false)
        })
        .catch(() => {})
    }, 3000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [generating, customerName])

  async function handleGenerate() {
    setGenerating(true)
    setStatus({ status: 'running', step: 'identifying industry' })
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/generate-intelligence`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setStatus({ status: 'error', error: (body as any).error ?? `Server error ${res.status}` })
        setGenerating(false)
      }
    } catch {
      setStatus({ status: 'error', error: 'Failed to start generation' })
      setGenerating(false)
    }
  }

  const hasCompanyDoc = status?.companyDocUrl
  const hasIndustryDoc = status?.industryDocUrl
  const hasDocs = hasCompanyDoc || hasIndustryDoc
  const isRunning = status?.status === 'running'
  const isError = status?.status === 'error'
  const isComplete = status?.status === 'complete'

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(v => !v)}
        aria-expanded={!collapsed}
        className="w-full px-5 py-4 flex items-center justify-between border-b border-border/60 hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">Account Intelligence Docs</h3>
          {isRunning && (
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
          {/* Doc links when available */}
          {hasDocs && (
            <div className="space-y-2">
              {hasCompanyDoc && (
                <a
                  href={status!.companyDocUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-accent hover:text-accent/80 transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Open Company Brief</span>
                  <ExternalLink className="w-3 h-3 ml-auto opacity-50" />
                </a>
              )}
              {hasIndustryDoc && (
                <a
                  href={status!.industryDocUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-accent hover:text-accent/80 transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Open Industry Analysis</span>
                  <ExternalLink className="w-3 h-3 ml-auto opacity-50" />
                </a>
              )}
              {isComplete && status?.completedAt && (
                <p className="text-[10px] text-text-secondary">
                  Generated {formatRelTime(status.completedAt)}
                </p>
              )}
            </div>
          )}

          {/* Progress display while running */}
          {isRunning && (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
              <span>{status?.step ?? 'Starting...'}</span>
            </div>
          )}

          {/* Error display */}
          {isError && (
            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>{status?.error ?? 'Generation failed'}</span>
            </div>
          )}

          {/* Generate button */}
          {!isRunning && (
            <button
              onClick={handleGenerate}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {hasDocs ? 'Regenerate Intelligence' : 'Generate Intelligence'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
