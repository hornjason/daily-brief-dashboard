/**
 * BKL-UX52 Phase 4: Pod-level KPI header shown below the tab bar.
 * Example: "Southwest Pod: 105 customers - 14 open cases - $28.1M pipeline - 7 renewals expiring"
 */
import type { AccountInfo, SupportCase } from '../types'

interface PodKPIHeaderProps {
  podName: string
  accounts: AccountInfo[]
  cases: SupportCase[]
}

function formatAcv(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value}`
}

export function PodKPIHeader({ podName, accounts, cases }: PodKPIHeaderProps) {
  // Count open cases matching this pod's customers
  const accountNumSet = new Set<string>()
  for (const acct of accounts) {
    for (const num of acct.accountNumbers) {
      accountNumSet.add(String(num))
    }
  }
  const openCases = cases.filter(c => accountNumSet.has(String(c.accountNumber)))

  // Count renewals expiring within 90 days
  const now = new Date()
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
  let renewalCount = 0
  let totalPipelineAcv = 0
  for (const acct of accounts) {
    for (const p of acct.products ?? []) {
      if (p.status?.toLowerCase() === 'active' && p.endDate) {
        const end = new Date(p.endDate)
        if (end >= now && end <= in90) renewalCount++
      }
    }
    // Extract pipeline from attention reasons
    for (const reason of acct.attentionReasons ?? []) {
      const match = reason.match(/Pipeline \$(\d+)K/)
      if (match) totalPipelineAcv += Number(match[1]) * 1000
    }
  }

  return (
    <div className="flex items-center gap-2 px-6 py-2 text-sm text-text-secondary bg-surface/50 border-b border-border">
      <span className="font-medium text-text-primary">{podName} Pod:</span>
      <span>{accounts.length} customer{accounts.length !== 1 ? 's' : ''}</span>
      <span className="text-zinc-600">·</span>
      <span>{openCases.length} open case{openCases.length !== 1 ? 's' : ''}</span>
      {totalPipelineAcv > 0 && (
        <>
          <span className="text-zinc-600">·</span>
          <span>{formatAcv(totalPipelineAcv)} pipeline</span>
        </>
      )}
      {renewalCount > 0 && (
        <>
          <span className="text-zinc-600">·</span>
          <span>{renewalCount} renewal{renewalCount !== 1 ? 's' : ''} expiring</span>
        </>
      )}
    </div>
  )
}
