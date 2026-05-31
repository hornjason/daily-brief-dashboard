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

FeatureModuleRegistry.register({
  name: 'solution-intelligence',
  displayName: 'Solution Intelligence',
  refreshEndpoint: '/api/customer/_global/modules/solution-intelligence/sync',
  scope: 'customer',
  cacheTtlMs: undefined, // no TTL — pure computation, no cache of its own

  async ensureFresh(_customerSlug: string): Promise<void> {
    // No-op — read-only computation from other module caches
  },

  cachePaths: () => [],

  async signals(customerSlug: string): Promise<Signal[]> {
    const ctx = getCustomerSolutionContext(customerSlug)
    const signals: Signal[] = []

    for (const play of ctx.activeSolutionPlays) {
      signals.push({
        source: 'solution-intelligence',
        type: 'product-intel',
        headline: `${play.playName} — ${play.matchedTechnologies.join(', ')} detected`,
        detail: play.valueProps.join('; '),
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
