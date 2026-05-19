/**
 * GitHub Issue #296: PlaybookTab component
 *
 * Displays all 8 customer engagement playbook sections:
 * 1. Strategic Position
 * 2. Key Relationships
 * 3. Current Priorities
 * 4. Product Alignment (with dashboard links)
 * 5. Open Action Items (with checkboxes)
 * 6. Engagement History
 * 7. Expansion Opportunities
 * 8. Renewals and Risk
 *
 * Features:
 * - Generate Playbook button when no playbook exists
 * - Ingest Notes modal for Google Doc URL input
 * - Publish to Drive button (disabled — endpoint in #297)
 * - Quality scorecard as expandable details
 * - Product names link to /dashboard/products/:slug
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
  CheckCircle,
  Circle,
  ExternalLink,
  X
} from 'lucide-react'
import type { PlaybookState, ActionItem, ProductAlignmentEntry } from '../../../../src/playbook-types'

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
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['strategicPosition']))

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
        return <strong key={i} className="text-text-primary font-semibold">{part.slice(2, -2)}</strong>
      }
      return <span key={i}>{part}</span>
    })
  }

  // Render section content with markdown support (bullets, tables, headers, bold)
  const renderSection = (title: string, content: string) => {
    const lines = content.split('\n')

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

  // Playbook exists — render all sections
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

      {/* All sections — only render when playbook exists */}
      {playbook && (
        <>
      {/* Section 1: Strategic Position */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('strategicPosition')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <h2 className="text-lg font-semibold text-text-primary">Strategic Position</h2>
          {expandedSections.has('strategicPosition') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('strategicPosition') && (
          <div className="px-5 py-4 border-t border-border/60">
            {renderSection('Strategic Position', playbook.sections.strategicPosition.content || '')}
          </div>
        )}
      </div>

      {/* Section 2: Key Relationships */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('keyRelationships')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <h2 className="text-lg font-semibold text-text-primary">Key Relationships</h2>
          {expandedSections.has('keyRelationships') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('keyRelationships') && (
          <div className="px-5 py-4 border-t border-border/60">
            {renderSection('Key Relationships', playbook.sections.keyRelationships.content || '')}
          </div>
        )}
      </div>

      {/* Section 3: Current Priorities */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('currentPriorities')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <h2 className="text-lg font-semibold text-text-primary">Current Priorities</h2>
          {expandedSections.has('currentPriorities') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('currentPriorities') && (
          <div className="px-5 py-4 border-t border-border/60">
            {renderSection('Current Priorities', playbook.sections.currentPriorities.content || '')}
          </div>
        )}
      </div>

      {/* Section 4: Product Alignment */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('productAlignment')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <h2 className="text-lg font-semibold text-text-primary">Product Alignment</h2>
          {expandedSections.has('productAlignment') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('productAlignment') && (
          <div className="px-5 py-4 border-t border-border/60 space-y-4">
            {playbook.sections.productAlignment.products.length === 0 ? (
              <p className="text-sm text-text-secondary italic">No products aligned yet</p>
            ) : (
              playbook.sections.productAlignment.products.map((product: ProductAlignmentEntry) => (
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
                        <div className="text-text-secondary mt-1 prose prose-sm max-w-none">
                          {product.proofPoints.split('\n').map((line: string, i: number) => (
                            line.trim() && <p key={i} className="mb-1">{line}</p>
                          ))}
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
              ))
            )}
          </div>
        )}
      </div>

      {/* Section 5: Open Action Items */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('openActionItems')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-text-primary">Open Action Items</h2>
            <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">
              {playbook.sections.openActionItems.items.filter(i => i.status === 'open').length} open
            </span>
          </div>
          {expandedSections.has('openActionItems') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('openActionItems') && (
          <div className="px-5 py-4 border-t border-border/60 space-y-2">
            {playbook.sections.openActionItems.items.length === 0 ? (
              <p className="text-sm text-text-secondary italic">No action items yet</p>
            ) : (
              playbook.sections.openActionItems.items.map((item: ActionItem) => (
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
              ))
            )}
          </div>
        )}
      </div>

      {/* Section 6: Engagement History */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('engagementHistory')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <h2 className="text-lg font-semibold text-text-primary">Engagement History</h2>
          {expandedSections.has('engagementHistory') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('engagementHistory') && (
          <div className="px-5 py-4 border-t border-border/60 space-y-3">
            {playbook.sections.engagementHistory.entries.length === 0 ? (
              <p className="text-sm text-text-secondary italic">No engagement history yet</p>
            ) : (
              playbook.sections.engagementHistory.entries.map((entry: any, i: number) => (
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
              ))
            )}
          </div>
        )}
      </div>

      {/* Section 7: Expansion Opportunities */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('expansionOpportunities')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <h2 className="text-lg font-semibold text-text-primary">Expansion Opportunities</h2>
          {expandedSections.has('expansionOpportunities') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('expansionOpportunities') && (
          <div className="px-5 py-4 border-t border-border/60">
            {renderSection('Expansion Opportunities', playbook.sections.expansionOpportunities.content || '')}
          </div>
        )}
      </div>

      {/* Section 8: Renewals and Risk */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('renewalsAndRisk')}
          className="w-full px-5 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between text-left"
        >
          <h2 className="text-lg font-semibold text-text-primary">Renewals and Risk</h2>
          {expandedSections.has('renewalsAndRisk') ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        {expandedSections.has('renewalsAndRisk') && (
          <div className="px-5 py-4 border-t border-border/60">
            {renderSection('Renewals and Risk', playbook.sections.renewalsAndRisk.content || '')}
          </div>
        )}
      </div>

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
