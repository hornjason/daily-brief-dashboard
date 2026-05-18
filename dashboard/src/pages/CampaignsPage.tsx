/**
 * CampaignsPage — Module page for campaigns
 * GitHub Issue #241, #246
 *
 * Wraps CampaignsTab content in ModulePageShell.
 * Scope: 'both' — "All customers" shows aggregated campaign history,
 * selecting a customer shows that customer's campaign configurator.
 * Route: /dashboard/campaigns
 */

import { useState, useEffect } from 'react'
import { ModulePageShell, useModulePage } from '../components/ModulePageShell'
import { CampaignsTab } from '../components/tabs/CampaignsTab'
import { useApi } from '../hooks/useApi'
import { Mail, FileText, ExternalLink } from 'lucide-react'

interface CampaignEntry {
  timestamp: string
  materialUrl?: string
  personas?: string[]
  outputPath?: string
}

interface AccountInfo {
  name: string
  ae?: string
}

function AllCustomersCampaigns() {
  const accountsApi = useApi<{ customers: AccountInfo[] }>('/api/accounts')
  const [campaigns, setCampaigns] = useState<Record<string, CampaignEntry[]>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!accountsApi.data?.customers?.length) return

    const fetchAll = async () => {
      setLoading(true)
      const results: Record<string, CampaignEntry[]> = {}
      for (const customer of accountsApi.data!.customers) {
        try {
          const res = await fetch(`/api/customer/${encodeURIComponent(customer.name)}/campaigns`)
          if (res.ok) {
            const data = await res.json()
            if (data.campaigns?.length) {
              results[customer.name] = data.campaigns
            }
          }
        } catch { /* skip */ }
      }
      setCampaigns(results)
      setLoading(false)
    }
    fetchAll()
  }, [accountsApi.data])

  if (accountsApi.loading || loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    )
  }

  const customerNames = Object.keys(campaigns).sort()

  if (customerNames.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 max-w-md">
          <Mail className="w-12 h-12 text-text-secondary mx-auto" />
          <p className="text-sm text-text-secondary">
            No campaigns generated yet. Select a customer to create one.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="text-sm text-text-secondary">
        {customerNames.length} customer{customerNames.length !== 1 ? 's' : ''} with campaigns
      </div>
      {customerNames.map(name => (
        <div key={name}>
          <h3 className="text-sm font-semibold text-text-primary mb-3 uppercase tracking-wider">{name}</h3>
          <div className="space-y-2">
            {campaigns[name].map((campaign, i) => (
              <div
                key={i}
                className="p-4 rounded-lg bg-surface/50 border border-border/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary">
                      Campaign generated {new Date(campaign.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    {campaign.personas?.length ? (
                      <div className="flex gap-1.5 mt-2">
                        {campaign.personas.map(p => (
                          <span key={p} className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-text-primary">{p}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {campaign.outputPath && (
                    <FileText className="w-4 h-4 text-text-secondary shrink-0 mt-1" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function CampaignsContent() {
  const { customer } = useModulePage()

  if (!customer) {
    return <AllCustomersCampaigns />
  }

  return <CampaignsTab customerName={customer} />
}

export function CampaignsPage() {
  return (
    <ModulePageShell
      title="Campaigns"
      icon="Mail"
      scope="both"
    >
      <CampaignsContent />
    </ModulePageShell>
  )
}
