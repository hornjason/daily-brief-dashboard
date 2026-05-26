/**
 * GitHub Issue #152: Campaigns tab UI implementation
 * Feature: Account-level email campaign creation and history
 * Status: Phase 2 — working form + history list
 */

import { useState, useEffect } from 'react'
import { Mail, ExternalLink, RefreshCw } from 'lucide-react'
import { formatRelTime } from '../../lib/format'
import { CampaignConfigurator, CampaignConfig } from '../CampaignConfigurator'

interface CampaignsTabProps {
  customerName: string
}

interface Campaign {
  id: string
  materialTitle: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
}

interface CampaignsResponse {
  campaigns?: Campaign[]
}

export function CampaignsTab({ customerName }: CampaignsTabProps) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch campaigns on mount
  useEffect(() => {
    fetch(`/api/customer/${encodeURIComponent(customerName)}/campaigns`)
      .then(r => r.json())
      .then((data: CampaignsResponse) => setCampaigns(data.campaigns || []))
      .catch(() => {})
  }, [customerName])

  async function handleGenerate(config: CampaignConfig) {
    setGenerating(true)
    setError(null)

    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/campaigns/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialUrl: config.materialUrl,
          personas: config.personas.filter(p => p.enabled),
          style: config.style,
          valueProps: config.valueProps,
        }),
      })

      // BKL-TEST-07: Check res.ok before treating as success
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Generation failed' }))
        setError(err.error || 'Generation failed')
        return
      }

      const data = await res.json()

      // Add new campaign to list
      setCampaigns(prev => [
        {
          id: data.campaignId,
          materialTitle: config.materialTitle || 'Campaign',
          generatedAt: data.generatedAt,
          driveUrl: data.driveUrl,
          htmlUrl: data.htmlUrl,
        },
        ...prev,
      ])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const hasCampaigns = campaigns.length > 0

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Mail className="w-5 h-5 text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Campaigns</h1>
        </div>
        <p className="text-sm text-text-secondary">
          Create and manage targeted email campaigns for {customerName}. Each campaign draws from your customer intelligence, product positioning, and AE style guide to generate role-specific outreach emails.
        </p>
      </div>

      {/* Create Campaign Form */}
      {generating ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-accent mx-auto animate-spin" />
          <p className="text-sm text-text-secondary">Generating campaign...</p>
        </div>
      ) : (
        <CampaignConfigurator customerName={customerName} onConfirm={handleGenerate} />
      )}

      {/* Campaign History */}
      {hasCampaigns ? (
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-text-primary">Campaign History</h2>
          <div className="space-y-2">
            {campaigns.map(campaign => (
              <a
                key={campaign.id}
                href={`/api/customer/${encodeURIComponent(customerName)}/campaigns/${campaign.id}/preview`}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-2 hover:border-accent/30 hover:bg-zinc-900/70 transition-colors cursor-pointer group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                      {campaign.materialTitle || 'Untitled Campaign'}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Generated {formatRelTime(campaign.generatedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <a
                      href={campaign.driveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Drive
                    </a>
                    <button
                      onClick={async (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/campaigns/${campaign.id}`, { method: 'DELETE' })
                        if (res.ok) {
                          setCampaigns(prev => prev.filter(c => c.id !== campaign.id))
                        }
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl p-12 text-center space-y-3">
          <Mail className="w-12 h-12 text-text-secondary mx-auto opacity-40" />
          <p className="text-base font-medium text-text-primary">No campaigns yet</p>
          <p className="text-sm text-text-secondary max-w-md mx-auto">
            Create your first campaign to generate targeted emails for specific roles at {customerName}. Campaigns draw from product intel, competitive signals, and your documented outreach style.
          </p>
        </div>
      )}
    </div>
  )
}
