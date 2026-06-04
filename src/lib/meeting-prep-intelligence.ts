/**
 * src/lib/meeting-prep-intelligence.ts
 * Pre-meeting intelligence brief — instant, graph-based meeting prep.
 *
 * GitHub Issue #600 — Pre-meeting view
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

import { loadGraph } from './intelligence-graph.ts'
import { scoreTactics, TOTAL_SIGNAL_TYPES, type ScoredTactic } from './tactic-scorer.ts'
import { computeGraphDiff, type GraphDiffChange } from './graph-diff.ts'
import { findActiveNodesByType } from './graph-utils.ts'
import { resolve as resolveMaterials } from './material-index.ts'
import { callGemini } from '../gemini-call.ts'
import { getAccountTeam, toPromptContext } from '../account-team.ts'
import { customers } from '../server-state.ts'
import { toSlug } from '../cache-layer.ts'
import type { CustomerGraph } from './intelligence-graph-types.ts'
import type { AccountTeamMember } from '../types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MeetingPrepBrief {
  customerName: string
  accountTeam: Array<{ role: string; name: string }>
  signalDensity: { populated: number; total: number; pct: number }
  talkingPoints: string[]
  recentChanges: Array<{
    type: 'new' | 'historical' | 'reactivated'
    description: string
    when: string
  }>
  topEvidence: Array<{ fact: string; recency: string }>
  materials: Array<{ title: string; url: string; type: string }>
  generatedAt: string
}

// ── Candidate Tactics from Graph ─────────────────────────────────────────────

/**
 * Extract candidate tactics from play nodes in the graph.
 * Each play node becomes a tactic candidate for scoring.
 */
function extractCandidateTactics(graph: CustomerGraph) {
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
 * Generate 3 natural-language talking points from scored tactics + evidence.
 * Uses callGemini with callType 'meeting-prep-intelligence'.
 */
async function generateTalkingPoints(
  customerName: string,
  scoredTactics: ScoredTactic[],
  recentChanges: GraphDiffChange[],
  teamContext: string,
): Promise<string[]> {
  if (scoredTactics.length === 0) {
    return [
      'No intelligence signals available yet. Focus on discovery questions about their current technology landscape and business priorities.',
    ]
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

  const systemPrompt = `You are a meeting preparation assistant for a Red Hat Account Solution Architect.
Generate exactly 3 concise, natural-language talking points for an upcoming customer meeting.
Each talking point should:
- Reference specific evidence (case numbers, subscription details, deal names)
- Suggest a concrete question or action
- Be 1-2 sentences maximum
- Use plain business language, not technical jargon or internal acronyms

Do NOT use bullet points or numbered lists in your output. Return exactly 3 talking points separated by newlines.
Each line is one talking point.`

  const userPrompt = `Customer: ${customerName}
${teamContext}

Top Scored Tactics:
${tacticsBlock}

Recent Intelligence Changes:
${changesBlock}

Generate 3 talking points that connect the evidence to specific conversation starters.`

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'meeting-prep-intelligence',
      customerName,
      model: 'lite',
      temperature: 0.3,
    })

    const points = result.text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .slice(0, 3)

    return points.length > 0
      ? points
      : ['Unable to generate talking points from available data.']
  } catch (e: any) {
    console.warn(
      `[meeting-prep-intelligence] Gemini call failed: ${e.message}`,
    )
    // Fallback: use evidence directly
    return top3.map(t => {
      const topEvidence = t.evidenceTrail[0]
      return topEvidence
        ? `${t.name}: ${topEvidence.fact} (${topEvidence.recency})`
        : `Explore ${t.name} opportunities with ${customerName}.`
    })
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
 * Returns null if no graph exists for this customer.
 */
export async function generateMeetingPrepBrief(
  customerSlug: string,
  dataDir: string,
): Promise<MeetingPrepBrief | null> {
  // 1. Load the customer's persisted graph
  const graph = loadGraph(customerSlug, dataDir)
  if (!graph) {
    return null
  }

  // Find the customer record
  const customer = customers.find(c => toSlug(c.name) === customerSlug)
  const customerName = customer?.name ?? graph.customerName ?? customerSlug

  // 2. Extract candidate tactics and score them
  const candidates = extractCandidateTactics(graph)
  const scored = scoreTactics(graph, candidates).sort(
    (a, b) => b.compositeScore - a.compositeScore,
  )

  // 3. Compute graph diff for recent changes
  const diff = computeGraphDiff(graph, null)

  // 4. Get account team
  const team: AccountTeamMember[] = customer
    ? getAccountTeam(customer)
    : []
  const teamContext = toPromptContext(team)

  // 5. Generate talking points via Gemini
  const talkingPoints = await generateTalkingPoints(
    customerName,
    scored,
    diff.changes,
    teamContext,
  )

  // 6. Signal density
  const nodeTypes = new Set(
    Object.values(graph.nodes)
      .filter(n => n.history?.status !== 'historical')
      .map(n => n.type)
      .filter(t => t !== 'customer'),
  )
  const populated = nodeTypes.size
  const total = TOTAL_SIGNAL_TYPES

  // 7. Top evidence from scored tactics
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

  // 8. Materials from top tactics
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

  // 9. Recent changes formatted
  const recentChanges = diff.changes.slice(0, 8).map(c => ({
    type: c.changeType as 'new' | 'historical' | 'reactivated',
    description: c.description,
    when: c.timestamp,
  }))

  return {
    customerName,
    accountTeam: team.map(m => ({ role: m.title, name: m.name })),
    signalDensity: {
      populated,
      total,
      pct: total > 0 ? Math.round((populated / total) * 100) : 0,
    },
    talkingPoints,
    recentChanges,
    topEvidence,
    materials,
    generatedAt: new Date().toISOString(),
  }
}
