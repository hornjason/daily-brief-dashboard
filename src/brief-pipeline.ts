// ── R18: Three-Step Brief Pipeline (EXTRACT -> RANK -> SYNTHESIZE) ─────────
//
// R23: The extraction system prompt + schema are identical across all customers.
// Gemini context caching would cache these as a cachedContent resource (24h TTL)
// and reference by name in subsequent calls, reducing token costs 70-85%.
// Implementation: create cached content via Vertex AI API on server start,
// pass cachedContent reference to callLLMStructured instead of inline system prompt.
// For v1, we inline everything. Context caching is a v2 optimization.

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ExtractedItem {
  category: string
  text: string
  source_type: string
  source_detail: string
  confidence: string
  urgency: string
  is_new_since_last_brief: boolean
}

export interface ExtractionResult {
  customer_name: string
  extraction_date: string
  last_interaction: string
  items: ExtractedItem[]
  data_gaps: string[]
}

export interface RankedItem extends ExtractedItem {
  score: number
}

// ── Step 2: RANK — Deterministic priority scoring (no LLM call) ────────────
// From GEMINI-BRIEF-ARCHITECTURE.md lines 197-211

export function rankItems(items: ExtractedItem[]): RankedItem[] {
  const urgencyScore: Record<string, number> = { CRITICAL: 100, HIGH: 60, MEDIUM: 20 }
  const categoryScore: Record<string, number> = { RISK: 50, ACTION: 40, COMPETITIVE: 30, CHANGE: 20, OPPORTUNITY: 15, STAKEHOLDER: 10 }
  const confidenceScore: Record<string, number> = { HIGH: 1.0, MEDIUM: 0.7 }
  const newBonus = 25

  return items
    .map(item => ({
      ...item,
      score: ((urgencyScore[item.urgency] ?? 20) + (categoryScore[item.category] ?? 10))
             * (confidenceScore[item.confidence] ?? 0.7)
             + (item.is_new_since_last_brief ? newBonus : 0)
    }))
    .sort((a, b) => b.score - a.score)
}

// ── Step 3: SYNTHESIZE — Brief composition prompt ──────────────────────────
// From GEMINI-BRIEF-ARCHITECTURE.md lines 228-267

export const SYNTHESIS_PROMPT = `You are writing a comprehensive customer intelligence brief for a Red Hat Account Solution Architect.
The SA uses this brief to prepare for customer interactions and strategic planning.

RULES:
- Lead with what CHANGED since {last_interaction_date}. This is the most important section.
- The FIRST SENTENCE must state the single most important action the SA should take.
- Every factual claim must cite its source as [Source: {source_type}].
- Maximum 5 bullet points per section. Include only the highest-signal items.
- If data is stale or missing, say so: "[Source: {type}, last synced {date} — may be outdated]"
- Do not include generic company descriptions the SA already knows.
- Do not include information that hasn't changed since the last brief.
- Instead of "No pipeline opportunities" — omit the section entirely.
- Include sections for Account Overview, Company Profile, Technology Landscape, and Pipeline Opportunities when document sources contain this intelligence.
- Brief should be concise — 250-400 words. Delta-first. Do not expand to fill space.

FORMAT:
## Priority Action
[One sentence: what to do, why, by when]

## What Changed Since {last_interaction_date}
- [change 1] [Source: {type}]
- [change 2] [Source: {type}]
- [change 3] [Source: {type}]

## Risks & Renewals (only if applicable)
- [risk with timeline] [Source: {type}]

## Meeting Prep (only if meeting within 3 days)
- [talking point 1]
- [talking point 2]

## Competitive Signals (only if detected)
- [competitor mention with context] [Source: {type}]

DATA FRESHNESS:
{data_gaps}

ITEMS TO SYNTHESIZE (pre-ranked, most important first):
{ranked_items_json}`

export function buildSynthesisPrompt(
  rankedItems: RankedItem[],
  lastInteractionDate: string,
  dataGaps: string[],
  upcomingMeetings?: { title: string; start: string; attendees?: string[] }[],
): string {
  const top15 = rankedItems.slice(0, 5)  // AI18-R3b: top 5 only (was 15 — fed too much noise to synthesis)

  // BKL-AI22: Compute meetings within next 7 days for meeting-prep-first briefs
  const now = Date.now()
  const in7Days = now + 7 * 24 * 60 * 60 * 1000
  const meetingsNext7Days = (upcomingMeetings ?? [])
    .filter(m => { const t = new Date(m.start).getTime(); return t >= now && t <= in7Days })

  let meetingContext = ''
  if (meetingsNext7Days.length > 0) {
    const meetingList = meetingsNext7Days
      .map(m => `- ${m.title} on ${new Date(m.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}${m.attendees?.length ? ` (${m.attendees.slice(0, 5).join(', ')})` : ''}`)
      .join('\n')
    meetingContext = `\nUPCOMING MEETINGS (next 7 days):\n${meetingList}\n\nIMPORTANT: Lead with ## Meeting Prep (not ## What Changed). For each upcoming meeting, surface: open critical/high support cases to discuss, renewals expiring within 90 days, most recent email thread, at-risk or committed pipeline opportunities. Cross-reference each item from ITEMS TO SYNTHESIZE against these meetings.\n`
  }

  return SYNTHESIS_PROMPT
    .replace(/\{last_interaction_date\}/g, lastInteractionDate)
    .replace('{data_gaps}', dataGaps.length ? dataGaps.join('\n') : 'All sources current.')
    .replace('{ranked_items_json}', JSON.stringify(top15, null, 2))
    + meetingContext
}
