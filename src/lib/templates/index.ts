/**
 * Signal Template Engine — Index
 * Re-exports all template functions and types from domain modules.
 * GitHub Issue #684
 *
 * NO GEMINI CALLS. Pure deterministic output.
 * Signals arrive already scored from the registry — this module only formats.
 */

import type { Signal } from '../../feature-module-registry.ts'
import type { AccountTeamMember } from '../../types.ts'
import type { TemplateOptions, TemplateResult, SolutionPlaySnapshot } from './types.ts'
import { filterByProduct } from './route-signal.ts'
import { routeSignal } from './route-signal.ts'
import { templateProductAlignment } from './product.ts'
import { templateCloudMarketplace } from './cloud.ts'
import { templateRenewals } from './renewals.ts'
import { templateCases } from './cases.ts'
import { templateTechStack } from './tech.ts'
import { templateUpcomingEvents } from './events.ts'
import { templateEmailIntelligence } from './email.ts'
import { templateKeyRelationships } from './relationships.ts'
import { templateStrategicOpportunities } from './strategic.ts'
import { templateCompetitiveLandscape } from './competitive.ts'
import { templateIntelligence } from './intelligence.ts'
import { templateSalesHubInsights, templateSalesHubContext } from './saleshub.ts'
import { templateMeetingContext } from './meeting-context.ts'
import { templateSalesAlignment } from './sales-alignment.ts'
import { getSalesPlayByName, getTacticsByTdp } from '../saleshub-knowledge-loader.ts'
import { isValidMetric } from '../saleshub-filters.ts'

// Re-export everything from domain modules
export * from './types.ts'
export * from './route-signal.ts'
export * from './product.ts'
export * from './cloud.ts'
export * from './renewals.ts'
export * from './cases.ts'
export * from './tech.ts'
export * from './events.ts'
export * from './email.ts'
export * from './relationships.ts'
export * from './strategic.ts'
export * from './competitive.ts'
export * from './intelligence.ts'
export * from './saleshub.ts'
export * from './meeting-context.ts'
export * from './sales-alignment.ts'

/**
 * Orchestrator: Assemble all sections into a complete template result.
 *
 * @param signals - Scored signals from the registry
 * @param team - Account team members array from getAccountTeam() (optional)
 * @param options - Format and filtering options
 */
export async function templateAll(
  signals: Signal[],
  team?: AccountTeamMember[],
  options: TemplateOptions = { format: 'playbook' }
): Promise<TemplateResult> {
  // Apply product filter if specified
  const filteredSignals = filterByProduct(signals, options.productFilter)

  // Build individual sections
  const productAlignment = templateProductAlignment(filteredSignals)
  const cloudMarketplace = templateCloudMarketplace(filteredSignals)
  const renewals = templateRenewals(filteredSignals)
  const cases = templateCases(filteredSignals)
  const techStack = templateTechStack(filteredSignals)
  const keyRelationships = templateKeyRelationships(team)
  const salesAlignment = templateSalesAlignment(filteredSignals)
  const strategicOpportunities = templateStrategicOpportunities(filteredSignals)
  const saleshubContext = templateSalesHubContext(filteredSignals)
  const upcomingEvents = templateUpcomingEvents(filteredSignals)
  const competitiveLandscape = templateCompetitiveLandscape(filteredSignals)
  const intelligence = templateIntelligence(filteredSignals)
  const salesHubInsights = templateSalesHubInsights(filteredSignals)
  const emailIntelligence = templateEmailIntelligence(filteredSignals)
  const meetingContext = templateMeetingContext(filteredSignals)

  // #380: Account plan — render as text section for playbook/brief only
  const accountPlanSignals = filteredSignals.filter(s => routeSignal(s) === 'account-plan')
  const accountPlan = accountPlanSignals.length > 0
    ? accountPlanSignals.map(s => s.detail).join('\n\n')
    : null

  // Assemble deterministic markdown output
  const sections: string[] = []

  // Sales Alignment at the top — management-visible TDP/Play mapping
  if (salesAlignment) sections.push(`## Sales Alignment\n\n${salesAlignment}`)
  // #673: SalesHub insights (tactics + strategic plays) — after sales alignment, before strategic opportunities
  if (salesHubInsights) sections.push(salesHubInsights)
  // Strategic detail (solution plays table, marketplace, correlations) — consolidated under Sales Alignment
  if (strategicOpportunities) sections.push(strategicOpportunities)
  // #672: Competitive landscape — after strategic opportunities
  if (competitiveLandscape) sections.push(competitiveLandscape)
  // Talk tracks and positioning detail — only in narrativeContext, not deterministic (avoids duplication)
  // saleshubContext feeds Gemini but doesn't render as a separate visible section
  if (productAlignment) sections.push(`## Product Alignment\n\n${productAlignment}`)
  if (cloudMarketplace) sections.push(`## Cloud Marketplace\n\n${cloudMarketplace}`)
  if (renewals) sections.push(`## Renewals & Pipeline\n\n${renewals}`)
  if (cases) sections.push(`## Support Cases\n\n${cases}`)
  // #674: Email intelligence — after cases
  if (emailIntelligence) sections.push(emailIntelligence)
  // #987: Meeting context correlation — after email intelligence
  if (meetingContext) sections.push(meetingContext)
  if (techStack) sections.push(`## Technology Stack\n\n${techStack}`)
  if (upcomingEvents) sections.push(`## Upcoming Events\n\n${upcomingEvents}`)
  // #380: Account plan — long-form text, only in playbook/brief (not campaign)
  if (accountPlan && (options.format === 'playbook' || options.format === 'brief' || options.format === 'meeting-prep')) {
    sections.push(`## Account Plan\n\n${accountPlan}`)
  }
  if (keyRelationships) sections.push(`## Key Relationships\n\n${keyRelationships}`)
  // #673: Intelligence section — after key relationships
  if (intelligence) sections.push(intelligence)

  const deterministic = sections.join('\n\n')

  // Build narrative context for Gemini (top N signals, format varies by consumer)
  const maxNarrative = options.maxNarrative ?? 20
  const topSignals = filteredSignals
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxNarrative)

  let narrativeContext = ''

  if (options.format === 'playbook') {
    // Playbook format: [source] headline: detail
    narrativeContext = topSignals
      .map(s => `[${s.source}] ${s.headline}: ${s.detail}`)
      .join('\n')
  } else if (options.format === 'brief') {
    // Brief format: [type] headline — detail (150 chars) (url)
    narrativeContext = topSignals
      .map(s => `[${s.type}] ${s.headline} — ${s.detail.slice(0, 150)}${s.url ? ` (${s.url})` : ''}`)
      .join('\n')
  } else if (options.format === 'campaign') {
    // Campaign format: [type] headline — detail (200 chars)
    narrativeContext = topSignals
      .map(s => `[${s.type}] ${s.headline}${s.detail ? ' — ' + s.detail.substring(0, 200) : ''}`)
      .join('\n')
  } else {
    // meeting-prep format: same as playbook
    narrativeContext = topSignals
      .map(s => `[${s.source}] ${s.headline}: ${s.detail}`)
      .join('\n')
  }

  // Legacy intelligence context passthrough (campaigns only)
  if (options.intelligenceContext && options.format === 'campaign') {
    narrativeContext = `${narrativeContext}\n\nCompany Intelligence:\n${options.intelligenceContext}`
  }

  // #672: Append competitive signals to narrative context so Gemini can reference them
  const competitiveNarrative = filteredSignals
    .filter(s => routeSignal(s) === 'competitive')
    .slice(0, 5)
    .map(s => `[competitive] ${s.headline}: ${s.detail}`)
    .join('\n')
  if (competitiveNarrative) {
    narrativeContext = `${narrativeContext}\n\nCompetitive Intelligence:\n${competitiveNarrative}`
  }

  // Append SalesHub talk tracks to narrative context so Gemini uses the language
  if (saleshubContext) {
    narrativeContext = `${narrativeContext}\n\nSales Plays, TDPs & Tactics (use this positioning language in your output):\n${saleshubContext}`
  }

  // Build structured solution play snapshots if customerSlug provided
  let solutionPlays: SolutionPlaySnapshot[] = []
  if (options.customerSlug) {
    try {
      const { getCustomerSolutionContext } = await import('../customer-solution-context.ts')
      const solutionCtx = getCustomerSolutionContext(options.customerSlug)
      solutionPlays = solutionCtx.activeSolutionPlays.map(p => {
        // Look up SalesPlay for customerLens and realWorldExamples (#371)
        const salesPlay = getSalesPlayByName(p.playName)
        // Collect metrics from tactics under this play's TDP
        const tdpTactics = getTacticsByTdp(p.tdp)
        const extractedMetrics = tdpTactics
          .flatMap(t => (t.metrics ?? []) as Array<{ value: string; context: string }>)
          .filter(isValidMetric)
          .slice(0, 5)

        return {
          tdp: p.tdp,
          playName: p.playName,
          triggerTechnologies: p.matchedTechnologies,
          confidence: p.confidence,
          talkTrack: p.talkTrack,
          customerWins: p.customerWins,
          linkedAssets: p.linkedAssets?.map(a => ({ name: a.name, url: a.url })),
          matchReasoning: p.matchReasoning,
          customerLens: salesPlay?.customerLens,
          realWorldExamples: salesPlay?.realWorldExamples?.slice(0, 3),
          extractedMetrics: extractedMetrics.length > 0 ? extractedMetrics : undefined,
        }
      })
    } catch {
      // Solution context unavailable — return empty array
    }
  }

  return {
    deterministic,
    narrativeContext,
    sections: {
      salesAlignment,
      productAlignment,
      cloudMarketplace,
      renewals,
      cases,
      techStack,
      keyRelationships,
      strategicOpportunities,
      saleshubContext,
      upcomingEvents,
      accountPlan,
    },
    structured: {
      solutionPlays,
    },
  }
}
