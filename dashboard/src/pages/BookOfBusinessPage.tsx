/**
 * BookOfBusinessPage — Route: /dashboard/book-of-business
 * GitHub Issue #239
 *
 * Extracted from the monolithic Dashboard component in App.tsx.
 * Displays: PipelineSection (per-stage breakdown) + CloudSpendSection (per-product breakdown).
 * Fetches its own pipeline and CCSP data via useApi.
 */
import { useState, useCallback } from 'react'
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
  const pipelineQueryStr = aeFilterSelected && aeFilterSelected !== 'all' ? `?ae=${encodeURIComponent(aeFilterSelected)}&_=${refreshKey}` : `?_=${refreshKey}`
  const pipelineApi = useApi<PipelineSummary>(`/api/pipeline${pipelineQueryStr}`)
  const ccspQueryStr = (() => {
    const params = new URLSearchParams()
    if (aeFilterSelected !== 'all') params.set('ae', aeFilterSelected)
    if (productFilterSelected.length > 0) params.set('products', productFilterSelected.map(encodeURIComponent).join(','))
    params.set('_', String(refreshKey))
    const s = params.toString()
    return s ? `?${s}` : ''
  })()
  const ccspApi = useApi<CCSPSummary>(`/api/ccsp${ccspQueryStr}`)

  // Section-specific refresh handlers that call the correct server API
  const [pipelineRefreshing, setPipelineRefreshing] = useState(false)
  const [ccspRefreshing, setCcspRefreshing] = useState(false)

  const handleRefreshPipeline = useCallback(async () => {
    setPipelineRefreshing(true)
    try {
      await fetch('/api/refresh/pipeline', { method: 'POST' })
    } catch (err) {
      console.error('[BookOfBusiness] pipeline refresh failed', err)
    } finally {
      setPipelineRefreshing(false)
      onRefresh()
    }
  }, [onRefresh])

  const handleRefreshCcsp = useCallback(async () => {
    setCcspRefreshing(true)
    try {
      await fetch('/api/refresh/ccsp', { method: 'POST' })
    } catch (err) {
      console.error('[BookOfBusiness] ccsp refresh failed', err)
    } finally {
      setCcspRefreshing(false)
      onRefresh()
    }
  }, [onRefresh])

  return (
    <main className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Pipeline */}
      <section id="section-pipeline" data-section="section-pipeline">
        <PipelineSection
          data={pipelineApi.data}
          loading={pipelineApi.loading || pipelineRefreshing}
          error={pipelineApi.error}
          onRefresh={handleRefreshPipeline}
          selectedProducts={productFilterSelected}
        />
      </section>

      {/* Cloud Spend */}
      {filteredAccounts.length > 0 && (ccspApi.data || ccspApi.loading || ccspApi.error) && (
        <section id="section-cloudspend" data-section="section-cloudspend">
          <CloudSpendSection
            data={ccspApi.data}
            loading={ccspApi.loading || ccspRefreshing}
            error={ccspApi.error}
            onRefresh={handleRefreshCcsp}
          />
        </section>
      )}
    </main>
  )
}
