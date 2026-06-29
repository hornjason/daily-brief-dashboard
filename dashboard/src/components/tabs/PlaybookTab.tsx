/**
 * GitHub Issue #296, #687: PlaybookTab component
 *
 * Displays all 15 customer engagement playbook sections with progressive
 * disclosure driven by the shared tier config (src/playbook-tiers.ts):
 *
 * Tier 1 (always expanded): Expansion Opportunities, Open Action Items,
 *   Renewals and Risk, Solution Plays, Current Priorities
 * Tier 2 (collapsed by default): Strategic Position, Key Relationships,
 *   Product Alignment, SWOT Analysis, MEDDPICC
 * Tier 3 (collapsed, at bottom): Engagement History, Subscriptions,
 *   Support Cases, Product Lifecycle, Account Team
 *
 * Section ordering is driven entirely by PLAYBOOK_SECTION_TIERS — no
 * hardcoded section orderings exist in this file.
 */

import { useState, useEffect } from 'react'
import {
  BookOpen,
  Loader2,
  Plus,
  FileText,
  Upload,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  CheckCircle,
  Circle,
  ExternalLink,
  X,
  RefreshCw,
  Users,
  Shield,
  Clock,
  Package
} from 'lucide-react'
import type { PlaybookState, ActionItem, ProductAlignmentEntry, MEDDPICCEntry } from '../../../../src/playbook-types'
import { PLAYBOOK_SECTION_TIERS, TIER_1_KEYS, type PlaybookSectionKey } from '../../../../src/playbook-tiers'

interface PlaybookTabProps {
  customerName: string
}

// Simple modal for ingesting notes
function IngestNotesModal({
  isOpen,
  onClose,
  onIngest
}: {
  isOpen: boolean
  onClose: () => void
  onIngest: (url: string) => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return

    setLoading(true)
    setError(null)

    try {
      await onIngest(url)
      setUrl('')
      onClose()
    } catch (err: any) {
      setError(err.message || 'Failed to ingest notes')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface border border-border rounded-xl p-6 max-w-md w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-text-primary">Ingest Meeting Notes</h3>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors"
            disabled={loading}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="doc-url" className="block text-sm font-medium text-text-primary mb-2">
              Google Doc URL
            </label>
            <input
              id="doc-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/document/d/..."
              className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-accent/50"
              disabled={loading}
            />
          </div>

          {error && (
            <p className="text-sm text-critical">{error}</p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent font-medium hover:bg-accent/20 transition-colors disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Ingesting...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Ingest
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function PlaybookTab({ customerName }: PlaybookTabProps) {
  const [playbook, setPlaybook] = useState<PlaybookState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [ingestModalOpen, setIngestModalOpen] = useState(false)
  // Initialize expanded state from tier config: Tier 1 sections start expanded
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(TIER_1_KEYS as string[])
  )

  // Fetch playbook
  const fetchPlaybook = async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/playbook`)

      if (res.status === 404) {
        // No playbook exists yet
        setPlaybook(null)
        setError(null)
      } else if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Failed to fetch playbook' }))
        throw new Error(errData.error || 'Failed to fetch playbook')
      } else {
        const data = await res.json()
        setPlaybook(data)
      }
    } catch (e: any) {
      setError(e.message || 'Failed to fetch playbook')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPlaybook()
  }, [customerName])

  // Generate playbook
  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)

    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/playbook/generate`, {
        method: 'POST',
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Failed to generate playbook' }))
        throw new Error(errData.error || 'Failed to generate playbook')
      }

      const data = await res.json()
      setPlaybook(data)
    } catch (e: any) {
      setError(e.message || 'Failed to generate playbook')
    } finally {
      setGenerating(false)
    }
  }

  // Ingest notes
  const handleIngestNotes = async (docUrl: string) => {
    const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/playbook/ingest-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docUrl }),
    })

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Failed to ingest notes' }))
      throw new Error(errData.error || 'Failed to ingest notes')
    }

    // Refresh playbook after successful ingestion
    await fetchPlaybook()
  }

  // Toggle section expansion
  const toggleSection = (sectionKey: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionKey)) {
        next.delete(sectionKey)
      } else {
        next.add(sectionKey)
      }
      return next
    })
  }

  // Toggle action item status (visual only for now)
  const toggleActionItem = async (itemId: string) => {
    // This is visual-only for now — PATCH endpoint in #297
    if (!playbook) return

    const updated = { ...playbook }
    const item = updated.sections.openActionItems.items.find(i => i.id === itemId)
    if (item) {
      item.status = item.status === 'open' ? 'completed' : 'open'
      item.completedAt = item.status === 'completed' ? new Date().toISOString() : null
      setPlaybook(updated)
    }
  }

  // Render bold markdown: **text** → <strong>text</strong>
  const renderInlineMarkdown = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className="text-accent font-semibold">{part.slice(2, -2)}</strong>
      }
      return <span key={i}>{part}</span>
    })
  }

  // Render section content with markdown support (bullets, tables, headers, bold)
  const renderMarkdownContent = (content: string) => {
    // Pre-process: Gemini sometimes returns bullets/headers on a single line
    const normalized = content
      .replace(/\s+(#{1,3}\s)/g, '\n$1')
      .replace(/\.\s+-\s+\*\*/g, '.\n- **')
      .replace(/\s+•\s+/g, '\n• ')
      .replace(/\.\s*Business value:/g, '.\n**Business value:** ')
    const lines = normalized.split('\n')

    // Detect markdown table blocks
    const elements: React.ReactNode[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i].trim()
      if (!line) { i++; continue }

      // Detect table: line starts with | and next line is separator |---|
      if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s-|]+\|$/.test(lines[i + 1]?.trim())) {
        // Collect all table lines
        const tableLines: string[] = []
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tableLines.push(lines[i].trim())
          i++
        }
        // Parse header + separator + rows
        const headerCells = tableLines[0].split('|').filter(c => c.trim()).map(c => c.trim())
        const dataRows = tableLines.slice(2).map(row => row.split('|').filter(c => c.trim()).map(c => c.trim()))

        elements.push(
          <div key={`table-${i}`} className="overflow-x-auto mb-4">
            <table className="w-full text-sm border border-border-primary rounded">
              <thead>
                <tr className="bg-surface-secondary">
                  {headerCells.map((cell, ci) => (
                    <th key={ci} className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">{renderInlineMarkdown(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row, ri) => (
                  <tr key={ri} className="border-b border-border-primary last:border-0">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-3 py-2 text-text-primary">{renderInlineMarkdown(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        continue
      }

      // Handle markdown lists
      if (line.startsWith('- ') || line.startsWith('* ')) {
        elements.push(
          <div key={i} className="flex gap-2 mb-2">
            <span className="text-accent mt-0.5 shrink-0">·</span>
            <span className="text-text-primary">{renderInlineMarkdown(line.replace(/^[-*]\s*/, ''))}</span>
          </div>
        )
        i++
        continue
      }

      // Handle headers
      if (line.startsWith('### ')) {
        elements.push(<h4 key={i} className="text-sm font-semibold mt-4 mb-2 text-text-primary">{line.replace(/^###\s*/, '')}</h4>)
        i++
        continue
      }

      // Regular text
      elements.push(<p key={i} className="mb-2 text-text-primary">{renderInlineMarkdown(line)}</p>)
      i++
    }

    return <div className="prose prose-sm max-w-none">{elements}</div>
  }

  // ── Section-specific renderers ──────────────────────────────────────────

  /** Sections with simple markdown content from playbook.sections */
  const renderNarrativeSection = (key: string) => {
    const section = (playbook!.sections as any)[key]
    if (!section) return <p className="text-sm text-text-secondary italic">No data available</p>
    const content = section.content || section
    if (typeof content !== 'string') return <p className="text-sm text-text-secondary italic">No data available</p>
    return renderMarkdownContent(content)
  }

  const renderSolutionPlays = () => {
    const plays = playbook!.deterministic?.solutionPlays
    if (!plays || plays.length === 0) {
      return <p className="text-sm text-text-secondary italic">No solution plays available</p>
    }
    return (
      <div className="space-y-4">
        {plays.map((play: any, idx: number) => (
          <div key={idx} className="border border-border/40 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded">{play.tdp}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${play.confidence === 'HIGH' ? 'bg-green-500/10 text-green-400' : play.confidence === 'MEDIUM' ? 'bg-yellow-500/10 text-yellow-400' : 'bg-gray-500/10 text-gray-400'}`}>
                {play.confidence}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-text-primary mb-1">{play.playName}</h3>
            <p className="text-xs text-text-secondary mb-2">
              Triggered by: {play.triggerTechnologies?.join(', ') || 'N/A'}
            </p>
            {play.talkTrack && (
              <p className="text-xs text-text-secondary italic border-l-2 border-accent/30 pl-3 mb-2">
                {play.talkTrack.length > 200 ? play.talkTrack.slice(0, 200) + '…' : play.talkTrack}
              </p>
            )}
            {play.customerWins && play.customerWins.length > 0 && (
              <div className="mt-2">
                <span className="text-xs font-medium text-text-secondary">Proof points:</span>
                <ul className="mt-1 space-y-0.5">
                  {play.customerWins.map((win: string, i: number) => (
                    <li key={i} className="text-xs text-text-secondary">{'•'} {win}</li>
                  ))}
                </ul>
              </div>
            )}
            {play.linkedAssets && play.linkedAssets.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {play.linkedAssets.map((asset: any, i: number) => (
                  <a key={i} href={asset.url} target="_blank" rel="noopener noreferrer"
                     className="text-xs text-accent hover:text-accent/80 underline">
                    {asset.name}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }

  const renderProductAlignment = () => {
    const products = playbook!.sections.productAlignment.products
    if (products.length === 0) {
      return <p className="text-sm text-text-secondary italic">No products aligned yet</p>
    }
    return (
      <div className="space-y-4">
        {products.map((product: ProductAlignmentEntry) => (
          <div key={product.productSlug} className="bg-bg-secondary/30 rounded-lg p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <a
                  href={product.dashboardLink}
                  className="text-base font-semibold text-accent hover:underline inline-flex items-center gap-1"
                >
                  {product.displayName}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <span className={`ml-2 text-xs px-2 py-0.5 rounded ${
                  product.confidence === 'HIGH'
                    ? 'bg-green-500/20 text-green-400'
                    : product.confidence === 'MEDIUM'
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'bg-zinc-500/20 text-zinc-400'
                }`}>
                  {product.confidence}
                </span>
              </div>
            </div>

            <div className="space-y-2 text-sm">
              <div>
                <span className="font-medium text-text-primary">Use Case:</span>
                <p className="text-text-secondary mt-1">{renderInlineMarkdown(product.useCase)}</p>
              </div>

              {product.proofPoints && (
                <div>
                  <span className="font-medium text-text-primary">Proof Points:</span>
                  <div className="mt-2 space-y-1.5">
                    {product.proofPoints.split(/[|]/).map((point: string, i: number) => {
                      const trimmed = point.trim()
                      if (!trimmed) return null
                      const pctMatch = trimmed.match(/^(\d+%)/)
                      return (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          {pctMatch ? (
                            <span className="shrink-0 px-2 py-0.5 rounded bg-accent/15 text-accent font-semibold text-xs">{pctMatch[1]}</span>
                          ) : (
                            <span className="shrink-0 text-accent mt-0.5">·</span>
                          )}
                          <span className="text-text-secondary">{pctMatch ? trimmed.slice(pctMatch[1].length).trim() : trimmed}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {product.lifecycle && (
                <div>
                  <span className="font-medium text-text-primary">Lifecycle:</span>
                  <p className="text-text-secondary mt-1">{product.lifecycle}</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const renderOpenActionItems = () => {
    const items = playbook!.sections.openActionItems.items
    if (items.length === 0) {
      return <p className="text-sm text-text-secondary italic">No action items yet</p>
    }
    return (
      <div className="space-y-2">
        {items.map((item: ActionItem) => (
          <div
            key={item.id}
            className="flex items-start gap-3 p-3 rounded-lg hover:bg-bg-secondary/30 transition-colors"
          >
            <button
              onClick={() => toggleActionItem(item.id)}
              className="mt-0.5 text-text-secondary hover:text-accent transition-colors"
            >
              {item.status === 'completed' ? (
                <CheckCircle className="w-5 h-5 text-success" />
              ) : (
                <Circle className="w-5 h-5" />
              )}
            </button>
            <div className="flex-1 min-w-0">
              <p className={`text-sm ${item.status === 'completed' ? 'line-through text-text-secondary' : 'text-text-primary'}`}>
                {item.text}
              </p>
              <div className="flex items-center gap-2 mt-1 text-xs text-text-secondary">
                <span>Owner: {item.owner}</span>
                {item.completedAt && (
                  <span>· Completed {new Date(item.completedAt).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const renderEngagementHistory = () => {
    const entries = playbook!.sections.engagementHistory.entries
    if (entries.length === 0) {
      return <p className="text-sm text-text-secondary italic">No engagement history yet</p>
    }
    return (
      <div className="space-y-3">
        {entries.map((entry: any, i: number) => (
          <div key={i} className="border-l-2 border-accent/30 pl-4 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-accent uppercase">{entry.type}</span>
              <span className="text-xs text-text-secondary">
                {new Date(entry.date).toLocaleDateString()}
              </span>
            </div>
            <p className="text-sm text-text-primary">{entry.summary}</p>
            {entry.attendees.length > 0 && (
              <p className="text-xs text-text-secondary mt-1">
                Attendees: {entry.attendees.join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
    )
  }

  const renderMeddpicc = () => {
    const meddpicc = playbook!.sections.meddpicc
    if (!meddpicc || meddpicc.entries.length === 0) {
      return <p className="text-sm text-text-secondary italic">No MEDDPICC data available</p>
    }
    return (
      <div className="grid grid-cols-2 gap-4">
        {meddpicc.entries.map((entry: MEDDPICCEntry) => (
          <div
            key={entry.field}
            className={`bg-bg-secondary/30 rounded-lg p-4 border-l-4 ${
              entry.status === 'confirmed'
                ? 'border-green-500'
                : entry.status === 'developing'
                ? 'border-yellow-500'
                : 'border-zinc-500'
            }`}
          >
            <div className="flex items-start justify-between mb-2">
              <h3 className="font-semibold text-text-primary">{entry.displayName}</h3>
              <span className={`text-xs px-2 py-0.5 rounded font-semibold ${
                entry.status === 'confirmed'
                  ? 'bg-green-500/20 text-green-400'
                  : entry.status === 'developing'
                  ? 'bg-yellow-500/20 text-yellow-400'
                  : 'bg-zinc-500/20 text-zinc-400'
              }`}>
                {entry.status.toUpperCase()}
              </span>
            </div>
            <p className="text-sm text-text-secondary">{renderInlineMarkdown(entry.evidence)}</p>
          </div>
        ))}
      </div>
    )
  }

  const renderSubscriptions = () => {
    const subs = playbook!.deterministic?.subscriptions
    if (!subs || subs.length === 0) {
      return <p className="text-sm text-text-secondary italic">No subscription data available</p>
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-border-primary rounded">
          <thead>
            <tr className="bg-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Product</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Qty</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Status</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">End Date</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((sub: any, i: number) => (
              <tr key={i} className="border-b border-border-primary last:border-0">
                <td className="px-3 py-2 text-text-primary">{sub.productDescription}</td>
                <td className="px-3 py-2 text-text-secondary">{sub.quantity}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    sub.status === 'Active' ? 'bg-green-500/10 text-green-400' : 'bg-zinc-500/10 text-zinc-400'
                  }`}>{sub.status}</span>
                </td>
                <td className="px-3 py-2 text-text-secondary">{sub.endDate || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const renderCases = () => {
    const cases = playbook!.deterministic?.cases
    if (!cases || cases.length === 0) {
      return <p className="text-sm text-text-secondary italic">No support cases</p>
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-border-primary rounded">
          <thead>
            <tr className="bg-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Case #</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Summary</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Sev</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Status</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Days Open</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c: any, i: number) => (
              <tr key={i} className="border-b border-border-primary last:border-0">
                <td className="px-3 py-2 text-accent font-mono text-xs">{c.caseNumber}</td>
                <td className="px-3 py-2 text-text-primary">{c.summary}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs px-2 py-0.5 rounded font-semibold ${
                    c.severity === '1' ? 'bg-red-500/20 text-red-400'
                    : c.severity === '2' ? 'bg-orange-500/20 text-orange-400'
                    : 'bg-zinc-500/10 text-zinc-400'
                  }`}>{c.severity}</span>
                </td>
                <td className="px-3 py-2 text-text-secondary text-xs">{c.status}</td>
                <td className="px-3 py-2 text-text-secondary text-xs">{c.daysOpen}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const renderLifecycle = () => {
    const lifecycle = playbook!.deterministic?.lifecycle
    if (!lifecycle || lifecycle.length === 0) {
      return <p className="text-sm text-text-secondary italic">No lifecycle data available</p>
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-border-primary rounded">
          <thead>
            <tr className="bg-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Product</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Current Version</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">GA Date</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">EOL Date</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Next</th>
            </tr>
          </thead>
          <tbody>
            {lifecycle.map((lc: any, i: number) => (
              <tr key={i} className="border-b border-border-primary last:border-0">
                <td className="px-3 py-2 text-text-primary font-medium">{lc.displayName}</td>
                <td className="px-3 py-2 text-text-secondary">v{lc.currentVersion}</td>
                <td className="px-3 py-2 text-text-secondary text-xs">{lc.gaDate?.slice(0, 10) || '-'}</td>
                <td className="px-3 py-2 text-text-secondary text-xs">{lc.eolDate?.slice(0, 10) || '-'}</td>
                <td className="px-3 py-2 text-text-secondary text-xs">{lc.nextVersion ? `v${lc.nextVersion}` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const renderTeamMembers = () => {
    const team = playbook!.deterministic?.teamMembers
    if (!team || team.length === 0) {
      return <p className="text-sm text-text-secondary italic">No team data available</p>
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-border-primary rounded">
          <thead>
            <tr className="bg-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Name</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Role</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary border-b border-border-primary">Focus</th>
            </tr>
          </thead>
          <tbody>
            {team.map((member: any, i: number) => (
              <tr key={i} className="border-b border-border-primary last:border-0">
                <td className="px-3 py-2 text-text-primary font-medium">{member.name}</td>
                <td className="px-3 py-2 text-text-secondary">{member.role}</td>
                <td className="px-3 py-2 text-text-secondary text-xs">{member.products?.join(', ') || member.focusArea || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // ── Section content dispatcher ──────────────────────────────────────────

  /** Returns the rendered content for a given section key */
  const renderSectionContent = (key: PlaybookSectionKey): React.ReactNode => {
    switch (key) {
      // Narrative sections (from playbook.sections)
      case 'strategicPosition':
      case 'currentPriorities':
      case 'expansionOpportunities':
      case 'renewalsAndRisk':
      case 'swotAnalysis':
      case 'keyRelationships':
        return renderNarrativeSection(key)

      // Structured sections (from playbook.sections)
      case 'productAlignment':
        return renderProductAlignment()
      case 'openActionItems':
        return renderOpenActionItems()
      case 'engagementHistory':
        return renderEngagementHistory()
      case 'meddpicc':
        return renderMeddpicc()

      // Deterministic sections (from playbook.deterministic)
      case 'solutionPlays':
        return renderSolutionPlays()
      case 'subscriptions':
        return renderSubscriptions()
      case 'cases':
        return renderCases()
      case 'lifecycle':
        return renderLifecycle()
      case 'teamMembers':
        return renderTeamMembers()

      default:
        return <p className="text-sm text-text-secondary italic">No data available</p>
    }
  }

  /** Returns header extras (badges, counts) for specific sections */
  const renderHeaderExtra = (key: PlaybookSectionKey): React.ReactNode => {
    switch (key) {
      case 'solutionPlays': {
        const plays = playbook!.deterministic?.solutionPlays
        return (
          <>
            {plays && plays.length > 0 && (
              <span className="text-xs px-2 py-0.5 bg-accent/10 text-accent rounded-full">
                {plays.length} active
              </span>
            )}
            {(playbook as any).solutionPlaysStale && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm('Regenerate playbook to refresh solution plays with latest SalesHub data?')) {
                    handleGenerate()
                  }
                }}
                className="text-xs px-2 py-0.5 bg-warning/10 text-warning rounded-full border border-warning/20 hover:bg-warning/20 transition-colors"
              >
                Stale -- click to refresh
              </button>
            )}
          </>
        )
      }
      case 'openActionItems': {
        const openCount = playbook!.sections.openActionItems.items.filter(i => i.status === 'open').length
        return (
          <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">
            {openCount} open
          </span>
        )
      }
      case 'meddpicc': {
        const meddpicc = playbook!.sections.meddpicc
        if (!meddpicc) return null
        return (
          <span className={`px-3 py-1 rounded text-xs font-semibold ${
            meddpicc.qualificationScore >= 63
              ? 'bg-green-500/20 text-green-400'
              : meddpicc.qualificationScore >= 25
              ? 'bg-yellow-500/20 text-yellow-400'
              : 'bg-red-500/20 text-red-400'
          }`}>
            {meddpicc.qualificationScore}% Qualified
          </span>
        )
      }
      case 'subscriptions': {
        const count = playbook!.deterministic?.subscriptions?.length ?? 0
        return count > 0 ? (
          <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">{count}</span>
        ) : null
      }
      case 'cases': {
        const count = playbook!.deterministic?.cases?.length ?? 0
        return count > 0 ? (
          <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">{count}</span>
        ) : null
      }
      case 'engagementHistory': {
        const count = playbook!.sections.engagementHistory.entries.length
        return count > 0 ? (
          <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">{count}</span>
        ) : null
      }
      case 'teamMembers': {
        const count = playbook!.deterministic?.teamMembers?.length ?? 0
        return count > 0 ? (
          <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">{count}</span>
        ) : null
      }
      default:
        return null
    }
  }

  /** Check if a section has data to render */
  const sectionHasData = (key: PlaybookSectionKey): boolean => {
    switch (key) {
      case 'solutionPlays':
        return !!(playbook!.deterministic?.solutionPlays && playbook!.deterministic.solutionPlays.length > 0)
      case 'subscriptions':
        return !!(playbook!.deterministic?.subscriptions && playbook!.deterministic.subscriptions.length > 0)
      case 'cases':
        return !!(playbook!.deterministic?.cases && playbook!.deterministic.cases.length > 0)
      case 'lifecycle':
        return !!(playbook!.deterministic?.lifecycle && playbook!.deterministic.lifecycle.length > 0)
      case 'teamMembers':
        return !!(playbook!.deterministic?.teamMembers && playbook!.deterministic.teamMembers.length > 0)
      default:
        // Narrative and structured sections always render (may show empty state)
        return true
    }
  }

  // ── Render states ───────────────────────────────────────────────────────

  // Loading state
  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="py-12 text-center space-y-4">
          <Loader2 className="w-12 h-12 text-accent mx-auto animate-spin" />
          <p className="text-sm text-text-secondary">Loading playbook...</p>
        </div>
      </div>
    )
  }

  // No playbook state
  if (!playbook && !error) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="bg-surface border border-border rounded-xl p-8 text-center space-y-6">
          <div className="relative mx-auto w-20 h-20">
            <div className="absolute inset-0 bg-accent/10 rounded-full" />
            <BookOpen className="w-12 h-12 text-accent absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-text-primary">No Playbook Yet</h2>
            <p className="text-sm text-text-secondary max-w-md mx-auto">
              Generate a customer engagement playbook to see strategic position, key relationships,
              product alignment, and action items in one place.
            </p>
          </div>

          <button
            onClick={handleGenerate}
            disabled={generating}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent font-medium hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating Playbook...
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Generate Playbook
              </>
            )}
          </button>

          {error && (
            <p className="text-sm text-critical">{error}</p>
          )}
        </div>
      </div>
    )
  }

  // Error state
  if (error && !playbook) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="bg-surface border border-red-500/50 rounded-xl p-6 space-y-3">
          <p className="text-sm font-medium text-red-400">Error loading playbook</p>
          <p className="text-xs text-text-secondary">{error}</p>
          <button
            onClick={fetchPlaybook}
            className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // ── Main render: tier-ordered sections ──────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Header actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Customer Engagement Playbook</h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              if (!confirm('Regenerate playbook from current data? This will refresh all sections.')) return
              try {
                setGenerating(true)
                const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/playbook/generate`, { method: 'POST' })
                if (!res.ok) throw new Error(await res.text())
                const data = await res.json()
                setPlaybook(data)
              } catch (e: any) {
                console.error('Regenerate failed:', e)
              } finally {
                setGenerating(false)
              }
            }}
            disabled={generating}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs text-text-secondary hover:border-accent/50 hover:text-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
            Regenerate
          </button>
          <button
            onClick={() => setIngestModalOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs text-text-secondary hover:border-accent/50 hover:text-accent transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            Ingest Notes
          </button>
          <button
            onClick={async () => {
              try {
                setGenerating(true)
                const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/playbook/publish`, { method: 'POST' })
                if (!res.ok) throw new Error(await res.text())
                const data = await res.json()
                if (data.docUrl) window.open(data.docUrl, '_blank')
              } catch (e: any) {
                console.error('Publish failed:', e)
              } finally {
                setGenerating(false)
              }
            }}
            disabled={generating || !playbook}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs text-text-secondary hover:border-accent/50 hover:text-accent transition-colors disabled:opacity-50"
          >
            <FileText className="w-3.5 h-3.5" />
            Publish to Drive
          </button>
        </div>
      </div>

      {/* Quality scorecard */}
      {playbook?.qualityScorecard && (
        <details className="bg-surface border border-border rounded-xl overflow-hidden">
          <summary className="px-5 py-3 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary">Quality Scorecard</span>
            <ChevronDown className="w-4 h-4 text-text-secondary" />
          </summary>
          <div className="px-5 py-4 border-t border-border/60 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-text-secondary">Overall Score:</span>
              <span className={`font-semibold ${playbook.qualityScorecard.passed ? 'text-success' : 'text-warning'}`}>
                {playbook.qualityScorecard.score}%
              </span>
            </div>
            <div className="space-y-1 mt-3">
              {playbook.qualityScorecard.checks.map((check: any, i: number) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className={check.passed ? 'text-success' : 'text-critical'}>
                    {check.passed ? '✓' : '✗'}
                  </span>
                  <span className="text-text-secondary">{check.criterion}</span>
                </div>
              ))}
            </div>
          </div>
        </details>
      )}

      {/* All sections — rendered in tier order from PLAYBOOK_SECTION_TIERS */}
      {playbook && (
        <>
          {/* Tier separator labels */}
          {PLAYBOOK_SECTION_TIERS.map((entry, idx) => {
            const { key, tier, title } = entry
            const isExpanded = expandedSections.has(key)
            const isTier1 = tier === 1

            // Skip deterministic sections that have no data
            if (!sectionHasData(key)) return null

            // Render tier divider before the first section of Tier 2 and Tier 3
            const prevTier = idx > 0 ? PLAYBOOK_SECTION_TIERS[idx - 1].tier : tier
            const showDivider = tier !== prevTier

            return (
              <div key={key}>
                {showDivider && (
                  <div className="flex items-center gap-3 pt-2">
                    <div className="h-px flex-1 bg-border/50" />
                    <span className="text-xs text-text-secondary uppercase tracking-wider font-medium">
                      {tier === 2 ? 'Strategic Detail' : 'Reference'}
                    </span>
                    <div className="h-px flex-1 bg-border/50" />
                  </div>
                )}
                <div className="bg-surface border border-border rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleSection(key)}
                    className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
                  >
                    <div className="flex items-center gap-3">
                      {!isTier1 && !isExpanded && (
                        <ChevronRight className="w-4 h-4 text-text-secondary shrink-0" />
                      )}
                      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
                      {renderHeaderExtra(key)}
                    </div>
                    {(isTier1 || isExpanded) && (
                      isExpanded ? (
                        <ChevronUp className="w-5 h-5 text-text-secondary" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-text-secondary" />
                      )
                    )}
                  </button>
                  {isExpanded && (
                    <div className="px-5 py-4 border-t border-border/60">
                      {renderSectionContent(key)}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}

      {/* Ingest Notes Modal */}
      <IngestNotesModal
        isOpen={ingestModalOpen}
        onClose={() => setIngestModalOpen(false)}
        onIngest={handleIngestNotes}
      />

      {/* Last updated footer */}
      {playbook && (
        <div className="text-center text-xs text-text-secondary pt-4">
          Last updated {new Date(playbook.generatedAt).toLocaleString()}
        </div>
      )}
    </div>
  )
}
