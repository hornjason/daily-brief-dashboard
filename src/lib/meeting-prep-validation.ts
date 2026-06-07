/**
 * src/lib/meeting-prep-validation.ts
 * Post-generation validation for meeting prep output (#643)
 *
 * Validates that Gemini output doesn't fabricate:
 * - Case numbers not present in evidence blocks
 * - Dollar amounts not present in evidence blocks
 * - Person names not present in evidence blocks or account team
 */

import type { EvidenceBlock } from './evidence-block-builder.ts'
import type { AccountTeamMember } from '../types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  warnings: string[]
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate meeting prep output against evidence blocks and team data.
 * Catches fabricated case numbers, dollar amounts, and person names.
 */
export function validateMeetingPrepOutput(
  output: string,
  evidenceBlocks: EvidenceBlock[],
  team: AccountTeamMember[],
): ValidationResult {
  if (!output || output.trim().length === 0) {
    return { valid: true, warnings: [] }
  }

  const warnings: string[] = []

  // Collect all known facts from evidence blocks
  const allFacts = evidenceBlocks.flatMap(b => b.evidenceTrail.map(e => e.fact))
  const allLevers = evidenceBlocks.flatMap(b => b.availableLevers)
  const allTeamContexts = evidenceBlocks.map(b => b.teamContext)
  const allProposedAsks = evidenceBlocks.map(b => b.proposedAsk)
  const allInputText = [
    ...allFacts,
    ...allLevers.map(l => `${l.name} ${l.description}`),
    ...allTeamContexts,
    ...allProposedAsks,
  ].join(' ')

  // AC-9: Validate case numbers
  warnings.push(...validateCaseNumbers(output, allInputText))

  // AC-10: Validate dollar amounts
  warnings.push(...validateDollarAmounts(output, allInputText))

  // AC-11: Validate person names
  warnings.push(...validatePersonNames(output, evidenceBlocks, team))

  return {
    valid: warnings.length === 0,
    warnings,
  }
}

// ── Validators ──────────────────────────────────────────────────────────────

/**
 * Find all case numbers in output (8-digit numbers preceded by "case" or similar).
 * Flag any not found in the evidence input.
 */
function validateCaseNumbers(output: string, inputText: string): string[] {
  const warnings: string[] = []

  // Match patterns like "Case 12345678", "case #12345678", "case: 12345678"
  const casePattern = /\b(?:case|ticket|incident)\s*[#:]?\s*(\d{7,10})\b/gi
  let match: RegExpExecArray | null

  while ((match = casePattern.exec(output)) !== null) {
    const caseNumber = match[1]
    if (!inputText.includes(caseNumber)) {
      warnings.push(`Fabricated case number: ${caseNumber} not found in evidence data`)
    }
  }

  // Also catch bare 8-digit numbers that look like case numbers
  const bareNumberPattern = /\b(\d{8})\b/g
  while ((match = bareNumberPattern.exec(output)) !== null) {
    const num = match[1]
    // Skip if already caught by case pattern or if it's a date-like pattern (20260630)
    if (num.startsWith('20') && parseInt(num.slice(4, 6)) <= 12) continue
    if (!inputText.includes(num)) {
      // Check if not already warned about
      const alreadyWarned = warnings.some(w => w.includes(num))
      if (!alreadyWarned) {
        warnings.push(`Fabricated case/reference number: ${num} not found in evidence data`)
      }
    }
  }

  return warnings
}

/**
 * Find all dollar amounts in output.
 * Flag any not found in the evidence input.
 */
function validateDollarAmounts(output: string, inputText: string): string[] {
  const warnings: string[] = []

  // Match patterns like "$150,000", "$5M", "$2.5M", "$1.2B"
  const dollarPattern = /\$[\d,]+(?:\.\d+)?(?:\s*[MBKmkb](?:illion)?)?/g
  let match: RegExpExecArray | null

  while ((match = dollarPattern.exec(output)) !== null) {
    const amount = match[0]
    // Normalize the amount for comparison
    const normalizedAmount = normalizeDollarAmount(amount)

    // Check if this amount appears in input (exact or normalized)
    if (!inputText.includes(amount) && !inputText.includes(normalizedAmount)) {
      // Also try matching just the numeric part
      const numericPart = amount.replace(/[$,]/g, '').trim()
      if (!inputText.includes(numericPart)) {
        warnings.push(`Fabricated dollar amount: ${amount} not found in evidence data`)
      }
    }
  }

  return warnings
}

/**
 * Normalize dollar amounts for comparison.
 * "$5M" -> "$5,000,000", "$2.5M" -> "$2,500,000"
 */
function normalizeDollarAmount(amount: string): string {
  const cleaned = amount.replace(/\$/g, '').trim()

  // Handle M/B/K suffixes
  const suffixMatch = cleaned.match(/^([\d,.]+)\s*([MBKmkb])/i)
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1].replace(/,/g, ''))
    const suffix = suffixMatch[2].toUpperCase()
    const multiplier = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : 1_000
    return `$${(num * multiplier).toLocaleString()}`
  }

  return amount
}

/**
 * Find person-like names in the output that aren't in the team or evidence blocks.
 * Uses simple heuristic: capitalized multi-word sequences that look like names.
 */
function validatePersonNames(
  output: string,
  evidenceBlocks: EvidenceBlock[],
  team: AccountTeamMember[],
): string[] {
  const warnings: string[] = []

  // Build set of known names
  const knownNames = new Set<string>()
  for (const member of team) {
    knownNames.add(member.name.toLowerCase())
    // Also add first name and last name separately for partial matching
    const parts = member.name.split(/\s+/)
    for (const part of parts) {
      knownNames.add(part.toLowerCase())
    }
  }

  // Add names from evidence block team context
  for (const block of evidenceBlocks) {
    // Extract name from "Carol Davis (RHEL SSP)" format
    const nameMatch = block.teamContext.match(/^([^(]+)/)
    if (nameMatch) {
      knownNames.add(nameMatch[1].trim().toLowerCase())
    }
  }

  // Common non-name capitalized phrases/words to skip
  const skipWords = new Set([
    // Section headers
    'meeting', 'objective', 'recommended', 'plays', 'open', 'items', 'action',
    'changed', 'who', 'value', 'play', 'discussion', 'questions',
    'pipeline', 'opportunities', 'recent', 'interactions', 'room',
    // Organization / product names
    'red', 'hat', 'enterprise', 'linux', 'openshift', 'ansible', 'rhel',
    'container', 'platform', 'automation', 'cloud', 'native',
    'aws', 'azure', 'google', 'oracle', 'microsoft', 'cisco',
    // Titles and roles
    'account', 'executive', 'solution', 'architect', 'manager',
    'ssp', 'ssa', 'asa', 'vp', 'cto', 'cfo', 'ceo', 'cio', 'ciso',
    'engineering', 'director', 'senior', 'principal', 'lead',
    // Time / calendar
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
    // Action / meeting related
    'pre', 'post', 'during', 'prep', 'command', 'message', 'purpose',
    'schedule', 'migration', 'security', 'compliance', 'infrastructure',
    'strategic', 'position', 'current', 'priorities', 'expansion',
    // Technical terms
    'kubernetes', 'satellite', 'virtualization', 'storage', 'middleware',
    'data', 'foundation', 'advanced', 'cluster',
  ])

  // Find capitalized multi-word patterns that look like person names
  // Pattern: Honorific? + Capitalized word + Capitalized word(s)
  // Matches: "John Smith", "Dr. John Smith", "Mary O'Brien", "Ian McAllister"
  // Uses [ \t] (not \s) to avoid matching across newlines
  const namePattern = /\b((?:Dr\.|Mr\.|Ms\.|Mrs\.)[ \t]+)?((?:(?:Mc|Mac|O')?[A-Z][a-z]+)(?:[ \t]+(?:(?:Mc|Mac|O')?[A-Z][a-z]+))+)\b/g
  let match: RegExpExecArray | null

  while ((match = namePattern.exec(output)) !== null) {
    const honorific = match[1]?.trim() ?? ''
    const fullMatch = match[0].trim()
    const nameCandidate = match[2].trim()
    const candidateLower = nameCandidate.toLowerCase()

    // Split into individual words
    const words = candidateLower.split(/\s+/)

    // Skip if ALL words are common non-name words
    if (words.every(w => skipWords.has(w))) continue

    // Skip 4+ word phrases (likely section headers, not names)
    if (words.length > 3) continue

    // Check if this is a known person (full name match)
    if (knownNames.has(candidateLower)) continue

    // Check if individual parts match known name parts (e.g., first+last name match)
    if (words.every(w => knownNames.has(w))) continue

    // If most words are skip-words (e.g., "RHEL Migration"), it's not a name
    const nonSkipWords = words.filter(w => !skipWords.has(w))
    if (nonSkipWords.length === 0) continue

    // This looks like a fabricated name
    const displayName = honorific ? `${honorific} ${nameCandidate}` : fullMatch
    warnings.push(`Potentially fabricated person name: "${displayName}" not found in evidence or team data`)
  }

  return warnings
}
