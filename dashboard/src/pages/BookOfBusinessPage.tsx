/**
 * BookOfBusinessPage — Route: /dashboard/book-of-business
 * GitHub Issue #239
 *
 * Extracted from the monolithic Dashboard component in App.tsx.
 * Displays: PipelineSection (per-stage breakdown) + CloudSpendSection (per-product breakdown).
 * Fetches its own pipeline and CCSP data via useApi.
 */
import { useApi } from '../hooks/useApi'
import { PipelineSection } from '../components/PipelineSection'
import { CloudSpendSection } from '../components/CloudSpendSection'
import type { PipelineSummary, CCSPSummary, AccountInfo } from '../types'

interface BookOfBusinessPageProps {
  refreshKey: number
  onRefresh: () => void
  aeFilterSelected: string
  productFilterSelected: string[]
  filteredAccounts: AccountInfo[]
}

export function BookOfBusinessPage({
  refreshKey,
  onRefresh,
  aeFilterSelected,
  productFilterSelected,
  filteredAccounts,
}: BookOfBusinessPageProps) {
  const pipelineQueryStr = aeFilterSelected && aeFilterSelected !== 'all' ? `?ae=${encodeURIComponent(aeFilterSelected)}` : ''
  const pipelineApi = useApi<PipelineSummary>(`/api/pipeline${pipelineQueryStr}`)
  const ccspQueryStr = (() => {
    const params = new URLSearchParams()
    if (aeFilterSelected !== 'all') params.set('ae', aeFilterSelected)
    if (productFilterSelected.length > 0) params.set('products', productFilterSelected.map(encodeURIComponent).join(','))
    const s = params.toString()
    return s ? `?${s}` : ''
  })()
  const ccspApi = useApi<CCSPSummary>(`/api/ccsp${ccspQueryStr}`)

  return (
    <main className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Pipeline */}
      <section id="section-pipeline" data-section="section-pipeline">
        <PipelineSection
          data={pipelineApi.data}
          loading={pipelineApi.loading}
          error={pipelineApi.error}
          onRefresh={onRefresh}
          selectedProducts={productFilterSelected}
        />
      </section>

      {/* Cloud Spend */}
      {filteredAccounts.length > 0 && (ccspApi.data || ccspApi.loading || ccspApi.error) && (
        <section id="section-cloudspend" data-section="section-cloudspend">
          <CloudSpendSection
            data={ccspApi.data}
            loading={ccspApi.loading}
            error={ccspApi.error}
            onRefresh={onRefresh}
          />
        </section>
      )}
    </main>
  )
}
