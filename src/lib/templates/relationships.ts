/**
 * Key Relationships template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { AccountTeamMember } from '../../types.ts'

/**
 * Key Relationships section: account team table.
 * Not signal-derived — takes AccountTeamMember array from getAccountTeam().
 *
 * Renders: Name, Role, Focus Area
 */
export function templateKeyRelationships(team?: AccountTeamMember[]): string | null {
  if (!team || team.length === 0) return null

  const roleLabels: Record<string, string> = {
    ae: 'Account Executive',
    asa: 'Solution Architect',
    ssp: 'Sales Specialist',
    ssa: 'Specialist SA',
    manager: 'Manager',
  }

  const focusAreas: Record<string, string> = {
    ae: 'Primary relationship, commercial',
    asa: 'Technical strategy, architecture',
    ssp: 'Product specialization, sales',
    ssa: 'Technical deep-dive, specialization',
    manager: 'Account oversight',
  }

  const rows: string[] = []
  rows.push('| Name | Role | Focus Area |')
  rows.push('|------|------|------------|')

  for (const member of team) {
    const roleLabel = roleLabels[member.role] ?? member.title
    const focusArea = focusAreas[member.role] ?? 'Account support'
    rows.push(`| ${member.name} | ${roleLabel} | ${focusArea} |`)
  }

  return rows.length > 2 ? rows.join('\n') : null
}
