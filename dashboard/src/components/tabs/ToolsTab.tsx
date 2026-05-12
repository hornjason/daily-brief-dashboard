/**
 * GitHub Issue #146: Tools tab shell component
 * Feature: Smart launcher for Red Hat business value tools + artifact upload
 * Status: Phase 1 — shell only, no backend integration
 */

import { Wrench, ExternalLink, Upload } from 'lucide-react'

interface ToolsTabProps {
  customerName: string
}

export function ToolsTab({ customerName }: ToolsTabProps) {
  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Wrench className="w-5 h-5 text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Business Value Tools</h1>
        </div>
        <p className="text-sm text-text-secondary">
          Launch Red Hat business value tools with {customerName} pre-filled. Upload outputs to sync with Google Drive and NotebookLM.
        </p>
      </div>

      {/* Tool cards grid */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* PitchBuilder+ */}
        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary opacity-30" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">PitchBuilder+</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              Export sales-ready reports showcasing Red Hat's delivered value for {customerName}
            </p>
          </div>
          <button
            disabled
            className="w-full px-3 py-2 rounded-lg border border-border text-xs text-text-secondary opacity-50 cursor-not-allowed"
          >
            Launch Tool
          </button>
        </div>

        {/* FinListics CBV */}
        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary opacity-30" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">FinListics CBV</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              Account planning, benchmarking, and prospect analysis for {customerName}
            </p>
          </div>
          <button
            disabled
            className="w-full px-3 py-2 rounded-lg border border-border text-xs text-text-secondary opacity-50 cursor-not-allowed"
          >
            Launch Tool
          </button>
        </div>

        {/* CBVS */}
        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary opacity-30" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">CBVS</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              Customer business value scoring and opportunity assessment
            </p>
          </div>
          <button
            disabled
            className="w-full px-3 py-2 rounded-lg border border-border text-xs text-text-secondary opacity-50 cursor-not-allowed"
          >
            Launch Tool
          </button>
        </div>
      </div>

      {/* Upload area placeholder */}
      <div className="bg-surface border border-border border-dashed rounded-xl p-8 text-center space-y-3">
        <Upload className="w-8 h-8 text-text-secondary mx-auto opacity-40" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-text-primary">Upload tool outputs</p>
          <p className="text-xs text-text-secondary max-w-sm mx-auto">
            Drag and drop reports from PitchBuilder+, FinListics, or CBVS here to sync them with {customerName}'s Drive folder and NotebookLM sources.
          </p>
        </div>
        <button
          disabled
          className="px-4 py-2 rounded-lg border border-border text-xs text-text-secondary opacity-50 cursor-not-allowed"
        >
          Select Files
        </button>
      </div>
    </div>
  )
}
