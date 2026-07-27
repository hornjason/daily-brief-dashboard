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

export interface EngagementTimelineEntry {
  date: string
  summary: string
  source: 'email' | 'graph' | 'calendar' | 'prep-history'
  sourceUrl?: string
}

export interface DeterministicOverrideContext {
  prepContent: string
  signalData: { registrySignals?: any[] }
  meeting: { attendees?: string[]; attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }>; meetingStart?: string }
  accountTeam: AccountTeamMember[]
  resolvedProfiles: AttendeeProfile[]
  filteredEvidenceBlocks: EvidenceBlock[]
  templateResult: { deterministic: string }
  getAttendeeDisplayName: (meeting: any, email: string) => string
  getEnrichedAttendeeName: (email: string, meeting: any, profiles: AttendeeProfile[]) => string
  customerName: string
  engagementTimeline?: EngagementTimelineEntry[]
  organizerIntent?: string
  meetingContextUseCases?: Array<{ description: string; category: string; confirmationLevel: string }>
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

  // ── Step 4a: Intelligence Synthesis for §1 Meeting Objective (#1016, §13.11) ──
  const allPipelineSignals = (ctx.signalData.registrySignals ?? []).filter((s: any) => s.source === 'pipeline')
  const openDeals = allPipelineSignals.filter((s: any) => {
    const stage = (s.metadata?.stage ?? '').toLowerCase()
    return !stage.includes('closed')
  })
  const synthesisLines: string[] = []
  const meetingDate = ctx.meeting.meetingStart ? new Date(ctx.meeting.meetingStart) : null

  if (meetingDate && openDeals.length > 0) {
    for (const deal of openDeals) {
      const m = deal.metadata ?? {} as any
      const closeDate = m.closeDate ? new Date(m.closeDate) : null
      if (!closeDate) continue
      const daysUntilClose = Math.ceil((closeDate.getTime() - meetingDate.getTime()) / (1000 * 60 * 60 * 24))
      const amount = m.amount ? `$${Math.round(Number(m.amount)).toLocaleString()}` : ''
      const name = m.opportunityName ?? deal.headline ?? 'deal'
      if (daysUntilClose > 0 && daysUntilClose <= 14) {
        synthesisLines.push(`**Closing meeting:** ${name} (${amount}) closes ${m.closeDate} — ${daysUntilClose} days after this meeting.`)
      } else if (daysUntilClose > 14 && daysUntilClose <= 30) {
        synthesisLines.push(`**Acceleration opportunity:** ${name} (${amount}) closes ${m.closeDate}.`)
      }
    }
  }

  if (ctx.organizerIntent) {
    synthesisLines.push(`**Organizer stated purpose:** ${ctx.organizerIntent}`)
  }

  if (ctx.meetingContextUseCases && ctx.meetingContextUseCases.length > 0) {
    const confirmed = ctx.meetingContextUseCases.filter(uc => uc.confirmationLevel === 'confirmed')
    if (confirmed.length > 0) {
      synthesisLines.push(`**Confirmed use cases:** ${confirmed.map(uc => uc.description).join('; ')}`)
    }
  }

  if (synthesisLines.length > 0) {
    const s1Start = prepContent.indexOf('### 1.')
    const s2Start = prepContent.indexOf('### 2.')
    if (s1Start !== -1 && s2Start !== -1) {
      const existingObjective = prepContent.slice(s1Start, s2Start).replace(/^### 1\.[^\n]*\n/, '').trim()
      const enriched = `### 1. Meeting Objective\n${existingObjective}\n\n${synthesisLines.join('\n')}`
      prepContent = prepContent.slice(0, s1Start) + enriched + '\n\n' + prepContent.slice(s2Start)
      console.log(`[meeting-prep] Intelligence synthesis injected into §1 (${synthesisLines.length} signals)`)
    }
  }

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
      if (profile?.resolved) {
        const titlePart = profile.title ? `, ${profile.title}` : ''
        const companyPart = profile.company ? ` at ${profile.company}` : ''
        return `- **${profile.name}**${titlePart}${companyPart} (${email})`
      }
      // Unresolved: fall back to display name + email
      const displayName = ctx.getAttendeeDisplayName(ctx.meeting, email)
      const domain = email.split('@')[1] ?? ''
      const company = domain.replace(/\.\w+$/, '')
      return `- **${displayName}** at ${company.charAt(0).toUpperCase() + company.slice(1)} (${email})`
    })
    // Add Red Hat team members from account team who are calendar attendees
    const internalAttendees = calendarAttendees.filter(e => e.endsWith('@redhat.com'))
    const externalAttendees = calendarAttendees.filter(e => !e.endsWith('@redhat.com'))
    const externalLines = attendeeLines.filter((_, i) => !calendarAttendees[i]?.endsWith('@redhat.com'))
    const internalLines = attendeeLines.filter((_, i) => calendarAttendees[i]?.endsWith('@redhat.com'))

    const deterministicSection2 = `### 2. Who's in the Room\n**Customer:**\n${externalLines.join('\n')}${internalLines.length > 0 ? `\n\n**Red Hat:**\n${internalLines.join('\n')}` : ''}`
    const s2Start = prepContent.indexOf('### 2.')
    const s3Start = prepContent.indexOf('### 3.')
    if (s2Start !== -1 && s3Start !== -1) {
      prepContent = prepContent.slice(0, s2Start) + deterministicSection2 + '\n\n' + prepContent.slice(s3Start)
    }
  }

  // ── Step 4e: Deterministic Engagement Timeline (#1007) ─────────────────
  // Replace Gemini's "Recent Interactions" with real data from graph + email cache.
  if (ctx.engagementTimeline && ctx.engagementTimeline.length > 0) {
    const sorted = [...ctx.engagementTimeline].sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    )
    const timelineLines = sorted.slice(0, 8).map(e => {
      const d = new Date(e.date)
      const dateStr = isNaN(d.getTime()) ? e.date : d.toISOString().split('T')[0]
      const link = e.sourceUrl ? ` [source](${e.sourceUrl})` : ''
      return `- **${dateStr}:** ${e.summary}${link}`
    })
    const deterministicSection3 = `### 3. Engagement Timeline\n${timelineLines.join('\n')}`
    const s3Start = prepContent.indexOf('### 3.')
    const s4Start = prepContent.indexOf('### 4.')
    if (s3Start !== -1 && s4Start !== -1) {
      prepContent = prepContent.slice(0, s3Start) + deterministicSection3 + '\n\n' + prepContent.slice(s4Start)
      console.log(`[meeting-prep] Deterministic Engagement Timeline injected (${sorted.length} entries)`)
    }
  }

  // ── Step 4g: Clean Assets & Resources from blockquote dump (#1008) ─────
  // Extract asset links from blockquote TDP sections, remove blockquotes,
  // and insert a clean table before Action Items
  const blockquotePattern = /^>\s.+$/gm
  const blockquoteLines = prepContent.match(blockquotePattern) || []
  if (blockquoteLines.length > 0) {
    const assets: { name: string; url: string; context: string }[] = []
    const services: string[] = []
    let currentTdp = ''

    for (const line of blockquoteLines) {
      const stripped = line.replace(/^>\s*/, '')
      const tdpMatch = stripped.match(/\*?\*?Aligned to:\*?\*?\s*(.+)/i)
      if (tdpMatch) { currentTdp = tdpMatch[1].replace(/\*\*/g, '').trim(); continue }
      const svcMatch = stripped.match(/\*?\*?Services to propose:\*?\*?\s*(.+)/i)
      if (svcMatch) { services.push(...svcMatch[1].split(',').map(s => s.trim()).filter(Boolean)); continue }
      const linkMatch = stripped.match(/[-*]\s*\[([^\]]+)\]\(([^)]+)\)/)
      if (linkMatch) {
        assets.push({ name: linkMatch[1], url: linkMatch[2], context: currentTdp })
      }
    }

    if (assets.length > 0) {
      // Remove blockquote lines from content
      prepContent = prepContent.replace(/^>\s.*\n?/gm, '').replace(/\n{3,}/g, '\n\n')

      // Deduplicate by URL
      const seen = new Set<string>()
      const uniqueAssets = assets.filter(a => {
        if (seen.has(a.url)) return false
        seen.add(a.url)
        return true
      })

      // Build clean table
      const tableLines = [
        '| Asset | Type |',
        '|---|---|',
        ...uniqueAssets.map(a => {
          const type = a.url.includes('demo.redhat.com') ? 'Demo/Lab'
            : a.url.includes('interact.redhat.com') ? 'Interactive'
            : a.url.includes('gartner.com') ? 'Analyst Report'
            : a.url.includes('content.redhat.com') ? 'Content'
            : 'Resource'
          return `| [${a.name}](${a.url}) | ${type} |`
        }),
      ]

      const uniqueServices = [...new Set(services)]
      const servicesLine = uniqueServices.length > 0
        ? `\n**Recommended Services:** ${uniqueServices.join(', ')}`
        : ''

      const assetsSection = `### Assets & Resources\n${tableLines.join('\n')}${servicesLine}`

      // Insert before Action Items
      const actionMatch = prepContent.match(/###\s*\d+\.\s*Action Items/i)
      if (actionMatch) {
        const idx = prepContent.indexOf(actionMatch[0])
        prepContent = prepContent.slice(0, idx) + assetsSection + '\n\n' + prepContent.slice(idx)
        console.log(`[meeting-prep] Clean Assets table injected (${uniqueAssets.length} assets, ${uniqueServices.length} services)`)
      }
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
