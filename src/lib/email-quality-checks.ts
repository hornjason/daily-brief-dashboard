/**
 * Email Quality Checks — validates rendered emails against council-validated rules.
 * Each check takes email data and returns pass/fail.
 * Used by campaign-html-template.ts to render dynamic ☑/☒ checklist.
 */

export interface EmailQualityResult {
  wordLimit: boolean
  techObservations: boolean
  statementsOnly: boolean
  bulletLinks: boolean
  namedPeerMetric: boolean
  competitorSwap: boolean
  creepyLineClean: boolean
  subjectClean: boolean
  noFiller: boolean
  relationshipContext: boolean
}

export interface EmailCheckInput {
  body: string
  subject: string
  tier: 'executive' | 'manager'
  wordBudget: { exec: number; manager: number }
}

const FIRMOGRAPHIC_PATTERN = /founded in \d{4}|headquartered in|approximately \d+ employees|\d+ employees/i

const PRODUCT_SUBJECT_PATTERN = /\b(Red Hat|Ansible|OpenShift|RHEL)\b/i

const FILLER_PATTERN = /\b(leverage|synergy|cutting-edge|game-changing|best-in-class|world-class|seamlessly|holistic)\b/i

const CREEPY_PATTERNS = [
  /pipeline\s+opportunit/i,
  /pipeline\s+value/i,
  /\$\d[\d,.]*[kKmMbB]?\s+pipeline/i,
  /\$\d[\d,.]*[kKmMbB]?\s+deal/i,
  /pending\s+\$/i,
  /support\s+case/i,
  /support\s+ticket/i,
  /case\s+#\d/i,
  /ticket\s+#\d/i,
  /\d+\s+(?:RHEL\s+)?subscriptions?\b/i,
  /\d+\s+nodes?\b/i,
  /\d+\s+instances?\b/i,
  /subscription\s+count/i,
  /laid\s+off\s+\d/i,
  /headcount\s+reduction/i,
  /workforce\s+reduction/i,
  /\$\d[\d,.]*[kKmMbB]?\s+renewal/i,
  /renewal\s+of\s+\$/i,
]

const RELATIONSHIP_PRODUCT_PATTERN = /Red Hat Enterprise Linux|Red Hat OpenShift|Red Hat Ansible|RHEL|OpenShift|Ansible Automation Platform/i
const RELATIONSHIP_CONTEXT_PATTERN = /already rely on|already use|existing|foundation|ship on|run on|built on/i

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

export function runEmailQualityCheck(input: EmailCheckInput): EmailQualityResult {
  const plainBody = stripHtml(input.body)
  const maxWords = input.tier === 'executive' ? input.wordBudget.exec : input.wordBudget.manager
  const wordCount = countWords(plainBody)

  // 1. Word limit
  const wordLimit = wordCount <= maxWords

  // 2. Tech observations only — no firmographic facts
  const techObservations = !FIRMOGRAPHIC_PATTERN.test(plainBody)

  // 3. Statements only — no question marks except in last paragraph (CTA)
  const paragraphs = plainBody.split(/\n\n+/).filter(p => p.trim().length > 0)
  const nonCtaParagraphs = paragraphs.slice(0, -1)
  const statementsOnly = !nonCtaParagraphs.some(p => p.includes('?'))

  // 4. Per-bullet links — every bullet line has a URL
  const bulletLines = input.body.split('\n').filter(l => /^[•\-*]\s|^\s*[•\-*]\s/.test(stripHtml(l).trim()))
  const bulletLinks = bulletLines.length === 0 || bulletLines.every(l => /<a\s+href/i.test(l) || /\[[^\]]+\]\(https?:\/\//i.test(l))

  // 5. Named peer with metric — body contains a capitalized company name AND ($ or %)
  const hasPeerName = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/.test(plainBody)
  const hasPeerMetric = /\$[\d,.]+|\d+%/.test(plainBody)
  const namedPeerMetric = hasPeerName && hasPeerMetric

  // 6. Competitor-swap test — body mentions Red Hat or a specific RH product
  const competitorSwap = /Red Hat|Ansible|OpenShift|RHEL|Enterprise Linux/i.test(plainBody)

  // 7. Creepy line clean
  const creepyLineClean = !CREEPY_PATTERNS.some(p => p.test(plainBody))

  // 8. Subject clean — no product names in subject
  const subjectClean = !PRODUCT_SUBJECT_PATTERN.test(input.subject)

  // 9. No filler phrases
  const noFiller = !FILLER_PATTERN.test(plainBody)

  // 10. Relationship context — mentions existing RH products with relationship language
  const relationshipContext = RELATIONSHIP_PRODUCT_PATTERN.test(plainBody) && RELATIONSHIP_CONTEXT_PATTERN.test(plainBody)

  return {
    wordLimit,
    techObservations,
    statementsOnly,
    bulletLinks,
    namedPeerMetric,
    competitorSwap,
    creepyLineClean,
    subjectClean,
    noFiller,
    relationshipContext,
  }
}

export interface ChecklistItem {
  key: keyof EmailQualityResult
  label: string
}

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  { key: 'wordLimit', label: 'Word limits: Executive ≤{exec} words | Manager ≤{manager} words' },
  { key: 'techObservations', label: 'Technical observations only — no firmographic facts' },
  { key: 'statementsOnly', label: 'Statements only — no questions except CTA' },
  { key: 'bulletLinks', label: 'Per-bullet links to Red Hat product pages' },
  { key: 'namedPeerMetric', label: 'Named peer company with concrete metric' },
  { key: 'competitorSwap', label: 'Competitor-swap test: Red Hat-specific language' },
  { key: 'creepyLineClean', label: 'Creepy line check: no internal data the recipient wouldn\'t expect' },
  { key: 'subjectClean', label: 'Subject = observation about their world (no product names)' },
  { key: 'noFiller', label: 'No filler phrases' },
  { key: 'relationshipContext', label: 'Relationship context: ONE sentence about existing Red Hat products' },
]

export function toQualityChecks(results: EmailQualityResult[]): Array<{ name: string; passed: boolean; expected: string; actual: string; severity: 'required' | 'recommended' }> {
  const emailCount = results.length
  if (emailCount === 0) return []
  const allPass = (check: keyof EmailQualityResult) => results.every(r => r[check])
  const countPass = (check: keyof EmailQualityResult) => results.filter(r => r[check]).length

  return CHECKLIST_ITEMS.map(item => {
    const passed = allPass(item.key)
    const count = countPass(item.key)
    return {
      name: `email-quality-${item.key}`,
      passed,
      expected: item.label,
      actual: passed ? 'all emails pass' : `${count}/${emailCount} pass`,
      severity: 'required' as const,
    }
  })
}

export function renderQualityChecklist(
  results: EmailQualityResult[],
  wordBudget: { exec: number; manager: number },
): string {
  const emailCount = results.length
  const allPass = (check: keyof EmailQualityResult) =>
    results.every(r => r[check])
  const countPass = (check: keyof EmailQualityResult) =>
    results.filter(r => r[check]).length

  const rows = CHECKLIST_ITEMS.map(item => {
    const label = item.label
      .replace('{exec}', String(wordBudget.exec))
      .replace('{manager}', String(wordBudget.manager))
    const passed = emailCount === 0 || allPass(item.key)
    const count = countPass(item.key)
    const icon = passed ? '☑' : '☒'
    const detail = passed || emailCount === 0 ? '' : ` (${count}/${emailCount})`
    return `  <tr><td style="padding: 2px 0;">${icon} ${label}${detail}</td></tr>`
  })

  return rows.join('\n')
}
