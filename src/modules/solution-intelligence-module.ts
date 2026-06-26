/**
 * src/modules/solution-intelligence-module.ts — ADR-030 §3c
 *
 * Produces solution-play, marketplace-opportunity, and version-correlation
 * signals by cross-referencing tech-stack, CCSP, cases, lifecycle, and
 * pipeline caches against the solution-plays.json catalog.
 *
 * Pure computation — no cache of its own, no refresh interval.
 * Depends on tech-stack-module and cloud-marketplace-module for fresh data.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { getCustomerSolutionContext } from '../lib/customer-solution-context.ts'

const CATEGORY_ACTION: Record<string, string> = {
  modernization: 'migration workshop',
  automation: 'automation demo',
  platform: 'demo',
  marketplace: 'procurement review',
}

const PRODUCT_DISPLAY: Record<string, string> = {
  ocp: 'OpenShift',
  rhel: 'RHEL',
  aap: 'Ansible Automation Platform',
  acs: 'Advanced Cluster Security',
  quay: 'Quay',
}

FeatureModuleRegistry.register({
  name: 'solution-intelligence',
  displayName: 'Solution Intelligence',
  refreshEndpoint: '/api/customer/_global/modules/solution-intelligence/sync',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: undefined, // no TTL — pure computation, no cache of its own

  async ensureFresh(_customerSlug: string): Promise<void> {
    // No-op — read-only computation from other module caches
  },

  cachePaths: () => [],

  async signals(customerSlug: string): Promise<Signal[]> {
    const ctx = getCustomerSolutionContext(customerSlug)
    const signals: Signal[] = []
    const customerDisplay = customerSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

    for (const play of ctx.activeSolutionPlays) {
      const actionType = CATEGORY_ACTION[play.category] ?? 'demo'
      const solutionName = play.redHatProducts.map(p => PRODUCT_DISPLAY[p] ?? p).join(' + ')
      const matchedTech = play.matchedTechnologies[0] ?? play.tdp
      const nextStep = `Schedule a ${actionType} of ${solutionName} — ${customerDisplay} already uses ${matchedTech}.`

      signals.push({
        source: 'solution-intelligence',
        type: 'product-intel',
        headline: `${play.playName} — ${play.matchedTechnologies.join(', ')} detected`,
        detail: `${play.valueProps.join('; ')}. Next step: ${nextStep}`,
        rawRelevance: play.confidence === 'HIGH' ? 0.9 : play.confidence === 'MEDIUM' ? 0.7 : 0.5,
        timestamp: new Date().toISOString(),
        url: play.linkedAssets?.[0]?.url || undefined,  // #479: first linked asset URL
        metadata: {
          customerSlug,
          solutionPlayId: play.playId,
          solutionPlayName: play.playName,
          solutionTdp: play.tdp,
          solutionCategory: play.category,
          redHatProducts: play.redHatProducts,
          matchedTechnologies: play.matchedTechnologies,
          valueProps: play.valueProps,
          talkTrack: play.talkTrack,
          customerWins: play.customerWins,
          linkedAssets: play.linkedAssets,
          confidence: play.confidence,
          context: 'evaluating',
          nextStep,
        },
      })
    }

    for (const opp of ctx.marketplaceOpportunities) {
      if (!opp.privateOfferEligible && opp.eligiblePrograms.length === 0) continue
      signals.push({
        source: 'solution-intelligence',
        type: 'product-intel',
        headline: `${opp.provider} marketplace: ${opp.privateOfferEligible ? 'Private offer eligible' : opp.eligiblePrograms[0]}`,
        detail: `$${Math.round(opp.currentSpend).toLocaleString()} ${opp.provider} spend.${opp.movableSubscriptions.length > 0 ? ` Movable: ${opp.movableSubscriptions.join(', ')}` : ''}`,
        rawRelevance: opp.privateOfferEligible ? 0.85 : 0.7,
        timestamp: new Date().toISOString(),
        metadata: {
          customerSlug,
          provider: opp.provider,
          hasCloudSpend: true,
          acvPlus: opp.currentSpend,
          privateOfferEligible: opp.privateOfferEligible,
          eligiblePrograms: opp.eligiblePrograms,
          movableSubscriptions: opp.movableSubscriptions,
        },
      })
    }

    for (const vc of ctx.versionCorrelations) {
      if (!vc.amplified) continue
      signals.push({
        source: 'solution-intelligence',
        type: 'product-intel',
        headline: `${vc.product}: ${vc.activeCases} active cases + ${vc.lifecycleEvent ?? 'version event'}`,
        detail: `Version ${vc.subscriptionVersion} has ${vc.activeCases} open cases${vc.lifecycleEvent ? ` and approaching ${vc.lifecycleEvent}` : ''}.`,
        rawRelevance: 0.9,
        timestamp: new Date().toISOString(),
        metadata: {
          customerSlug,
          product: vc.product,
          activeCases: vc.activeCases,
          lifecycleEvent: vc.lifecycleEvent,
          amplified: true,
          redHatProducts: [vc.product],
          severity: vc.activeCases > 3 ? 1 : 2,
          context: 'migrating_from',
        },
      })
    }

    return signals
  },

  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},
})
