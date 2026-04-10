import { useState } from 'react'
import type { SupportCase } from '../types'
import { SupportCasesTable } from './SupportCasesTable'
import Modal from './Modal'
import { AlertTriangle } from 'lucide-react'

interface KPISev1ModalProps {
  open: boolean
  onClose: () => void
  cases: SupportCase[]
  /** BKL-PVIEW-10: Product filter cascade */
  selectedProducts?: string[]
  caseMatchesProducts?: (caseProduct: string | string[], selectedLabels: string[]) => boolean
}

export default function KPISev1Modal({ open, onClose, cases, selectedProducts, caseMatchesProducts }: KPISev1ModalProps) {
  const [viewMode, setViewMode] = useState<'all' | 'byAe'>('all')
  const [showNonMatching, setShowNonMatching] = useState(false)

  const sev1Cases = cases.filter((c) => String(c.severity) === '1')

  const isFiltered = (selectedProducts?.length ?? 0) > 0 && !!caseMatchesProducts
  const matchingSev1 = isFiltered
    ? sev1Cases.filter(c => caseMatchesProducts!(c.product ?? '', selectedProducts!))
    : sev1Cases
  const nonMatchingSev1 = isFiltered
    ? sev1Cases.filter(c => !caseMatchesProducts!(c.product ?? '', selectedProducts!))
    : []

  const displayCases = isFiltered
    ? (showNonMatching ? [...matchingSev1, ...nonMatchingSev1] : matchingSev1)
    : sev1Cases

  const casesByAe = (() => {
    const map = new Map<string, SupportCase[]>()
    for (const c of displayCases) {
      const ae = c.customerName ?? 'Unknown'
      const list = map.get(ae) ?? []
      list.push(c)
      map.set(ae, list)
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length)
  })()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Severity 1 Cases"
      icon={AlertTriangle}
      subtitle={isFiltered ? `${matchingSev1.length} matching · ${sev1Cases.length} total` : `${sev1Cases.length} open`}
      maxWidth="max-w-4xl"
    >
      <div className="overflow-y-auto max-h-[70vh] -m-5">
        <div className="px-5 pt-3 pb-2 flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
            <button
              onClick={() => setViewMode('all')}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                viewMode === 'all' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setViewMode('byAe')}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                viewMode === 'byAe' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              By Customer
            </button>
          </div>
        </div>

        {viewMode === 'all' ? (
          <SupportCasesTable cases={displayCases} loading={false} />
        ) : (
          <div className="divide-y divide-border/50">
            {casesByAe.map(([name, groupCases]) => (
              <div key={name} className="px-5 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-semibold text-text-primary">{name}</span>
                  <span className="text-xs bg-critical/20 text-critical px-1.5 py-0.5 rounded-full tabular-nums">
                    {groupCases.length}
                  </span>
                </div>
                <SupportCasesTable cases={groupCases} loading={false} />
              </div>
            ))}
          </div>
        )}

        {/* BKL-PVIEW-10: Collapsed non-matching cases toggle */}
        {isFiltered && nonMatchingSev1.length > 0 && (
          <div className="px-5 py-3 border-t border-border/50">
            <button
              onClick={() => setShowNonMatching(v => !v)}
              className="text-xs text-text-secondary/70 hover:text-text-secondary transition-colors"
            >
              {showNonMatching ? `Hide ${nonMatchingSev1.length} other cases` : `Show ${nonMatchingSev1.length} more cases`}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
