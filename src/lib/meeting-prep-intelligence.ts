/**
 * src/lib/meeting-prep-intelligence.ts
 * Pre-meeting intelligence brief — instant, graph-based meeting prep.
 *
 * GitHub Issue #600 — Pre-meeting view
 * GitHub Issue #849 — Consumer contract v1.0 hardening
 *
 * Generates a structured brief from the customer's intelligence graph
 * using tactic scoring, graph diff, account team, and Gemini for
 * natural-language talking points. Designed for < 2s response time
 * (Gemini call is the bottleneck).
 *
 * This is a CONSUMER: uses loadGraph() for the intelligence graph,
 * scoreTactics() for ranked tactics, computeGraphDiff() for recent
 * changes, and callGemini() for talking point synthesis.
 */

// @consumer-contract v1.0

import { loadGraph } from './intelligence-graph.ts'
import { scoreTactics, TOTAL_SIGNAL_TYPES, type ScoredTactic } from './tactic-scorer.ts'
import { computeGraphDiff, type GraphDiffChange } from './graph-diff.ts'
import { findActiveNodesByType } from './graph-utils.ts'
import { resolve as resolveMaterials } from './material-index.ts'
import { callGemini } from '../gemini-call.ts'
import { validateAndRetry, formatFailureFeedback } from '../gemini-quality-gate.ts'
import { meetingPrepBriefValidator } from '../quality-validators/meeting-prep-brief-validator.ts'
import { getAccountTeam, toPromptContext } from '../account-team.ts'
import { readLatestDebrief, type MeetingDebrief } from '../meeting-debrief-service.ts'
import { customers } from '../server-state.ts'
import { toSlug } from '../cache-layer.ts'
import { loadCustomerSignals } from './signal-loader.ts'
import { templateAll } from './signal-templates.ts'
import type { CustomerGraph } from './intelligence-graph-types.ts'
import type { AccountTeamMember } from '../types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface StakeholderPath {
  name: string
  role: string
  reason: string
}

export interface MeetingPrepBrief {
  customerName: string
  accountTeam: Array<{ role: string; name: string }>
  signalDensity: { populated: number; total: number; pct: number }
  talkingPoints: string[]
  challengerInsight?: string
  stakeholderPaths: StakeholderPath[]
  qualityScore?: number
  recentChanges: Array<{
    type: 'new' | 'historical' | 'reactivated'
    description: string
    when: string
  }>
  topEvidence: Array<{ fact: string; recency: string }>
  materials: Array<{ title: string; url: string; type: string }>
  lastDebrief?: {
    notes: string
    nextSteps?: string
    createdAt: string
  }
  generatedAt: string
}

// ── Candidate Tactics from Graph ─────────────────────────────────────────────

/**
 * Extract candidate tactics from play nodes in the graph.
 * Each play node becomes a tactic candidate for scoring.
 */
export function extractCandidateTactics(graph: CustomerGraph) {
  const playNodes = findActiveNodesByType(graph, 'play')

  return playNodes.map(play => {
    const tdp = String(
      play.properties.tdp ?? play.properties.productAlignment ?? play.name,
    )
    const materials = resolveMaterials(tdp)

    return {
      name: play.name,
      parentTdp: tdp,
      tdpUrl: play.properties.url as string | undefined,
      assets: [] as Array<{ name: string; url: string; type: string }>,
      materials,
    }
  })
}

// ── Talking Points via Gemini ────────────────────────────────────────────────

/**
 * Generate 3 natural-language talking points + 1 Challenger insight
 * from scored tactics + evidence + templateAll context.
 * Uses callGemini with callType 'meeting-prep-intelligence'.
 * Quality-gated via validateAndRetry (ADR-024, consumer contract TC-5).
 */
async function generateTalkingPoints(
  customerName: string,
  scoredTactics: ScoredTactic[],
  recentChanges: GraphDiffChange[],
  teamContext: string,
  narrativeContext: string,
  lastDebrief?: MeetingDebrief | null,
): Promise<{ talkingPoints: string[]; challengerInsight?: string; qualityScore?: number }> {
  if (scoredTactics.length === 0) {
    return {
      talkingPoints: [
        'No intelligence signals available yet. Focus on discovery questions about their current technology landscape and business priorities.',
      ],
    }
  }

  const top3 = scoredTactics.slice(0, 3)

  const tacticsBlock = top3
    .map((t, i) => {
      const evidence = t.evidenceTrail
        .filter(e => e.weight > 0)
        .map(e => `  - ${e.fact} (${e.recency})`)
        .join('\n')
      return `${i + 1}. ${t.name} (TDP: ${t.parentTdp}, score: ${t.compositeScore.toFixed(2)})\n${evidence}`
    })
    .join('\n\n')

  const changesBlock =
    recentChanges.length > 0
      ? recentChanges
          .slice(0, 5)
          .map(c => `- ${c.description} (${c.timestamp})`)
          .join('\n')
      : 'No recent changes detected.'

  // Mission-aligned system prompt (MA-2, MA-3, MA-4, MA-5, MA-6)
  const systemPrompt = `You are a meeting preparation assistant for a Red Hat Account Solution Architect.
Generate exactly 3 concise talking points for an upcoming customer meeting.

Each talking point MUST:
1. Follow evidence chain: [Customer situation] -> [Business impact] -> [Red Hat solution] -> [Measurable outcome]
2. Name WHO to ask, WHAT to say, BY WHEN
3. Connect to a dollar figure (pipeline value, renewal amount, expansion opportunity, or cost savings estimate)
4. Reference specific evidence (case numbers, subscription details, deal names)
5. Be 2-3 sentences maximum

Additionally, include ONE Challenger insight — something the customer may not know about their own business, industry benchmarks, or competitive landscape that reframes their priorities.

Format: Return exactly 3 talking points + 1 Challenger insight, each on its own line.
Label the Challenger line with [CHALLENGER]:
Do NOT use bullet points or numbered lists in your output.`

  const debriefBlock = lastDebrief
    ? `\nLast Meeting Notes (${new Date(lastDebrief.createdAt).toLocaleDateString()}):\n${lastDebrief.notes}${lastDebrief.nextSteps ? `\nNext steps from last meeting: ${lastDebrief.nextSteps}` : ''}\n`
    : ''

  const narrativeBlock = narrativeContext
    ? `\nDeterministic Intelligence Context:\n${narrativeContext}\n`
    : ''

  const userPrompt = `Customer: ${customerName}
${teamContext}

Top Scored Tactics:
${tacticsBlock}

Recent Intelligence Changes:
${changesBlock}
${debriefBlock}${narrativeBlock}
Generate 3 talking points that connect the evidence to specific conversation starters, plus 1 Challenger insight.${lastDebrief ? ' Reference the last meeting notes where relevant — follow up on next steps or seller observations.' : ''}`

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'meeting-prep-intelligence',
      customerName,
      temperature: 0.3,
    })

    // Quality gate — validateAndRetry (consumer contract TC-5)
    const gateResult = await validateAndRetry(
      result.text,
      { validator: meetingPrepBriefValidator },
      async (failures, attempt) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await callGemini(systemPrompt, userPrompt + '\n\nQuality feedback from previous attempt:\n' + feedback, {
          callType: 'meeting-prep-intelligence',
          customerName,
          temperature: 0.3,
        })
        return retryResult.text
      },
    )

    // Parse the validated output: separate talking points from Challenger insight
    const lines = gateResult.output
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)

    const challengerLine = lines.find(l => l.startsWith('[CHALLENGER]:') || l.startsWith('[CHALLENGER]'))
    const talkingPointLines = lines
      .filter(l => !l.startsWith('[CHALLENGER]:') && !l.startsWith('[CHALLENGER]'))
      .slice(0, 3)

    const challengerInsight = challengerLine
      ? challengerLine.replace(/^\[CHALLENGER\]:?\s*/, '').trim()
      : undefined

    return {
      talkingPoints: talkingPointLines.length > 0
        ? talkingPointLines
        : ['Unable to generate talking points from available data.'],
      challengerInsight,
      qualityScore: gateResult.scorecard.score,
    }
  } catch (e: any) {
    console.warn(
      `[meeting-prep-intelligence] Gemini call failed: ${e.message}`,
    )
    // Fallback: use evidence directly
    return {
      talkingPoints: top3.map(t => {
        const topEvidence = t.evidenceTrail[0]
        return topEvidence
          ? `${t.name}: ${topEvidence.fact} (${topEvidence.recency})`
          : `Explore ${t.name} opportunities with ${customerName}.`
      }),
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an instant pre-meeting intelligence brief for a customer.
 *
 * Reads the persisted intelligence graph, scores tactics, computes
 * recent changes, and uses Gemini to synthesize talking points.
 * Designed for < 2s response (graph read + scoring is < 50ms;
 * Gemini lite call is the bottleneck at ~1-1.5s).
 *
 * Consumer contract v1.0 (#849):
 * - ensureFresh called before generation (TC-2)
 * - templateAll for deterministic sections (TC-3)
 * - validateAndRetry for quality gate (TC-5)
 * - getAccountTeam for named stakeholders (TC-7)
 *
 * Returns null if no graph exists for this customer.
 */
export async function generateMeetingPrepBrief(
  customerSlug: string,
  dataDir: string,
): Promise<MeetingPrepBrief | null> {
  // 1. Find the customer record (needed for ensureFresh + team)
  const customer = customers.find(c => toSlug(c.name) === customerSlug)
  const customerName = customer?.name ?? customerSlug

  // 2. Pre-flight signal refresh — consumer contract TC-2
  await loadCustomerSignals(customerSlug, customerName, { ensureFresh: true })

  // 3. Load the customer's persisted graph
  const graph = loadGraph(customerSlug, dataDir)
  if (!graph) {
    return null
  }

  // Use graph's customerName if we only had slug
  const resolvedName = customer?.name ?? graph.customerName ?? customerSlug

  // 4. Extract candidate tactics and score them
  const candidates = extractCandidateTactics(graph)
  const scored = scoreTactics(graph, candidates).sort(
    (a, b) => b.compositeScore - a.compositeScore,
  )

  // 5. Compute graph diff for recent changes
  const diff = computeGraphDiff(graph, null)

  // 6. Get account team (TC-7)
  const team: AccountTeamMember[] = customer
    ? getAccountTeam(customer)
    : []
  const teamContext = toPromptContext(team)

  // 7. Layer 3 consumer contract — deterministic sections via template engine (TC-3)
  const signals = await loadCustomerSignals(customerSlug, resolvedName)
  const templateResult = await templateAll(signals.registrySignals, team, { format: 'meeting-prep' })

  // 8. Read latest debrief for continuity (#611)
  const lastDebrief = readLatestDebrief(customerSlug)

  // 9. Multi-threading — identify stakeholder engagement paths (MA-5)
  const stakeholderPaths: StakeholderPath[] = team
    .filter(m => m.title !== 'Account Solution Architect')
    .slice(0, 3)
    .map(m => ({
      name: m.name,
      role: m.title,
      reason: `Engage on ${m.title.includes('SSP') ? 'solution positioning' : m.title.includes('SSA') ? 'technical validation' : 'account strategy'}`,
    }))

  // 10. Generate talking points via Gemini with quality gate
  const { talkingPoints, challengerInsight, qualityScore } = await generateTalkingPoints(
    resolvedName,
    scored,
    diff.changes,
    teamContext,
    templateResult.narrativeContext,
    lastDebrief,
  )

  // 11. Signal density
  const nodeTypes = new Set(
    Object.values(graph.nodes)
      .filter(n => n.history?.status !== 'historical')
      .map(n => n.type)
      .filter(t => t !== 'customer'),
  )
  const populated = nodeTypes.size
  const total = TOTAL_SIGNAL_TYPES

  // 12. Top evidence from scored tactics
  const topEvidence: Array<{ fact: string; recency: string }> = []
  const seenFacts = new Set<string>()
  for (const tactic of scored) {
    for (const ev of tactic.evidenceTrail) {
      if (ev.weight > 0 && !seenFacts.has(ev.fact)) {
        seenFacts.add(ev.fact)
        topEvidence.push({ fact: ev.fact, recency: ev.recency })
        if (topEvidence.length >= 8) break
      }
    }
    if (topEvidence.length >= 8) break
  }

  // 13. Materials from top tactics
  const materials: Array<{ title: string; url: string; type: string }> = []
  const seenUrls = new Set<string>()
  for (const tactic of scored.slice(0, 3)) {
    if (tactic.materials) {
      for (const mat of tactic.materials) {
        if (!seenUrls.has(mat.url)) {
          seenUrls.add(mat.url)
          materials.push({ title: mat.title, url: mat.url, type: mat.type })
          if (materials.length >= 6) break
        }
      }
    }
    if (materials.length >= 6) break
  }

  // 14. Recent changes formatted
  const recentChanges = diff.changes.slice(0, 8).map(c => ({
    type: c.changeType as 'new' | 'historical' | 'reactivated',
    description: c.description,
    when: c.timestamp,
  }))

  return {
    customerName: resolvedName,
    accountTeam: team.map(m => ({ role: m.title, name: m.name })),
    signalDensity: {
      populated,
      total,
      pct: total > 0 ? Math.round((populated / total) * 100) : 0,
    },
    talkingPoints,
    challengerInsight,
    stakeholderPaths,
    qualityScore,
    recentChanges,
    topEvidence,
    materials,
    ...(lastDebrief ? {
      lastDebrief: {
        notes: lastDebrief.notes,
        nextSteps: lastDebrief.nextSteps,
        createdAt: lastDebrief.createdAt,
      },
    } : {}),
    generatedAt: new Date().toISOString(),
  }
}
