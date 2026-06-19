/**
 * Meeting Prep Brief (Instant) Quality Validator — ADR-024, Consumer Contract v1.0
 *
 * Validates the instant meeting prep brief output (from meeting-prep-intelligence.ts).
 * This is the BRIEF validator, not the full meeting prep validator.
 *
 * Checks:
 * - talking-points-count: exactly 3 talking points (required)
 * - talking-points-evidence: each talking point references specific evidence (required)
 * - talking-points-who-what-when: each talking point includes WHO/WHAT/BY WHEN (required)
 * - challenger-insight: Challenger insight present (required)
 * - dollar-connection: at least 1 talking point mentions a dollar figure or financial term (required)
 * - no-placeholder-text: no TBD/TODO/placeholder text (required)
 * - min-content-depth: each talking point >= 30 words (recommended)
 * - stakeholder-paths: >= 2 stakeholder engagement paths with names (recommended)
 *
 * Threshold: 80
 * GitHub Issue #849
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'meeting-prep-brief'
const PASS_THRESHOLD = 80

/** Placeholder patterns that indicate incomplete content */
const PLACEHOLDER_PATTERNS = [
  /\bTBD\b/i,
  /\[Insert\b/i,
  /\bTODO\b/i,
  /\bplaceholder\b/i,
  /\[fill in\]/i,
  /\[your\b/i,
]

/** Financial terms that indicate dollar connection */
const FINANCIAL_PATTERNS = [
  /\$/,
  /\brevenue\b/i,
  /\bpipeline\b/i,
  /\brenewal\b/i,
  /\bsavings\b/i,
  /\bROI\b/,
  /\bcost\b/i,
  /\bACV\b/,
  /\bTCV\b/,
  /\bexpansion\b/i,
  /\binvestment\b/i,
  /\bbudget\b/i,
  /\b\d+[KkMm]\b/,
]

/** Evidence patterns — case numbers, subscription IDs, deal names, dates */
const EVIDENCE_PATTERNS = [
  /\b\d{7,}\b/,                        // case/ticket numbers (7+ digits)
  /\bcase\s*#?\s*\d+/i,               // "case #12345" or "case 12345"
  /\b[A-Z]{2,}-\d+\b/,               // JIRA-style IDs
  /\b(RHEL|OpenShift|Ansible|AAP|RHOCP|RHOAI)\b/, // RH product names
  /\b(Q[1-4]\s*20\d{2}|20\d{2})\b/,  // dates/quarters
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
]

/** WHO/WHAT/WHEN patterns */
const WHO_PATTERNS = [
  /\b[A-Z][a-z]+\s[A-Z][a-z]+\b/,     // proper names (First Last)
  /\b(ask|contact|engage|reach out to|discuss with|present to|follow up with)\b/i,
]

const WHEN_PATTERNS = [
  /\b(by|before|after|during|within|next|this)\s+(week|month|quarter|meeting|call|Q[1-4])/i,
  /\b(immediately|ASAP|today|tomorrow)\b/i,
  /\b\d{1,2}[\/-]\d{1,2}/,            // date patterns
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
]

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length
}

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // Parse lines — talking points are non-[CHALLENGER] non-empty lines
  const lines = output
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)

  const challengerLine = lines.find(l =>
    l.startsWith('[CHALLENGER]:') || l.startsWith('[CHALLENGER]')
  )
  const talkingPointLines = lines.filter(l =>
    !l.startsWith('[CHALLENGER]:') && !l.startsWith('[CHALLENGER]')
  )

  // 1. Talking points count — exactly 3
  checks.push({
    name: 'talking-points-count',
    passed: talkingPointLines.length === 3,
    expected: 'Exactly 3 talking points',
    actual: `${talkingPointLines.length} talking points`,
    severity: 'required',
  })

  // 2. Talking points evidence — each references specific evidence
  const pointsWithEvidence = talkingPointLines.filter(tp =>
    EVIDENCE_PATTERNS.some(p => p.test(tp))
  )
  checks.push({
    name: 'talking-points-evidence',
    passed: pointsWithEvidence.length >= Math.min(talkingPointLines.length, 3),
    expected: 'Each talking point references specific evidence (case number, product name, date, or deal)',
    actual: `${pointsWithEvidence.length} of ${talkingPointLines.length} have evidence references`,
    severity: 'required',
  })

  // 3. Talking points WHO/WHAT/WHEN
  const pointsWithWho = talkingPointLines.filter(tp =>
    WHO_PATTERNS.some(p => p.test(tp))
  )
  const pointsWithWhen = talkingPointLines.filter(tp =>
    WHEN_PATTERNS.some(p => p.test(tp))
  )
  checks.push({
    name: 'talking-points-who-what-when',
    passed: pointsWithWho.length >= 2 && pointsWithWhen.length >= 1,
    expected: 'Talking points include WHO (>= 2 with names/actions) and WHEN (>= 1 with timeframe)',
    actual: `${pointsWithWho.length} with WHO, ${pointsWithWhen.length} with WHEN`,
    severity: 'required',
  })

  // 4. Challenger insight present
  checks.push({
    name: 'challenger-insight',
    passed: !!challengerLine && challengerLine.length > 20,
    expected: 'Challenger insight present and substantive (> 20 chars)',
    actual: challengerLine
      ? `${challengerLine.length} chars`
      : 'no [CHALLENGER] line found',
    severity: 'required',
  })

  // 5. Dollar connection — at least 1 talking point mentions financial terms
  const pointsWithDollar = talkingPointLines.filter(tp =>
    FINANCIAL_PATTERNS.some(p => p.test(tp))
  )
  checks.push({
    name: 'dollar-connection',
    passed: pointsWithDollar.length >= 1,
    expected: 'At least 1 talking point mentions dollar figure or financial term',
    actual: `${pointsWithDollar.length} talking points with financial terms`,
    severity: 'required',
  })

  // 6. No placeholder text
  const foundPlaceholders = PLACEHOLDER_PATTERNS.filter(p => p.test(output))
  checks.push({
    name: 'no-placeholder-text',
    passed: foundPlaceholders.length === 0,
    expected: 'No placeholder text (TBD, [Insert], TODO)',
    actual: foundPlaceholders.length === 0
      ? 'no placeholders found'
      : `found: ${foundPlaceholders.map(p => p.source).join(', ')}`,
    severity: 'required',
  })

  // 7. Minimum content depth — each talking point >= 30 words
  const thinPoints = talkingPointLines
    .map((tp, i) => ({ index: i + 1, words: countWords(tp) }))
    .filter(p => p.words < 30)
  checks.push({
    name: 'min-content-depth',
    passed: thinPoints.length === 0,
    expected: 'Each talking point >= 30 words',
    actual: thinPoints.length === 0
      ? 'all talking points meet minimum depth'
      : `thin points: ${thinPoints.map(p => `#${p.index} (${p.words} words)`).join(', ')}`,
    severity: 'recommended',
  })

  // 8. Stakeholder paths — this check is run on the full brief JSON, not raw text.
  // For text-only validation, we check if the output mentions multiple distinct names.
  const nameMatches = output.match(/\b[A-Z][a-z]+\s[A-Z][a-z]+\b/g) ?? []
  const uniqueNames = new Set(nameMatches)
  checks.push({
    name: 'stakeholder-paths',
    passed: uniqueNames.size >= 2,
    expected: '>= 2 stakeholder engagement paths with names',
    actual: `${uniqueNames.size} unique names found`,
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const meetingPrepBriefValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
