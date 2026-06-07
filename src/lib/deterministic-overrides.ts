/**
 * src/lib/deterministic-overrides.ts
 * Deterministic override pipeline for meeting prep output (#657)
 *
 * Extracts the deterministic pipeline section, attendee list, and
 * post-generation validation from meeting-prep-service.ts into a
 * single composable function.
 *
 * Dependencies:
 *   - meeting-prep-validation.ts — validateMeetingPrepOutput
 *   - evidence-block-builder.ts — EvidenceBlock type
 *   - attendee-profile-cache.ts — AttendeeProfile type
 *   - types.ts — AccountTeamMember, CalendarEvent types
 */

import { validateMeetingPrepOutput } from './meeting-prep-validation.ts'
import type { EvidenceBlock } from './evidence-block-builder.ts'
import type { AttendeeProfile } from './attendee-profile-cache.ts'
import type { AccountTeamMember } from '../types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeterministicOverrideContext {
  prepContent: string
  signalData: { registrySignals?: any[] }
  meeting: { attendees?: string[]; attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }> }
  accountTeam: AccountTeamMember[]
  resolvedProfiles: AttendeeProfile[]
  filteredEvidenceBlocks: EvidenceBlock[]
  templateResult: { deterministic: string }
  getAttendeeDisplayName: (meeting: any, email: string) => string
  getEnrichedAttendeeName: (email: string, meeting: any, profiles: AttendeeProfile[]) => string
  customerName: string
}

export interface DeterministicOverrideResult {
  content: string
  validationWarnings: string[]
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply deterministic overrides to Gemini-generated meeting prep content.
 *
 * Steps performed:
 * 1. Replace pipeline section with real data from pipeline signals (Step 4c)
 * 2. Replace attendee list with clean calendar data (Step 4d)
 * 3. Post-generation validation — flag fabricated data points (Step 4f)
 */
export function applyDeterministicOverrides(ctx: DeterministicOverrideContext): DeterministicOverrideResult {
  let prepContent = ctx.prepContent
  const validationWarnings: string[] = []

  // ── Step 4c: Deterministic pipeline section (#446) ────────────────────
  // Replace Gemini's pipeline section with real data from pipeline signals.
  // Gemini invents fake opp names with "undisclosed" amounts.
  const pipelineSignals = (ctx.signalData.registrySignals ?? []).filter((s: any) => s.source === 'pipeline')
  if (pipelineSignals.length > 0) {
    const openPipeline = pipelineSignals.filter((s: any) => {
      const stage = (s.metadata?.stage ?? '').toLowerCase()
      return !stage.includes('closed')
    })
    if (openPipeline.length > 0) {
      const pipelineLines = openPipeline.map((s: any) => {
        const m = s.metadata ?? {}
        const name = m.opportunityName ?? s.headline ?? 'Unknown'
        const amount = m.amount ? `$${Number(m.amount).toLocaleString()}` : ''
        const close = m.closeDate ?? ''
        const stage = m.stage ?? ''
        return `- **${name}:** ${amount}${close ? `, closing ${close}` : ''}${stage ? ` [${stage}]` : ''}`
      })
      const deterministicPipeline = `### 7. Pipeline Opportunities\n${pipelineLines.join('\n')}`
      const p7Start = prepContent.indexOf('### 7.')
      const p8Start = prepContent.indexOf('### 8.')
      if (p7Start !== -1 && p8Start !== -1) {
        prepContent = prepContent.slice(0, p7Start) + deterministicPipeline + '\n\n' + prepContent.slice(p8Start)
        console.log(`[meeting-prep] Deterministic pipeline section injected (${openPipeline.length} opps)`)
      }
    }
  }

  // ── Step 4d: Deterministic attendee list (#446) ───────────────────────
  // Replace Gemini's "Who's in the Room" with a clean list from calendar data.
  // Gemini ignores "ONLY list calendar attendees" and dumps the full account team.
  const calendarAttendees = (ctx.meeting.attendees ?? []).filter(Boolean)
  if (calendarAttendees.length > 0) {
    const attendeeLines = calendarAttendees.map(email => {
      const isInternal = email.endsWith('@redhat.com')
      if (isInternal) {
        const name = ctx.getAttendeeDisplayName(ctx.meeting, email)
        const teamMember = ctx.accountTeam.find(m =>
          m.name.toLowerCase().includes(name.split(' ')[0].toLowerCase())
        )
        return `- **${name}**${teamMember ? `, ${teamMember.role.toUpperCase()}` : ''}`
      }
      // #654: Use enriched name (title + company) from resolved profiles for external attendees
      const profile = ctx.resolvedProfiles.find(p => p.email === email)
      if (profile?.resolved && profile.title) {
        return `- **${profile.name}, ${profile.title} at ${profile.company}**`
      }
      // Unresolved: fall back to display name + domain
      const displayName = ctx.getAttendeeDisplayName(ctx.meeting, email)
      return `- **${displayName}** (${email.split('@')[1]?.replace(/\.\w+$/, '') ?? 'external'})`
    })
    const deterministicSection2 = `### 2. Who's in the Room\n${attendeeLines.join('\n')}`
    const s2Start = prepContent.indexOf('### 2.')
    const s3Start = prepContent.indexOf('### 3.')
    if (s2Start !== -1 && s3Start !== -1) {
      prepContent = prepContent.slice(0, s2Start) + deterministicSection2 + '\n\n' + prepContent.slice(s3Start)
    }
  }

  // ── Step 4f: Post-generation validation (#643) ────────────────────────
  // Validate that Gemini didn't fabricate case numbers, dollar amounts, or names
  if (ctx.filteredEvidenceBlocks.length > 0) {
    const validation = validateMeetingPrepOutput(prepContent, ctx.filteredEvidenceBlocks, ctx.accountTeam, ctx.templateResult.deterministic)
    if (!validation.valid) {
      console.warn(`[meeting-prep] Post-generation validation warnings for ${ctx.customerName}:`)
      for (const warning of validation.warnings) {
        console.warn(`  - ${warning}`)
        validationWarnings.push(warning)
      }
      // Strip fabricated data points from output
      for (const warning of validation.warnings) {
        const caseMatch = warning.match(/case.*?number.*?(\d{7,10})/i)
        if (caseMatch) {
          // Add a warning comment next to fabricated case numbers
          prepContent = prepContent.replace(
            new RegExp(`\\b${caseMatch[1]}\\b`, 'g'),
            `${caseMatch[1]} [⚠ UNVERIFIED]`
          )
        }
      }
    } else {
      console.log(`[meeting-prep] Post-generation validation passed for ${ctx.customerName} — all data points verified`)
    }
  }

  return { content: prepContent, validationWarnings }
}
