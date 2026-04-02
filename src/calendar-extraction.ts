import type { CalendarEvent, EmailHighlight, SupportCase, CustomerSubscription } from './types.ts'

export interface MeetingPrep {
  meeting: {
    title: string
    start: string
    attendees: string[]
  }
  attendeeContext: {
    name: string
    lastInteraction?: string
    emailFrequency?: string  // e.g. "weekly", "monthly", "silent"
  }[]
  openActionItems: string[]  // from prior meetings with these attendees
  healthSignals: {
    cases: string  // e.g. "2 open cases, 1 Sev2"
    renewals: string  // e.g. "3 renewals within 60 days"
    pipeline: string  // e.g. "$1.2M in pipeline"
  }
  competitiveContext: string[]  // competitor mentions from emails with these contacts
  stakeholderCoverage: {
    engaged: string[]  // attendees with recent email activity
    missing: string[]  // known contacts NOT in this meeting
    silent: string[]   // attendees who went silent
  }
}

export function assembleMeetingPrep(
  meetings: CalendarEvent[],
  emails: EmailHighlight[],
  cases: SupportCase[],
  subscriptions: CustomerSubscription[],
): MeetingPrep[] {
  const now = new Date()
  const threeDaysOut = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)

  // Filter to meetings in next 3 days
  const upcoming = meetings.filter(m => {
    const start = new Date(m.start)
    return start >= now && start <= threeDaysOut
  })

  return upcoming.map(meeting => {
    const attendees = meeting.attendees ?? []

    // Attendee context: find last email from each attendee
    // Note: EmailHighlight only has `from`, not `to` — we match on sender
    const attendeeContext = attendees.map(attendee => {
      const attendeeEmails = emails.filter(e =>
        e.from?.toLowerCase().includes(attendee.toLowerCase())
      )
      const lastEmail = attendeeEmails.sort((a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
      )[0]

      const daysSince = lastEmail
        ? Math.floor((now.getTime() - new Date(lastEmail.date).getTime()) / (1000 * 60 * 60 * 24))
        : null

      return {
        name: attendee,
        lastInteraction: lastEmail ? `${daysSince}d ago` : 'No email history',
        emailFrequency: daysSince !== null
          ? daysSince <= 7 ? 'weekly' : daysSince <= 30 ? 'monthly' : 'silent'
          : 'unknown'
      }
    })

    // Health signals from cases and subscriptions
    const caseSummary = cases.length
      ? `${cases.length} open cases${cases.some(c => c.severity === '1') ? ', including Sev1' : cases.some(c => c.severity === '2') ? ', including Sev2' : ''}`
      : 'No open cases'

    const renewingSoon = subscriptions.filter(s => !isNaN(s.daysLeft) && s.daysLeft <= 60)
    const renewalSummary = renewingSoon.length
      ? `${renewingSoon.length} renewal${renewingSoon.length !== 1 ? 's' : ''} within 60 days`
      : 'No imminent renewals'

    // Competitive context: search emails for competitor keywords
    const competitors = ['VMware', 'AWS', 'Azure', 'Google Cloud', 'IBM', 'Oracle', 'SUSE', 'Canonical', 'Tanzu']
    const competitiveContext: string[] = []
    for (const email of emails.slice(0, 20)) {
      const text = `${email.subject} ${email.snippet ?? ''}`
      for (const comp of competitors) {
        if (text.toLowerCase().includes(comp.toLowerCase())) {
          competitiveContext.push(`${comp} mentioned in "${email.subject}" (${new Date(email.date).toLocaleDateString()})`)
        }
      }
    }

    // Stakeholder coverage
    const allKnownContacts = [...new Set(emails.map(e => e.from).filter(Boolean))]
    const engaged = attendees.filter(a =>
      attendeeContext.find(ac => ac.name === a)?.emailFrequency !== 'silent'
        && attendeeContext.find(ac => ac.name === a)?.emailFrequency !== 'unknown'
    )
    const silent = attendees.filter(a =>
      attendeeContext.find(ac => ac.name === a)?.emailFrequency === 'silent'
    )
    const missing = allKnownContacts
      .filter(c => !attendees.some(a => a.toLowerCase().includes(c!.toLowerCase())))
      .slice(0, 5) as string[]

    return {
      meeting: { title: meeting.title, start: meeting.start, attendees },
      attendeeContext,
      openActionItems: [],  // Would come from doc extraction (R19) -- empty for now
      healthSignals: { cases: caseSummary, renewals: renewalSummary, pipeline: '' },
      competitiveContext: [...new Set(competitiveContext)],
      stakeholderCoverage: { engaged, missing, silent }
    }
  })
}
