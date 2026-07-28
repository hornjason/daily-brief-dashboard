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
  meeting: { attendees?: string[]; attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }>; meetingStart?: string; [key: string]: any }
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
  caseSummary?: string
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
  const custWords = ctx.customerName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2)
  const openDeals = allPipelineSignals.filter((s: any) => {
    const stage = (s.metadata?.stage ?? '').toLowerCase()
    if (stage.includes('closed')) return false
    const oppName = (s.metadata?.opportunityName ?? s.headline ?? '').toLowerCase()
    const hasCorpSuffix = /\b(inc\.|corp\.|llc|ltd\.|gmbh|s\.a\.|plc)(?:\s|,|$)/i.test(oppName)
    if (hasCorpSuffix && !custWords.some(w => oppName.includes(w))) return false
    return true
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
      // Deduplicate by keyword overlap (catches semantically similar descriptions)
      const unique: typeof confirmed = []
      for (const uc of confirmed) {
        const words = new Set(uc.description.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3))
        const isDuplicate = unique.some(existing => {
          const existingWords = new Set(existing.description.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3))
          const overlap = [...words].filter(w => existingWords.has(w)).length
          return overlap >= 3
        })
        if (!isDuplicate) unique.push(uc)
      }
      synthesisLines.push(`**Confirmed use cases:** ${unique.map(uc => uc.description).join('; ')}`)
    }
  }

  // Build Suggested Topics from all synthesis signals (#1016, §13.14)
  const suggestedTopics: { topic: string; context: string; tag: string }[] = []
  if (meetingDate && openDeals.length > 0) {
    for (const deal of openDeals) {
      const m = deal.metadata ?? {} as any
      const closeDate = m.closeDate ? new Date(m.closeDate) : null
      const amount = m.amount ? `$${Math.round(Number(m.amount)).toLocaleString()}` : ''
      const name = m.opportunityName ?? deal.headline ?? 'deal'
      if (closeDate) {
        const daysUntilClose = Math.ceil((closeDate.getTime() - meetingDate.getTime()) / (1000 * 60 * 60 * 24))
        if (daysUntilClose > 0 && daysUntilClose <= 14) {
          suggestedTopics.push({ topic: `${name} (${amount})`, context: `Closes ${m.closeDate}, ${daysUntilClose} days away`, tag: 'Closing Meeting' })
        } else if (daysUntilClose > 0 && daysUntilClose <= 60) {
          suggestedTopics.push({ topic: `${name} (${amount})`, context: `Closes ${m.closeDate}`, tag: 'Pipeline' })
        }
      }
    }
  }

  if (ctx.engagementTimeline) {
    for (const entry of ctx.engagementTimeline) {
      const s = entry.summary.toLowerCase()
      if (s.includes('consumption') || s.includes('utilization')) {
        suggestedTopics.push({ topic: entry.summary, context: entry.date ? entry.date.split('T')[0] : 'Recent', tag: 'Open Item' })
      } else if (s.includes('reschedul')) {
        suggestedTopics.push({ topic: entry.summary, context: 'Align scope', tag: 'Alignment' })
      } else if (s.includes('nfr') || s.includes('subscription') || s.includes('renewal')) {
        const dateCtx = entry.date ? entry.date.split('T')[0] : 'Recent'
        suggestedTopics.push({ topic: entry.summary, context: dateCtx, tag: 'Renewal Review' })
      }
    }
  }

  if (ctx.organizerIntent) {
    // Truncate for table display — full text is in §1
    suggestedTopics.push({ topic: 'Organizer stated purpose', context: ctx.organizerIntent.slice(0, 120), tag: 'Intent' })
  }

  // Inject §1 enrichment + Suggested Topics between §1 and §2
  const s1Start = prepContent.indexOf('### 1.')
  const s2Start = prepContent.indexOf('### 2.')
  if (s1Start !== -1 && s2Start !== -1) {
    const existingObjective = prepContent.slice(s1Start, s2Start).replace(/^### 1\.[^\n]*\n/, '').trim()
    // When synthesis is strong (closing meeting + intent), lead with synthesis
    // and keep Gemini's narrative as context. Per §13.13 gold standard.
    let enriched: string
    if (synthesisLines.length >= 2) {
      enriched = `### 1. Meeting Objective\n${synthesisLines.join('\n')}\n\n*Gemini analysis:* ${existingObjective}`
    } else if (synthesisLines.length > 0) {
      enriched = `### 1. Meeting Objective\n${existingObjective}\n\n${synthesisLines.join('\n')}`
    } else {
      enriched = `### 1. Meeting Objective\n${existingObjective}`
    }
    if (suggestedTopics.length > 0) {
      const seen = new Set<string>()
      const unique = suggestedTopics.filter(t => {
        const key = t.topic.substring(0, 40).toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const topicRows = unique.map(t => `| ${t.topic} | ${t.context || 'Recent'} | ${t.tag} |`).join('\n')
      enriched += `\n\n### Suggested Topics\n*Based on intelligence correlation — ranked by commercial urgency*\n| Topic | Context | Priority |\n|---|---|---|\n${topicRows}`
    }
    prepContent = prepContent.slice(0, s1Start) + enriched + '\n\n' + prepContent.slice(s2Start)
    console.log(`[meeting-prep] Intelligence synthesis: ${synthesisLines.length} signals, ${suggestedTopics.length} suggested topics`)
  }

  // ── Step 4c: Deterministic pipeline section (#446) ────────────────────
  // Replace Gemini's pipeline section with real data from pipeline signals.
  // Gemini invents fake opp names with "undisclosed" amounts.
  const pipelineSignals = (ctx.signalData.registrySignals ?? []).filter((s: any) => s.source === 'pipeline')
  if (pipelineSignals.length > 0) {
    const openPipeline = pipelineSignals.filter((s: any) => {
      const stage = (s.metadata?.stage ?? '').toLowerCase()
      if (stage.includes('closed')) return false
      // Filter out deals from other customers (AE territory can include multiple customers)
      const oppName = (s.metadata?.opportunityName ?? s.headline ?? '').toLowerCase()
      const hasCorpSuffix = /\b(inc\.|corp\.|llc|ltd\.|gmbh|s\.a\.|plc)(?:\s|,|$)/i.test(oppName)
      if (hasCorpSuffix && !custWords.some(w => oppName.includes(w))) return false
      return true
    })
    if (openPipeline.length > 0) {
      const pipelineRows = openPipeline.map((s: any) => {
        const m = s.metadata ?? {}
        const name = m.opportunityName ?? s.headline ?? 'Unknown'
        const amount = m.amount ? `$${Number(m.amount).toLocaleString()}` : '—'
        const close = m.closeDate ?? '—'
        const stage = m.stage ?? '—'
        return `| ${name} | ${amount} | ${close} | ${stage} |`
      })
      const deterministicPipeline = `### 7. Pipeline Opportunities\n| Opportunity | Amount | Close Date | Stage |\n|---|---|---|---|\n${pipelineRows.join('\n')}`
      const p7Start = prepContent.indexOf('### 7.')
      const p8Start = prepContent.indexOf('### 8.')
      if (p7Start !== -1 && p8Start !== -1) {
        prepContent = prepContent.slice(0, p7Start) + deterministicPipeline + '\n\n' + prepContent.slice(p8Start)
        console.log(`[meeting-prep] Deterministic pipeline section injected (${openPipeline.length} opps)`)
      }
    }
  }

  // ── Step 4d: Deterministic attendee list (#446, #1016) ────────────────
  // Replace Gemini's "Who's in the Room" with clean calendar + profile data.
  // Cross-reference playbook Key Relationships for titles when profile has none.
  // Use attendeeDetails (full list) not just attendees (external only).
  const allAttendeeEmails = (ctx.meeting as any).attendeeDetails?.map((d: any) => d.email).filter(Boolean) ?? ctx.meeting.attendees ?? []
  const calendarAttendees = [...new Set(allAttendeeEmails)].filter(Boolean)
  if (calendarAttendees.length > 0) {
    // Parse playbook Key Relationships for title cross-reference
    // Filter out markdown headings and separator lines that leak into pipe-delimited matches
    const keyRelationships = ((ctx.templateResult.deterministic || '').match(/\|[^|]+\|[^|]+\|[^|]+\|/g) ?? [])
      .filter(r => !r.includes('##') && !r.includes('---') && !/^\|[\s-]+\|/.test(r))
    // Filter noise values from titles (confidence labels, etc.)
    const noiseValues = new Set(['low', 'medium', 'high', 'unknown', 'n/a', 'none', '-', '—'])

    const externalRows: { name: string; title: string; company: string; email: string }[] = []
    const internalRows: { name: string; role: string; email: string }[] = []

    for (const email of calendarAttendees) {
      const isInternal = email.endsWith('@redhat.com')
      if (isInternal) {
        const prefix = email.split('@')[0].toLowerCase()
        const teamMember = ctx.accountTeam.find(m => {
          const nameParts = m.name.toLowerCase().split(' ')
          return prefix.includes(nameParts[0]) || prefix.includes(nameParts[nameParts.length - 1])
        })
        if (teamMember) {
          internalRows.push({ name: teamMember.name, role: teamMember.role.toUpperCase(), email })
        } else {
          // Try attendeeDetails displayName first, then capitalize email prefix
          const detail = (ctx.meeting as any).attendeeDetails?.find((d: any) => d.email === email)
          let name = detail?.displayName || ctx.getAttendeeDisplayName(ctx.meeting, email)
          // Capitalize email prefix fallback (e.g., "thutchin" → "Thutchin")
          if (name && !name.includes(' ') && name === name.toLowerCase()) {
            name = name.charAt(0).toUpperCase() + name.slice(1)
          }
          internalRows.push({ name, role: '—', email })
        }
        continue
      }
      const profile = ctx.resolvedProfiles.find(p => p.email === email)
      let title = profile?.title || ''
      if (noiseValues.has(title.toLowerCase())) title = ''
      if (!title && profile?.name) {
        const firstName = profile.name.split(' ')[0].toLowerCase()
        const match = keyRelationships.find(r => r.toLowerCase().includes(firstName))
        if (match) {
          const parts = match.split('|').map(p => p.trim()).filter(Boolean)
          if (parts.length >= 2 && !noiseValues.has(parts[1].toLowerCase())) title = parts[1]
        }
      }
      const company = profile?.company || email.split('@')[1]?.replace(/\.\w+$/, '') || ''
      const displayName = profile?.name || ctx.getAttendeeDisplayName(ctx.meeting, email)
      externalRows.push({ name: displayName, title: title || '—', company, email })
    }

    // Fallback: if no RH attendees found in attendeeDetails, use account team
    const rhRows = internalRows.length > 0 ? internalRows : ctx.accountTeam.slice(0, 5).map(m =>
      ({ name: m.name, role: m.role.toUpperCase(), email: '' })
    )

    const custTable = `**Customer Attendees**\n| Name | Title | Company | Email |\n|---|---|---|---|\n${externalRows.map(r => `| ${r.name} | ${r.title} | ${r.company} | ${r.email} |`).join('\n')}`
    const rhTable = `**Red Hat Team**\n| Name | Role | Email |\n|---|---|---|\n${rhRows.map(r => `| ${r.name} | ${r.role} | ${r.email} |`).join('\n')}`
    const deterministicSection2 = `### 2. Who's in the Room\n${custTable}\n\n${rhTable}`
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
    const timelineRows = sorted.slice(0, 8).map(e => {
      const d = new Date(e.date)
      const dateStr = isNaN(d.getTime()) ? e.date : d.toISOString().split('T')[0]
      const sourceLabel = e.source === 'email' ? 'Email' : e.source === 'graph' ? 'Graph' : e.source === 'prep-history' ? 'Meeting' : e.source
      const link = e.sourceUrl ? `[${sourceLabel}](${e.sourceUrl})` : sourceLabel
      return `| ${dateStr} | ${e.summary} | ${link} |`
    })
    const deterministicSection3 = `### 3. Engagement Timeline\n| Date | Activity | Source |\n|---|---|---|\n${timelineRows.join('\n')}`
    const s3Start = prepContent.indexOf('### 3.')
    const s4Start = prepContent.indexOf('### 4.')
    if (s3Start !== -1 && s4Start !== -1) {
      prepContent = prepContent.slice(0, s3Start) + deterministicSection3 + '\n\n' + prepContent.slice(s4Start)
      console.log(`[meeting-prep] Deterministic Engagement Timeline injected (${sorted.length} entries)`)
    }
  }

  // ── Step 4f-2: Deterministic Open Items — filter Gemini's case hallucinations ──
  if (ctx.caseSummary) {
    const s6Start = prepContent.indexOf('### 6.')
    const s7Start = prepContent.indexOf('### 7.')
    if (s6Start !== -1 && s7Start !== -1) {
      const deterministicSection6 = ctx.caseSummary === 'No open support cases'
        ? `### 6. Open Items\nNo open support cases.`
        : `### 6. Open Items\n${ctx.caseSummary}`
      prepContent = prepContent.slice(0, s6Start) + deterministicSection6 + '\n\n' + prepContent.slice(s7Start)
      console.log(`[meeting-prep] Deterministic Open Items injected (replaced Gemini case hallucinations)`)
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
