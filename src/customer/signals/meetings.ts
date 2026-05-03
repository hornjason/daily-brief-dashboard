// BKL-ARCH-23: Meetings signal source — emits <source type="calendar"> with
// attendee_context / health_signals / competitive_context / silent_attendees /
// missing_stakeholders enrichment when meeting prep data is supplied.
// Byte-identical to the legacy customer.ts emission.

import type { SignalBundle, SignalSource, RenderContext, CollectInputs } from './types.ts'

type MeetingsBundle = Extract<SignalBundle, { kind: 'meetings' }>

/** Map key format MUST match legacy enrichment lookup: `${title}|${start}` */
function prepKey(title: string, start: string): string {
  return `${title}|${start}`
}

export const meetingsSource: SignalSource<MeetingsBundle> = {
  kind: 'meetings',

  async collect(input: CollectInputs): Promise<MeetingsBundle | null> {
    // Upcoming-only filter — preserved from legacy.
    const upcoming = (input.meetings ?? []).filter(m => new Date(m.start) >= new Date())
    if (upcoming.length === 0) return null
    const preps = new Map(
      (input.meetingPreps ?? []).map(p => [prepKey(p.meeting.title, p.meeting.start), p] as const),
    )
    return {
      kind: 'meetings',
      status: { syncedDate: '', staleness: 'ok', lastSuccess: null, lastError: null },
      items: upcoming,
      preps,
    }
  },

  render(bundle: MeetingsBundle, ctx: RenderContext): string {
    const { escapeXml, fmt } = ctx
    let xml = `<source type="calendar" window="next_30_days" count="${bundle.items.length}">\n`
    for (const m of bundle.items) {
      xml += `${escapeXml(m.title)} on ${fmt(m.start)}${m.attendees?.length ? ` (${m.attendees.slice(0, 10).map(escapeXml).join(', ')})` : ''}\n`
      const prep = bundle.preps.get(prepKey(m.title, m.start))
      if (prep) {
        if (prep.attendeeContext.length) {
          xml += `  <attendee_context>\n`
          for (const ac of prep.attendeeContext) {
            xml += `    ${escapeXml(ac.name)}: last interaction ${escapeXml(ac.lastInteraction ?? 'unknown')}, frequency: ${escapeXml(ac.emailFrequency ?? 'unknown')}\n`
          }
          xml += `  </attendee_context>\n`
        }
        xml += `  <health_signals cases="${escapeXml(prep.healthSignals.cases)}" renewals="${escapeXml(prep.healthSignals.renewals)}" />\n`
        if (prep.competitiveContext.length) {
          xml += `  <competitive_context>${prep.competitiveContext.map(escapeXml).join('; ')}</competitive_context>\n`
        }
        if (prep.stakeholderCoverage.silent.length) {
          xml += `  <silent_attendees>${prep.stakeholderCoverage.silent.map(escapeXml).join(', ')}</silent_attendees>\n`
        }
        if (prep.stakeholderCoverage.missing.length) {
          xml += `  <missing_stakeholders>${prep.stakeholderCoverage.missing.map(escapeXml).join(', ')}</missing_stakeholders>\n`
        }
      }
    }
    xml += `</source>`
    return xml
  },
}
