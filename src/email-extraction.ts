/**
 * R20 — Email Intelligence Sub-Pipeline
 *
 * Three layers:
 *   1. Rule-based email classification + action item / competitive mention extraction
 *   2. Deterministic engagement-frequency tracking (detectGoneSilent)
 *   3. Batch orchestrator that combines both
 *
 * The deterministic engagement tracking is the highest-value piece.
 * Classification uses keyword/pattern heuristics (no LLM dependency).
 * See docs/GEMINI-BRIEF-ARCHITECTURE.md §Email Intelligence Sub-Pipeline.
 */

import type { EmailHighlight } from './types.ts'

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface EmailIntelligence {
  classification: 'ACTION_REQUIRED' | 'FYI' | 'RESPONSE_NEEDED'
  action_items: { text: string; owner?: string; deadline?: string; confidence: string }[]
  competitive_mentions: { competitor: string; context: string; risk_level: 'HIGH' | 'MEDIUM' | 'LOW' }[]
  stakeholder_signals: { contact: string; sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'; signal: string }[]
}

export interface ContactHistory {
  email: string
  name?: string
  lastEmailDate: string
  emailCount30dBaseline: number  // first 30d frequency
  emailCountLast30d: number
}

export interface SilentContact {
  email: string
  name?: string
  lastContact: string
  daysSilent: number
  previousFrequency: number
  currentFrequency: number
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Known competitors — lowercase for matching. Extend as needed. */
const COMPETITORS = [
  'vmware', 'aws', 'amazon web services', 'azure', 'microsoft',
  'google cloud', 'gcp', 'oracle', 'ibm', 'suse', 'canonical',
  'ubuntu', 'nutanix', 'tanzu', 'broadcom', 'dell', 'hpe',
  'rancher', 'docker', 'hashicorp', 'terraform', 'pulumi',
  'datadog', 'splunk', 'elastic', 'confluent', 'cloudera',
]

/** Indirect competitor references that signal evaluation context. */
const EVALUATION_PHRASES = [
  'bake-off', 'bakeoff', 'poc with', 'proof of concept',
  'comparing', 'shortlist', 'short-list', 'the other vendor',
  'their platform', 'alternative', 'competitor', 'evaluation',
  'head to head', 'head-to-head', 'switching to', 'migrate from',
  'migrate to', 'replacing', 'displacement',
]

/** Patterns that signal ACTION_REQUIRED classification. */
const ACTION_PATTERNS = [
  /\bplease\b.*\b(do|send|review|complete|submit|approve|confirm|provide|update|check|prepare)\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bneed you to\b/i,
  /\byou should\b/i,
  /\byou must\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eod|eow|end of|next week|this week)\b/i,
  /\bdeadline\b/i,
  /\bdue date\b/i,
  /\baction required\b/i,
  /\burgent\b/i,
  /\basap\b/i,
  /\bimmediately\b/i,
  /\bblocker\b/i,
  /\bblocking\b/i,
]

/** Patterns that signal RESPONSE_NEEDED classification. */
const RESPONSE_PATTERNS = [
  /\?/,
  /\bthoughts\b/i,
  /\bfeedback\b/i,
  /\bwhat do you think\b/i,
  /\blet me know\b/i,
  /\bget back to (me|us)\b/i,
  /\breply\b/i,
  /\brespond\b/i,
  /\byour (input|opinion|view|take)\b/i,
  /\bweigh in\b/i,
  /\badvise\b/i,
]

/** Patterns for extracting action items from email text. */
const ACTION_ITEM_PATTERNS = [
  /\bplease\s+(.{10,80}?)(?:\.|$)/gi,
  /\bcan you\s+(.{10,80}?)(?:\?|$)/gi,
  /\bneed (?:you )?to\s+(.{10,80}?)(?:\.|$)/gi,
  /\bi will\s+(.{10,80}?)(?:\.|$)/gi,
  /\baction:\s*(.{10,80}?)(?:\.|$)/gi,
  /\btodo:\s*(.{10,80}?)(?:\.|$)/gi,
  /\bfollow up\s+(?:on\s+)?(.{10,80}?)(?:\.|$)/gi,
]

/** Deadline extraction patterns. */
const DEADLINE_PATTERNS = [
  /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eod|eow|end of (?:day|week|month)|next (?:week|monday|tuesday|wednesday|thursday|friday)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i,
  /\bdue\s+(?:by\s+|date[:\s]+)?(\S+(?:\s+\S+){0,3})/i,
  /\bdeadline[:\s]+(\S+(?:\s+\S+){0,3})/i,
]

/** Negative sentiment signals from stakeholders. */
const NEGATIVE_SIGNALS = [
  'disappointed', 'frustrated', 'concerned', 'unhappy', 'unacceptable',
  'escalate', 'escalation', 'executive review', 'issue', 'problem',
  'delay', 'missed', 'failure', 'failed', 'broken', 'outage',
  'dissatisfied', 'complaint', 'unresolved',
]

/** Positive sentiment signals. */
const POSITIVE_SIGNALS = [
  'great work', 'thank you', 'thanks', 'appreciate', 'excellent',
  'well done', 'impressive', 'happy with', 'pleased', 'satisfied',
  'looking forward', 'excited', 'approved', 'green light', 'go ahead',
  'champion', 'advocate', 'love',
]

// ── Part 1: Rule-Based Email Classification ─────────────────────────────────

/**
 * Classify a single email using keyword and pattern heuristics.
 * No LLM dependency — purely deterministic rule matching.
 */
export function classifyEmail(subject: string, snippet: string, from: string): EmailIntelligence {
  const text = `${subject} ${snippet}`.toLowerCase()

  // Classification
  const classification = classifyText(text)

  // Action items
  const action_items = extractActionItems(text)

  // Competitive mentions
  const competitive_mentions = detectCompetitiveMentions(text)

  // Stakeholder signals
  const stakeholder_signals = detectStakeholderSignals(from, text)

  return { classification, action_items, competitive_mentions, stakeholder_signals }
}

function classifyText(text: string): EmailIntelligence['classification'] {
  // Check for action patterns first (highest priority)
  for (const pattern of ACTION_PATTERNS) {
    if (pattern.test(text)) return 'ACTION_REQUIRED'
  }
  // Check for response-needed patterns
  for (const pattern of RESPONSE_PATTERNS) {
    if (pattern.test(text)) return 'RESPONSE_NEEDED'
  }
  // Default: FYI
  return 'FYI'
}

function extractActionItems(text: string): EmailIntelligence['action_items'] {
  const items: EmailIntelligence['action_items'] = []
  const seen = new Set<string>()

  for (const pattern of ACTION_ITEM_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1]?.trim()
      if (!raw || raw.length < 10) continue
      const normalized = raw.toLowerCase()
      if (seen.has(normalized)) continue
      seen.add(normalized)

      // Try to extract a deadline from surrounding context
      const deadline = extractDeadline(text)

      items.push({
        text: raw,
        confidence: 'MEDIUM',
        ...(deadline ? { deadline } : {}),
      })
    }
  }

  return items
}

function extractDeadline(text: string): string | undefined {
  for (const pattern of DEADLINE_PATTERNS) {
    const match = pattern.exec(text)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

function detectCompetitiveMentions(text: string): EmailIntelligence['competitive_mentions'] {
  const mentions: EmailIntelligence['competitive_mentions'] = []
  const seen = new Set<string>()

  // Direct competitor name matches
  for (const competitor of COMPETITORS) {
    if (text.includes(competitor) && !seen.has(competitor)) {
      seen.add(competitor)
      // Extract surrounding context (up to 120 chars around the mention)
      const idx = text.indexOf(competitor)
      const start = Math.max(0, idx - 40)
      const end = Math.min(text.length, idx + competitor.length + 80)
      const context = text.slice(start, end).trim()

      // Determine risk level based on evaluation language proximity
      const hasEvalContext = EVALUATION_PHRASES.some(p => text.includes(p))
      const risk_level: 'HIGH' | 'MEDIUM' | 'LOW' = hasEvalContext ? 'HIGH' : 'MEDIUM'

      mentions.push({ competitor, context, risk_level })
    }
  }

  // Check for indirect evaluation phrases even without a named competitor
  if (mentions.length === 0) {
    for (const phrase of EVALUATION_PHRASES) {
      if (text.includes(phrase)) {
        const idx = text.indexOf(phrase)
        const start = Math.max(0, idx - 40)
        const end = Math.min(text.length, idx + phrase.length + 80)
        const context = text.slice(start, end).trim()
        mentions.push({
          competitor: '(unnamed)',
          context,
          risk_level: 'MEDIUM',
        })
        break  // One unnamed mention is enough
      }
    }
  }

  return mentions
}

function detectStakeholderSignals(from: string, text: string): EmailIntelligence['stakeholder_signals'] {
  const signals: EmailIntelligence['stakeholder_signals'] = []

  // Check negative signals
  for (const signal of NEGATIVE_SIGNALS) {
    if (text.includes(signal)) {
      signals.push({ contact: from, sentiment: 'NEGATIVE', signal })
      break  // One negative signal per email is enough
    }
  }

  // Check positive signals (only if no negative found)
  if (signals.length === 0) {
    for (const signal of POSITIVE_SIGNALS) {
      if (text.includes(signal)) {
        signals.push({ contact: from, sentiment: 'POSITIVE', signal })
        break
      }
    }
  }

  // Default: no signal (NEUTRAL is only added if there's something notable)
  return signals
}

// ── Part 2: Engagement Frequency Tracking (Deterministic) ───────────────────

/**
 * Detect contacts who have gone silent.
 * Alerts on >50% frequency drop from baseline OR 14+ day gap.
 * This is the highest-value piece of the email intelligence pipeline.
 */
export function detectGoneSilent(contacts: ContactHistory[]): SilentContact[] {
  const now = Date.now()
  return contacts
    .filter(c => {
      const daysSince = (now - new Date(c.lastEmailDate).getTime()) / (1000 * 60 * 60 * 24)
      return (c.emailCountLast30d < c.emailCount30dBaseline * 0.5) || daysSince > 14
    })
    .map(c => ({
      email: c.email,
      name: c.name,
      lastContact: c.lastEmailDate,
      daysSilent: Math.floor((now - new Date(c.lastEmailDate).getTime()) / (1000 * 60 * 60 * 24)),
      previousFrequency: c.emailCount30dBaseline,
      currentFrequency: c.emailCountLast30d,
    }))
}

// ── Part 3: Build Contact History from Raw Emails ───────────────────────────

/**
 * Build contact history from raw email metadata.
 * Groups emails by sender, computes first-30d baseline vs last-30d frequency.
 */
export function buildContactHistory(
  emails: { from: string; to?: string; date: string }[],
): ContactHistory[] {
  if (emails.length === 0) return []

  // Group emails by sender address
  const bySender = new Map<string, { dates: Date[]; name?: string }>()

  for (const email of emails) {
    // Parse "Name <addr>" or bare "addr" format
    const { address, name } = parseEmailAddress(email.from)
    if (!address) continue

    const entry = bySender.get(address) ?? { dates: [], name }
    entry.dates.push(new Date(email.date))
    if (name && !entry.name) entry.name = name
    bySender.set(address, entry)
  }

  const now = new Date()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000

  // Sort all dates to find the global earliest email for baseline window
  const results: ContactHistory[] = []

  for (const [address, { dates, name }] of bySender) {
    if (dates.length === 0) continue
    dates.sort((a, b) => a.getTime() - b.getTime())

    const earliest = dates[0]
    const latest = dates[dates.length - 1]

    // Baseline: count emails in the first 30 days from the first email
    const baselineEnd = new Date(earliest.getTime() + thirtyDaysMs)
    const emailCount30dBaseline = dates.filter(d => d <= baselineEnd).length

    // Current: count emails in the last 30 days from now
    const last30dStart = new Date(now.getTime() - thirtyDaysMs)
    const emailCountLast30d = dates.filter(d => d >= last30dStart).length

    results.push({
      email: address,
      name,
      lastEmailDate: latest.toISOString(),
      emailCount30dBaseline,
      emailCountLast30d,
    })
  }

  return results
}

/**
 * Parse "Display Name <email@domain.com>" or bare "email@domain.com".
 */
function parseEmailAddress(raw: string): { address: string; name?: string } {
  if (!raw) return { address: '' }
  const angleMatch = raw.match(/^(.+?)\s*<([^>]+)>$/)
  if (angleMatch) {
    return {
      name: angleMatch[1].replace(/^["']|["']$/g, '').trim() || undefined,
      address: angleMatch[2].trim().toLowerCase(),
    }
  }
  return { address: raw.trim().toLowerCase() }
}

// ── Part 4: Batch Orchestrator ──────────────────────────────────────────────

/**
 * Extract intelligence from a batch of EmailHighlight records.
 * Classifies the 10 most recent emails and detects silent contacts.
 */
export async function extractEmailIntelligence(emails: EmailHighlight[]): Promise<{
  classifications: Map<string, EmailIntelligence>
  silentContacts: SilentContact[]
}> {
  // 1. Build contact history and detect silent contacts
  const rawEmails = emails.map(e => ({
    from: e.from,
    date: e.date,
  }))
  const contacts = buildContactHistory(rawEmails)
  const silentContacts = detectGoneSilent(contacts)

  // 2. Classify recent/important emails (top 10 by date, rule-based)
  const sorted = [...emails].sort((a, b) =>
    new Date(b.date).getTime() - new Date(a.date).getTime(),
  )
  const recentEmails = sorted.slice(0, 10)
  const classifications = new Map<string, EmailIntelligence>()

  for (const email of recentEmails) {
    try {
      const key = `${email.from}|${email.subject}|${email.date}`
      const intel = classifyEmail(email.subject, email.snippet, email.from)
      classifications.set(key, intel)
    } catch {
      // Skip emails that fail classification — never block the pipeline
    }
  }

  return { classifications, silentContacts }
}
