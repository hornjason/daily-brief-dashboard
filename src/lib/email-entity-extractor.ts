/**
 * Email Entity Extractor — GitHub Issue #476
 * Pure keyword/regex extraction from email body text. NO Gemini.
 * Extracts tech mentions, product mentions, competitor mentions, and action items.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EmailEntities {
  techMentions: string[]        // Technologies from solution-plays triggers
  productMentions: string[]     // Red Hat product names
  competitiveMentions: string[] // Competitor names
  actionItems: string[]         // Action patterns found
}

// ── Solution plays trigger technologies (lazy-loaded, cached in memory) ──────

let _triggerTechs: string[] | null = null

function loadTriggerTechnologies(): string[] {
  if (_triggerTechs) return _triggerTechs

  try {
    const solutionPlaysPath = resolve(
      process.env.CONFIG_TEMPLATES_DIR ?? 'config-templates',
      'solution-plays.json'
    )
    const data = JSON.parse(readFileSync(solutionPlaysPath, 'utf-8'))
    const techSet = new Set<string>()
    for (const play of data.plays ?? []) {
      for (const tech of play.triggerTechnologies ?? []) {
        techSet.add(tech)
      }
    }
    _triggerTechs = [...techSet]
    return _triggerTechs
  } catch {
    // Fallback if solution-plays.json is unavailable
    _triggerTechs = []
    return _triggerTechs
  }
}

// ── Product keywords (stable Red Hat product list) ───────────────────────────

const PRODUCT_KEYWORDS: string[] = [
  'RHEL', 'OpenShift', 'Ansible', 'AAP', 'OCP', 'RHACS', 'RHACM',
  'Satellite', 'Quay', 'RHDH', 'OpenShift AI', 'RHOAI',
  'OpenShift Virtualization', 'Red Hat Enterprise Linux',
]

// ── Competitor keywords ──────────────────────────────────────────────────────

const COMPETITOR_KEYWORDS: string[] = [
  'VMware', 'Tanzu', 'AWS', 'Azure', 'Google Cloud', 'Terraform',
  'CrowdStrike', 'Palo Alto', 'Splunk', 'ServiceNow', 'Docker',
  'Rancher', 'SUSE',
]

// ── Action patterns ──────────────────────────────────────────────────────────

const ACTION_PATTERN = /\b(POC|proof of concept|follow.?up|proposal|demo|schedule|next steps|meeting|call|trial|evaluation|assessment)\b/gi

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Short keywords (3 chars or fewer) require case-sensitive matching
 * to avoid false positives (e.g., "Go" matching "going").
 * Longer keywords use case-insensitive word-boundary matching.
 */
function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = escapeRegex(keyword)
  if (keyword.length <= 3) {
    // Case-sensitive for short keywords
    const re = new RegExp('\\b' + escaped + '\\b')
    return re.test(text)
  }
  // Case-insensitive for longer keywords
  const re = new RegExp('\\b' + escaped + '\\b', 'i')
  return re.test(text)
}

// ── Main extraction function ─────────────────────────────────────────────────

export function extractEmailEntities(bodyText: string, subjectLine: string): EmailEntities {
  const fullText = subjectLine + ' ' + bodyText

  // Tech mentions from solution-plays triggers
  const triggerTechs = loadTriggerTechnologies()
  const techMentions = [...new Set(
    triggerTechs.filter(tech => matchesKeyword(fullText, tech))
  )]

  // Product mentions
  const productMentions = [...new Set(
    PRODUCT_KEYWORDS.filter(product => matchesKeyword(fullText, product))
  )]

  // Competitor mentions
  const competitiveMentions = [...new Set(
    COMPETITOR_KEYWORDS.filter(comp => matchesKeyword(fullText, comp))
  )]

  // Action items — deduplicate by lowercased match
  const actionSet = new Set<string>()
  let match: RegExpExecArray | null
  const actionRe = new RegExp(ACTION_PATTERN.source, ACTION_PATTERN.flags)
  while ((match = actionRe.exec(fullText)) !== null) {
    actionSet.add(match[1].toLowerCase())
  }
  const actionItems = [...actionSet]

  return { techMentions, productMentions, competitiveMentions, actionItems }
}

/** Reset cached trigger techs — for testing only */
export function _resetTriggerTechsForTesting(): void {
  _triggerTechs = null
}
