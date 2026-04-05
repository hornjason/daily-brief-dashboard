import { useState, useRef, KeyboardEvent } from 'react'
import { Loader2, ExternalLink, ChevronDown, ChevronUp, MessageSquare } from 'lucide-react'
import { useProductQuery } from '../hooks/useProductQuery'

// ── Types ─────────────────────────────────────────────────────────────────────

type ProductKey = 'rhel' | 'ocp' | 'aap'

interface Tab {
  key: ProductKey
  label: string
  emptyHint: string
}

const TABS: Tab[] = [
  {
    key:       'rhel',
    label:     'RHEL',
    emptyHint: 'Ask anything about Red Hat Enterprise Linux — documentation, version support, architecture',
  },
  {
    key:       'ocp',
    label:     'OpenShift',
    emptyHint: 'Ask anything about OpenShift Container Platform — operators, upgrades, networking, storage',
  },
  {
    key:       'aap',
    label:     'Ansible',
    emptyHint: 'Ask anything about Ansible Automation Platform — playbooks, EDA, content collections',
  },
]

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

// ── Source chip ───────────────────────────────────────────────────────────────

function SourceChip({ title, url }: { title: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-border/60 bg-bg text-text-secondary hover:text-[#00BCD4] hover:border-[#00BCD4]/40 transition-colors"
    >
      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
      <span className="truncate max-w-[160px]">{title}</span>
    </a>
  )
}

// ── Single-product panel (inner) ──────────────────────────────────────────────

function ProductPanel({ tab, customerName }: { tab: Tab; customerName?: string }) {
  const { ask, loading, result, error, history, clearHistory } = useProductQuery(tab.key, customerName)
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
    <div className="space-y-3">
      {/* Input row */}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={question}
          onChange={e => setQuestion(e.target.value.slice(0, 500))}
          onKeyDown={handleKey}
          disabled={loading}
          placeholder={tab.emptyHint}
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
          <span>Querying Red Hat knowledge base...</span>
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
            <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{result.answer}</p>
          </div>
          {result.sources.length > 0 && (
            <div className="px-3 pb-3 flex flex-wrap gap-1.5">
              {result.sources.map((s, i) => (
                <SourceChip key={i} title={s.title} url={s.url} />
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
                    <p className="text-xs text-text-secondary leading-relaxed line-clamp-3">{entry.result.answer}</p>
                  </div>
                  {entry.result.sources.length > 0 && (
                    <div className="px-3 pb-2 flex flex-wrap gap-1">
                      {entry.result.sources.slice(0, 3).map((s, si) => (
                        <SourceChip key={si} title={s.title} url={s.url} />
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
  )
}

// ── Main exported component ───────────────────────────────────────────────────

export function ProductQueryPanel({ customerName }: { customerName?: string }) {
  const [activeTab, setActiveTab] = useState<ProductKey>('rhel')
  const currentTab = TABS.find(t => t.key === activeTab) ?? TABS[0]

  return (
    <div className="bg-[#161b22] border border-border rounded-xl overflow-hidden">
      {/* Panel header */}
      <div className="px-5 py-3.5 border-b border-border/60 flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-[#00BCD4]" />
        <h2 className="text-base font-semibold text-text-primary">Product Q&amp;A</h2>
        <span className="text-xs text-text-secondary">Grounded AI — Red Hat knowledge base</span>
      </div>

      {/* Product tabs */}
      <div className="flex border-b border-border/40">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === tab.key
                ? 'text-[#00BCD4]'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#00BCD4] rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Active panel */}
      <div className="p-4">
        <ProductPanel key={activeTab} tab={currentTab} customerName={customerName} />
      </div>
    </div>
  )
}
