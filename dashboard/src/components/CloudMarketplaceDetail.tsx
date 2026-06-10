/**
 * GitHub Issue #352, #453 — Customer-Specific Cloud Marketplace
 *
 * Expandable detail per cloud provider showing:
 * - customer spend or cloud usage intel
 * - programs (EDP, CPPO, MACC) with eligibility
 * - incentives (SPIFFs, credits, free trials) with values
 * - offering count summary (not individual cards)
 * - new countries / partnerships
 */

import { useState, useEffect } from 'react'
import { Cloud, ChevronDown, ChevronUp, Loader2, Award, DollarSign, Globe, Handshake, ExternalLink, Zap } from 'lucide-react'

interface CloudOffering {
  name: string
  availability?: string
  pricing?: string
  url?: string
  sourceUrl?: string
}

interface CloudProgram {
  name: string
  description: string
  eligibility?: string
  url?: string
  sourceUrl?: string
}

interface CloudIncentive {
  name: string
  description: string
  value?: string
  url?: string
  sourceUrl?: string
}

interface CloudProvider {
  provider: string
  acv: number
  hasCloudSpend: boolean
  hasCloudIntel: boolean
  offerings: CloudOffering[]
  programs: CloudProgram[]
  incentives: CloudIncentive[]
  newCountries: string[]
  partnerships: string[]
  providerRank?: number
  conversationOpener?: string | null
}

interface CloudMarketplaceData {
  providers: CloudProvider[]
  newsletterDate: string | null
  cachedAt: string | null
  driveFolderUrl: string | null
}

const PROVIDER_COLORS: Record<string, string> = {
  AWS: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
  Google: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  Microsoft: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  Oracle: 'text-red-400 bg-red-500/10 border-red-500/20',
}

interface Props {
  customerName: string
}

export function CloudMarketplaceDetail({ customerName }: Props) {
  const [data, setData] = useState<CloudMarketplaceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch(`/api/customer/${encodeURIComponent(customerName)}/cloud-marketplace`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [customerName])

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

  if (!data || data.providers.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center">
        <Cloud className="w-8 h-8 text-text-secondary mx-auto mb-2" />
        <p className="text-sm text-text-secondary">No cloud marketplace data for this customer</p>
        <p className="text-xs text-text-secondary/60 mt-1">Data shows when customer has cloud spend or uses cloud platforms</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {data.newsletterDate && (
        <p className="text-xs text-text-secondary flex items-center gap-2">
          <span>Newsletter: {data.newsletterDate}</span>
          {data.driveFolderUrl && (
            <a
              href={data.driveFolderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent/80 inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" />
              <span>View in Drive</span>
            </a>
          )}
        </p>
      )}

      {/* #725: Purchasing recommendation banner */}
      {data.providers[0]?.conversationOpener && (
        <div className="bg-accent/10 border border-accent/20 rounded-xl p-4 mb-3">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-4 h-4 text-accent" />
            <span className="text-xs font-semibold text-accent uppercase tracking-wider">Purchasing Recommendation</span>
          </div>
          <p className="text-sm text-text-primary">{data.providers[0].conversationOpener}</p>
        </div>
      )}

      {[...data.providers].sort((a, b) => (a.providerRank ?? 99) - (b.providerRank ?? 99)).map(provider => {
        const isExpanded = expandedProviders.has(provider.provider)
        const colorClass = PROVIDER_COLORS[provider.provider] ?? 'text-text-primary bg-border/30 border-border'

        // Count offerings by availability type
        const availableToday = provider.offerings.filter(o => o.availability === 'Available Today').length
        const viaPrivateOffer = provider.offerings.filter(o => o.availability === 'Via Private Offer').length

        return (
          <div key={provider.provider} className="bg-surface border border-border rounded-xl overflow-hidden">
            <button
              onClick={() => toggleProvider(provider.provider)}
              className="w-full px-5 py-4 flex items-center justify-between hover:bg-border/10 transition-colors text-left"
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-bold px-2.5 py-1 rounded border ${colorClass}`}>
                    {provider.provider}
                  </span>
                </div>
                {provider.hasCloudSpend && (
                  <span className="text-xs text-text-secondary">
                    ${Math.round(provider.acv).toLocaleString()} Red Hat marketplace spend
                  </span>
                )}
                {!provider.hasCloudSpend && provider.hasCloudIntel && (
                  <span className="text-xs text-text-secondary">
                    Uses {provider.provider}, no RH spend yet
                  </span>
                )}
                {!provider.hasCloudSpend && !provider.hasCloudIntel && (
                  <span className="text-xs text-text-secondary/60">
                    Explore {provider.provider} marketplace opportunities
                  </span>
                )}
              </div>
              {isExpanded ? (
                <ChevronUp className="w-4 h-4 text-text-secondary" />
              ) : (
                <ChevronDown className="w-4 h-4 text-text-secondary" />
              )}
            </button>

            {isExpanded && (
              <div className="px-5 pb-5 space-y-4 border-t border-border/60">
                {/* Programs */}
                {provider.programs.length > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Award className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Programs</h4>
                    </div>
                    <div className="space-y-2">
                      {provider.programs.map((p, i) => (
                        <div key={i} className="bg-bg-secondary/30 rounded-lg p-3">
                          <p className="text-sm font-medium text-text-primary">
                            {p.name}
                            {p.sourceUrl && (
                              <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-accent hover:text-accent/80 inline-flex">
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </p>
                          {p.description && <p className="text-xs text-text-secondary mt-1">{p.description}</p>}
                          {p.eligibility && (
                            <p className="text-xs text-warning mt-1">Eligibility: {p.eligibility}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Incentives / SPIFFs */}
                {provider.incentives.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <DollarSign className="w-3.5 h-3.5 text-success" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Incentives & SPIFFs</h4>
                    </div>
                    <div className="space-y-2">
                      {provider.incentives.map((inc, i) => (
                        <div key={i} className="bg-bg-secondary/30 rounded-lg p-3">
                          <p className="text-sm font-medium text-text-primary">
                            {inc.name}
                            {inc.sourceUrl && (
                              <a href={inc.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-accent hover:text-accent/80 inline-flex">
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </p>
                          {inc.description && <p className="text-xs text-text-secondary mt-1">{inc.description}</p>}
                          {inc.value && (
                            <p className={`text-xs mt-1 ${
                              /\$|credit/i.test(inc.value) ? 'text-green-400 font-bold' : 'text-success font-medium'
                            }`}>{inc.value}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Offerings */}
                {provider.offerings.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Cloud className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                        Red Hat Offerings ({provider.offerings.length})
                      </h4>
                    </div>
                    <div className="space-y-2">
                      {provider.offerings.map((o, i) => (
                        <div key={i} className="bg-bg-secondary/30 rounded-lg p-3">
                          <p className="text-sm font-medium text-text-primary">
                            {o.name}
                            {o.sourceUrl && (
                              <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-accent hover:text-accent/80 inline-flex">
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </p>
                          {o.availability && <p className="text-xs text-text-secondary mt-1">{o.availability}</p>}
                          {o.pricing && <p className="text-xs text-success font-medium mt-1">{o.pricing}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* New Countries */}
                {provider.newCountries.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Globe className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">New Countries</h4>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {provider.newCountries.map((country, i) => (
                        <span key={i} className="text-xs px-2 py-1 rounded bg-border/40 text-text-primary">{country}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Partnerships */}
                {provider.partnerships.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Handshake className="w-3.5 h-3.5 text-accent" />
                      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Partnerships</h4>
                    </div>
                    <div className="space-y-1">
                      {provider.partnerships.map((p, i) => (
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
