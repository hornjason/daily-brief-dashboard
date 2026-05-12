/**
 * GitHub Issue #152: Campaigns tab UI implementation
 * Feature: Account-level email campaign creation and history
 * Status: Phase 2 — working form + history list
 */

import { useState, useEffect } from 'react'
import { Mail, AlertCircle, ExternalLink, RefreshCw } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

interface CampaignsTabProps {
  customerName: string
}

interface Campaign {
  id: string
  materialTitle: string
  generatedAt: string
  driveUrl: string
}

interface CampaignsResponse {
  campaigns?: Campaign[]
}

export function CampaignsTab({ customerName }: CampaignsTabProps) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [materialUrl, setMaterialUrl] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch campaigns on mount
  useEffect(() => {
    fetch(`/api/customer/${encodeURIComponent(customerName)}/campaigns`)
      .then(r => r.json())
      .then((data: CampaignsResponse) => setCampaigns(data.campaigns || []))
      .catch(() => {})
  }, [customerName])

  async function handleGenerate() {
    // Validate material URL format
    if (!materialUrl.match(/docs\.google\.com\/(document|presentation)\/d\//)) {
      setError('Please enter a valid Google Doc or Slides URL')
      return
    }

    setGenerating(true)
    setError(null)

    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/campaigns/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materialUrl }),
      })

      // BKL-TEST-07: Check res.ok before treating as success
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Generation failed' }))
        setError(err.error || 'Generation failed')
        setGenerating(false)
        return
      }

      const data = await res.json()

      // Add new campaign to list
      setCampaigns(prev => [
        {
          id: data.campaignId,
          materialTitle: data.materialTitle || 'Campaign',
          generatedAt: data.generatedAt,
          driveUrl: data.driveUrl,
        },
        ...prev,
      ])
      setMaterialUrl('')
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
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-text-primary">Create Campaign</h2>

        <div className="space-y-2">
          <label htmlFor="materialUrl" className="block text-sm font-medium text-zinc-400">
            Material URL
          </label>
          <input
            id="materialUrl"
            type="text"
            value={materialUrl}
            onChange={e => setMaterialUrl(e.target.value)}
            disabled={generating}
            placeholder="https://docs.google.com/document/d/..."
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-text-primary placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-50"
          />
          <p className="text-xs text-zinc-500">Google Doc or Slides link</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs text-warning">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={generating || !materialUrl.trim()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {generating && <RefreshCw className="w-4 h-4 animate-spin" />}
          {generating ? 'Generating Campaign...' : 'Generate Campaign'}
        </button>
      </div>

      {/* Campaign History */}
      {hasCampaigns ? (
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-text-primary">Campaign History</h2>
          <div className="space-y-2">
            {campaigns.map(campaign => (
              <div
                key={campaign.id}
                className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {campaign.materialTitle}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {formatRelTime(campaign.generatedAt)}
                    </p>
                  </div>
                  <a
                    href={campaign.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open in Drive
                  </a>
                </div>
              </div>
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
