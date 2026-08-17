import { useState, useRef, KeyboardEvent } from 'react'
import { Loader2, ChevronDown, ChevronUp, MessageSquare } from 'lucide-react'
import { useCustomerQuery } from '../hooks/useCustomerQuery'
import { renderMarkdown } from '../lib/render-markdown'

// ── Confidence badge ──────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const styles: Record<string, string> = {
    HIGH:   'bg-green-500/15 text-green-400 border-green-500/30',
    MEDIUM: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    LOW:    'bg-red-500/15  text-red-400   border-red-500/30',
  }
  const cls = styles[confidence] ?? styles.LOW
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}>
      {confidence}
    </span>
  )
}

// ── Source badge (plain text — no link, url is empty) ─────────────────────────

function SourceBadge({ title }: { title: string }) {
  return (
    <span className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border border-border/60 bg-bg text-text-secondary">
      <span className="truncate max-w-[160px]">{title}</span>
    </span>
  )
}

// ── Main exported component ─────────────────────────────────────────────────

export function CustomerQueryPanel({ customerName }: { customerName: string }) {
  const { ask, loading, result, error, history, clearHistory } = useCustomerQuery(customerName)
  const [question, setQuestion] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleAsk() {
    if (!question.trim() || loading) return
    ask(question)
    setQuestion('')
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAsk()
  }

  const pastEntries = result ? history.slice(1, 4) : history.slice(0, 3)

  return (
    <div className="bg-[#161b22] border border-border rounded-xl overflow-hidden">
      {/* Panel header */}
      <div className="px-5 py-3.5 border-b border-border/60 flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-[#00BCD4]" />
        <h2 className="text-base font-semibold text-text-primary">Customer Intelligence</h2>
        <span className="text-xs text-text-secondary">AI-powered Q&amp;A across all account data</span>
      </div>

      {/* Input area */}
      <div className="p-4 space-y-3">
        {/* Input row */}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={question}
            onChange={e => setQuestion(e.target.value.slice(0, 500))}
            onKeyDown={handleKey}
            disabled={loading}
            placeholder={`Ask anything about ${customerName}`}
            className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-[#00BCD4]/50 disabled:opacity-50 transition-colors"
          />
          <button
            onClick={handleAsk}
            disabled={loading || !question.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[#00BCD4]/10 text-[#00BCD4] border border-[#00BCD4]/30 hover:bg-[#00BCD4]/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            Ask
          </button>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-text-secondary py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>Searching customer data...</span>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* Current answer */}
        {result && !loading && (
          <div className="rounded-lg border border-border/60 bg-bg overflow-hidden">
            <div className="px-3 py-2.5 border-b border-border/40 flex items-center justify-between gap-2">
              <span className="text-xs text-text-secondary font-medium">Answer</span>
              <ConfidenceBadge confidence={result.confidence} />
            </div>
            <div className="px-3 py-3">
              <div className="text-sm text-text-primary leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown(result.answer) }} />
            </div>
            {result.sources.length > 0 && (
              <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                {result.sources.map((s, i) => (
                  <SourceBadge key={i} title={s.title} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* History (last 3 past Q&As, collapsible) */}
        {pastEntries.length > 0 && (
          <div>
            <button
              onClick={() => setHistoryOpen(v => !v)}
              className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              {historyOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {historyOpen ? 'Hide history' : `Show ${pastEntries.length} previous answer${pastEntries.length > 1 ? 's' : ''}`}
            </button>
            {historyOpen && (
              <div className="mt-2 space-y-2">
                {pastEntries.map((entry, i) => (
                  <div key={i} className="rounded-lg border border-border/40 bg-bg/60 overflow-hidden opacity-60">
                    <div className="px-3 py-1.5 border-b border-border/30 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-text-secondary italic truncate">{entry.question}</span>
                      <ConfidenceBadge confidence={entry.result.confidence} />
                    </div>
                    <div className="px-3 py-2">
                      <div className="text-xs text-text-secondary leading-relaxed line-clamp-3" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.result.answer) }} />
                    </div>
                    {entry.result.sources.length > 0 && (
                      <div className="px-3 pb-2 flex flex-wrap gap-1">
                        {entry.result.sources.slice(0, 3).map((s, si) => (
                          <SourceBadge key={si} title={s.title} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Clear history */}
        {history.length > 0 && (
          <div className="flex justify-end">
            <button
              onClick={clearHistory}
              className="text-[10px] text-text-secondary hover:text-text-primary transition-colors"
            >
              Clear history
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
