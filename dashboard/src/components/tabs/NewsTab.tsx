/**
 * GitHub Issue #146: News tab shell component
 * Feature: Customer news radar with Gemini-scored significance
 * Status: Phase 1 — shell only, no backend integration
 */

import { Newspaper } from 'lucide-react'

interface NewsTabProps {
  customerName: string
}

export function NewsTab({ customerName }: NewsTabProps) {
  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Newspaper className="w-5 h-5 text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Customer News</h1>
        </div>
        <p className="text-sm text-text-secondary">
          Daily news articles about {customerName}, scored for significance. Articles with high scores (7+) also appear in your morning brief. Powered by Gemini grounded search.
        </p>
      </div>

      {/* Empty state with illustration */}
      <div className="bg-surface border border-border rounded-xl p-12 text-center space-y-4">
        <div className="relative mx-auto w-20 h-20">
          <div className="absolute inset-0 bg-accent/10 rounded-full" />
          <Newspaper className="w-12 h-12 text-accent absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
        </div>
        <div className="space-y-2">
          <p className="text-base font-medium text-text-primary">No news stories yet</p>
          <p className="text-sm text-text-secondary max-w-md mx-auto">
            News radar checks for stories about {customerName} daily. Significant events (product launches, leadership changes, competitive moves) will appear here with context and source links.
          </p>
        </div>
      </div>
    </div>
  )
}
