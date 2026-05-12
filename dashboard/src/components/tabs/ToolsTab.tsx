/**
 * GitHub Issue #147: Tools tab with live deep links
 * Feature: Smart launcher for Red Hat business value tools + artifact upload
 * Status: Phase 2 — active links with customer context
 */

import { Wrench, ExternalLink, Upload, Copy, Check } from 'lucide-react'
import { useState, useEffect } from 'react'

interface ToolsTabProps {
  customerName: string
}

interface Customer {
  name: string
  accountNumbers?: string[]
}

export function ToolsTab({ customerName }: ToolsTabProps) {
  const [accountNumbers, setAccountNumbers] = useState<string[]>([])
  const [copiedAccount, setCopiedAccount] = useState<string | null>(null)

  // Fetch customer account numbers
  useEffect(() => {
    fetch('/api/accounts')
      .then((r) => r.json())
      .then((json) => {
        const customer = (json.customers ?? []).find(
          (c: Customer) => c.name.toLowerCase() === customerName.toLowerCase()
        )
        if (customer?.accountNumbers) {
          setAccountNumbers(customer.accountNumbers)
        }
      })
      .catch(() => {})
  }, [customerName])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedAccount(text)
    setTimeout(() => setCopiedAccount(null), 2000)
  }

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
        <a
          href="https://pitchbuilderplus.redhat.com/export"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface border border-border rounded-xl p-5 space-y-3 hover:border-accent/50 transition-colors group"
        >
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary group-hover:text-accent transition-colors" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">PitchBuilder+</h3>
            <p className="text-xs text-text-secondary leading-relaxed mb-2">
              Export sales-ready reports showcasing Red Hat's delivered value for <span className="font-medium text-text-primary">{customerName}</span>
            </p>
            {accountNumbers.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {accountNumbers.map((acct) => (
                  <div key={acct} className="flex items-center gap-1 bg-bg-primary/50 rounded px-2 py-1">
                    <span className="text-xs font-mono text-text-secondary">{acct}</span>
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        copyToClipboard(acct)
                      }}
                      className="hover:text-accent transition-colors"
                      title="Copy to clipboard"
                    >
                      {copiedAccount === acct ? (
                        <Check className="w-3 h-3 text-green-500" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="w-full px-3 py-2 rounded-lg bg-accent/10 text-xs text-accent font-medium text-center group-hover:bg-accent/20 transition-colors">
            Launch Tool
          </div>
        </a>

        {/* FinListics CBV */}
        <a
          href="https://v2.finlistics-vm.com/start-page"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface border border-border rounded-xl p-5 space-y-3 hover:border-accent/50 transition-colors group"
        >
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary group-hover:text-accent transition-colors" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">FinListics CBV</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              Account planning, benchmarking, and prospect analysis for <span className="font-medium text-text-primary">{customerName}</span>
            </p>
          </div>
          <div className="w-full px-3 py-2 rounded-lg bg-accent/10 text-xs text-accent font-medium text-center group-hover:bg-accent/20 transition-colors">
            Launch Tool
          </div>
        </a>

        {/* CBVS */}
        <a
          href="https://auth.redhat.com/auth/realms/EmployeeIDP/protocol/saml/clients/cbvs"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface border border-border rounded-xl p-5 space-y-3 hover:border-accent/50 transition-colors group"
        >
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary group-hover:text-accent transition-colors" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">CBVS</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              Customer business value scoring and opportunity assessment for <span className="font-medium text-text-primary">{customerName}</span>
            </p>
          </div>
          <div className="w-full px-3 py-2 rounded-lg bg-accent/10 text-xs text-accent font-medium text-center group-hover:bg-accent/20 transition-colors">
            Launch Tool
          </div>
        </a>
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
