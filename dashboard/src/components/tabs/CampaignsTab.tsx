/**
 * GitHub Issue #146: Campaigns tab shell component
 * Feature: Account-level email campaign management
 * Status: Phase 1 — shell only, no backend integration
 */

import { Mail, Plus } from 'lucide-react'

interface CampaignsTabProps {
  customerName: string
}

export function CampaignsTab({ customerName }: CampaignsTabProps) {
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

      {/* Action button (disabled) */}
      <div>
        <button
          disabled
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium opacity-50 cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
          Create Campaign
        </button>
      </div>

      {/* Empty state */}
      <div className="bg-surface border border-border rounded-xl p-12 text-center space-y-3">
        <Mail className="w-12 h-12 text-text-secondary mx-auto opacity-40" />
        <p className="text-base font-medium text-text-primary">No campaigns yet</p>
        <p className="text-sm text-text-secondary max-w-md mx-auto">
          Create your first campaign to generate targeted emails for specific roles at {customerName}. Campaigns draw from product intel, competitive signals, and your documented outreach style.
        </p>
      </div>
    </div>
  )
}
