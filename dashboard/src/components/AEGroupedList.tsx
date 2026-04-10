/**
 * BKL-UX52: AE-grouped customer list with collapsible sections.
 *
 * Each AE section shows:
 *   - Collapsible header: AE name + customer count pill + aggregate KPI mini-bar
 *   - Customer rows sorted by attentionScore DESC within each group
 *   - AE groups sorted by max attentionScore of any member
 */
import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AccountInfo, SupportCase, CalendarEvent } from '../types'
import HealthDot from './HealthDot'

interface AEGroupedListProps {
  accounts: AccountInfo[]
  cases: SupportCase[]
  events: CalendarEvent[]
  loading: boolean
  onCustomerClick?: (name: string) => void
}

interface AEGroup {
  aeName: string
  customers: AccountInfo[]
  maxScore: number
  totalCases: number
  totalPipelineAcv: number
  renewalCount: number
}

function formatAcv(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value}`
}

function getAttentionDotColor(score: number): string {
  if (score >= 70) return 'bg-red-500'
  if (score >= 40) return 'bg-amber-500'
  if (score > 0) return 'bg-green-500'
  return 'bg-zinc-600'
}

function getAttentionLabel(score: number): string {
  if (score >= 70) return 'Needs Attention'
  if (score >= 40) return 'Monitor'
  if (score > 0) return 'Healthy'
  return 'No data'
}

export function AEGroupedList({ accounts, cases, events, loading, onCustomerClick }: AEGroupedListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const toggleGroup = (aeName: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(aeName)) next.delete(aeName)
      else next.add(aeName)
      return next
    })
  }

  // Build case index by account number
  const casesByAccount = useMemo(() => {
    const map = new Map<string, SupportCase[]>()
    for (const c of cases) {
      const key = String(c.accountNumber)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(c)
    }
    return map
  }, [cases])

  const aeGroups = useMemo<AEGroup[]>(() => {
    const groupMap = new Map<string, AccountInfo[]>()
    for (const acct of accounts) {
      const ae = acct.ae || 'Unassigned'
      if (!groupMap.has(ae)) groupMap.set(ae, [])
      groupMap.get(ae)!.push(acct)
    }

    const groups: AEGroup[] = []
    for (const [aeName, custs] of groupMap) {
      // Sort customers by attentionScore DESC, then name ASC
      custs.sort((a, b) => {
        const scoreDiff = (b.attentionScore ?? 0) - (a.attentionScore ?? 0)
        if (scoreDiff !== 0) return scoreDiff
        return a.name.localeCompare(b.name)
      })

      const maxScore = custs.reduce((max, c) => Math.max(max, c.attentionScore ?? 0), 0)

      // Aggregate KPIs
      let totalCases = 0
      let renewalCount = 0
      for (const cust of custs) {
        for (const num of cust.accountNumbers) {
          const custCases = casesByAccount.get(String(num))
          if (custCases) totalCases += custCases.length
        }
        // Count renewals expiring within 90 days from subscription data
        const now = new Date()
        const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
        for (const p of cust.products ?? []) {
          if (p.status?.toLowerCase() === 'active' && p.endDate) {
            const end = new Date(p.endDate)
            if (end >= now && end <= in90) renewalCount++
          }
        }
      }

      // Pipeline ACV — approximate from attention reasons
      let totalPipelineAcv = 0
      for (const cust of custs) {
        for (const reason of cust.attentionReasons ?? []) {
          const match = reason.match(/Pipeline \$(\d+)K/)
          if (match) totalPipelineAcv += Number(match[1]) * 1000
        }
      }

      groups.push({ aeName, customers: custs, maxScore, totalCases, totalPipelineAcv, renewalCount })
    }

    // Sort groups by max attention score DESC
    groups.sort((a, b) => b.maxScore - a.maxScore)
    return groups
  }, [accounts, casesByAccount])

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-16 bg-surface rounded-lg" />
        ))}
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <p className="text-sm text-text-secondary">No customers found for this pod</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {aeGroups.map(group => {
        const isCollapsed = collapsedGroups.has(group.aeName)
        return (
          <div key={group.aeName} className="border border-border rounded-lg overflow-hidden">
            {/* AE Header — collapsible */}
            <button
              onClick={() => toggleGroup(group.aeName)}
              className="w-full flex items-center gap-3 px-4 py-3 bg-surface hover:bg-surface-hover transition-colors text-left"
            >
              {isCollapsed ? (
                <ChevronRight className="w-4 h-4 text-text-secondary shrink-0" />
              ) : (
                <ChevronDown className="w-4 h-4 text-text-secondary shrink-0" />
              )}
              <span className="font-medium text-text-primary">{group.aeName}</span>
              <span className="text-xs bg-zinc-700 text-zinc-300 px-2 py-0.5 rounded-full">
                {group.customers.length}
              </span>
              <div className="flex-1" />
              <div className="flex items-center gap-4 text-xs text-text-secondary">
                {group.totalCases > 0 && (
                  <span>{group.totalCases} case{group.totalCases !== 1 ? 's' : ''}</span>
                )}
                {group.totalPipelineAcv > 0 && (
                  <span>{formatAcv(group.totalPipelineAcv)} pipeline</span>
                )}
                {group.renewalCount > 0 && (
                  <span>{group.renewalCount} renewal{group.renewalCount !== 1 ? 's' : ''}</span>
                )}
              </div>
            </button>

            {/* Customer Rows */}
            {!isCollapsed && (
              <div className="divide-y divide-border">
                {group.customers.map(customer => {
                  const score = customer.attentionScore ?? 0
                  const reasons = customer.attentionReasons ?? []
                  return (
                    <div
                      key={customer.name}
                      onClick={() => onCustomerClick?.(customer.name)}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover transition-colors cursor-pointer h-12"
                    >
                      {/* Attention dot */}
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${getAttentionDotColor(score)}`}
                        title={`${getAttentionLabel(score)} (score: ${score})`}
                      />
                      {/* Customer name */}
                      <span className="text-sm text-text-primary truncate max-w-[200px]">
                        {customer.name}
                      </span>
                      {/* Reason chips */}
                      <div className="flex-1 flex items-center gap-2 overflow-hidden">
                        {reasons.slice(0, 3).map((reason, i) => (
                          <span
                            key={i}
                            className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 whitespace-nowrap"
                          >
                            {reason}
                          </span>
                        ))}
                      </div>
                      {/* Brief age */}
                      {customer.cachedAt && (
                        <span className="text-[11px] text-text-secondary shrink-0">
                          Brief: {formatBriefAge(customer.cachedAt)}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatBriefAge(cachedAt: string): string {
  const diff = Date.now() - new Date(cachedAt).getTime()
  const hours = Math.floor(diff / (60 * 60 * 1000))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
