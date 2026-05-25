/**
 * GitHub Issue #352 — Cloud Marketplace Program Drill-Down
 *
 * Expandable detail per cloud provider showing:
 * - offerings (product listings)
 * - programs (EDP, CPPO, MACC)
 * - incentives (SPIFFs, credits, free trials)
 * - new countries / partnerships
 */

import { useState, useEffect } from 'react'
import { Cloud, ChevronDown, ChevronUp, Loader2, Package, Award, DollarSign, Globe, Handshake } from 'lucide-react'

interface CloudOffering {
  name: string
  description: string
  dates?: string
}

interface CloudProgram {
  name: string
  description: string
  eligibility?: string
}

interface CloudIncentive {
  name: string
  description: string
  value?: string
}

interface CloudSection {
  provider: string
  offerings: CloudOffering[]
  programs: CloudProgram[]
  incentives: CloudIncentive[]
  newCountries: string[]
  partnerships: string[]
}

interface CloudMarketplaceData {
  clouds: CloudSection[]
  newsletterDate: string | null
  cachedAt: string | null
}

const PROVIDER_COLORS: Record<string, string> = {
  AWS: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
  Google: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  Microsoft: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  Oracle: 'text-red-400 bg-red-500/10 border-red-500/20',
}

export function CloudMarketplaceDetail() {
  const [data, setData] = useState<CloudMarketplaceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/cloud-marketplace/details')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  const toggleProvider = (provider: string) => {
    setExpandedProviders(prev => {
      const next = new Set(prev)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center">
        <Loader2 className="w-6 h-6 text-accent mx-auto animate-spin" />
        <p className="text-xs text-text-secondary mt-2">Loading marketplace data...</p>
      </div>
    )
  }

  if (!data || data.clouds.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center">
        <Cloud className="w-8 h-8 text-text-secondary mx-auto mb-2" />
        <p className="text-sm text-text-secondary">No cloud marketplace data available</p>
        <p className="text-xs text-text-secondary/60 mt-1">Data refreshes weekly from the Cloud Marketplaces newsletter</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {data.newsletterDate && (
        <p className="text-xs text-text-secondary">
          Newsletter: {data.newsletterDate}
        </p>
      )}

      {data.clouds.map(cloud => {
        const isExpanded = expandedProviders.has(cloud.provider)
        const colorClass = PROVIDER_COLORS[cloud.provider] ?? 'text-text-primary bg-border/30 border-border'
        const totalItems = cloud.offerings.length + cloud.programs.length + cloud.incentives.length

        return (
          <div key={cloud.provider} className="bg-surface border border-border rounded-xl overflow-hidden">
            <button
              onClick={() => toggleProvider(cloud.provider)}
              className="w-full px-5 py-4 flex items-center justify-between hover:bg-border/10 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className={`text-sm font-bold px-2.5 py-1 rounded border ${colorClass}`}>
                  {cloud.provider}
                </span>
                <span className="text-xs text-text-secondary">
                  {totalItems} item{totalItems !== 1 ? 's' : ''}
                </span>
              </div>
              {isExpanded ? (
                <ChevronUp className="w-4 h-4 text-text-secondary" />
              ) : (
                <ChevronDown className="w-4 h-4 text-text-secondary" />
              )}
            </button>

            {isExpanded && (
              <div className="px-5 pb-5 space-y-4 border-t border-border/60">
                {/* Offerings */}
                {cloud.offerings.length > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Package className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Offerings</h4>
                    </div>
                    <div className="space-y-2">
                      {cloud.offerings.map((o, i) => (
                        <div key={i} className="bg-bg-secondary/30 rounded-lg p-3">
                          <p className="text-sm font-medium text-text-primary">{o.name}</p>
                          <p className="text-xs text-text-secondary mt-1">{o.description}</p>
                          {o.dates && <p className="text-xs text-accent mt-1">{o.dates}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Programs */}
                {cloud.programs.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Award className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Programs</h4>
                    </div>
                    <div className="space-y-2">
                      {cloud.programs.map((p, i) => (
                        <div key={i} className="bg-bg-secondary/30 rounded-lg p-3">
                          <p className="text-sm font-medium text-text-primary">{p.name}</p>
                          <p className="text-xs text-text-secondary mt-1">{p.description}</p>
                          {p.eligibility && (
                            <p className="text-xs text-warning mt-1">Eligibility: {p.eligibility}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Incentives / SPIFFs */}
                {cloud.incentives.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <DollarSign className="w-3.5 h-3.5 text-success" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Incentives & SPIFFs</h4>
                    </div>
                    <div className="space-y-2">
                      {cloud.incentives.map((inc, i) => (
                        <div key={i} className="bg-bg-secondary/30 rounded-lg p-3">
                          <p className="text-sm font-medium text-text-primary">{inc.name}</p>
                          <p className="text-xs text-text-secondary mt-1">{inc.description}</p>
                          {inc.value && (
                            <p className="text-xs text-success font-medium mt-1">{inc.value}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* New Countries */}
                {cloud.newCountries.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Globe className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">New Countries</h4>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {cloud.newCountries.map((country, i) => (
                        <span key={i} className="text-xs px-2 py-1 rounded bg-border/40 text-text-primary">{country}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Partnerships */}
                {cloud.partnerships.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Handshake className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Partnerships</h4>
                    </div>
                    <div className="space-y-1">
                      {cloud.partnerships.map((p, i) => (
                        <p key={i} className="text-xs text-text-secondary">- {p}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
