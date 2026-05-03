// BKL-ARCH-23: Emails signal source — emits <source type="emails"> with
// classification + competitive_mentions + action_items + silent_contacts
// enrichment when supplied. Byte-identical to legacy customer.ts emission.

import type { SignalBundle, SignalSource, RenderContext, CollectInputs } from './types.ts'

type EmailsBundle = Extract<SignalBundle, { kind: 'emails' }>

/** Map key format MUST match legacy enrichment lookup: `${from}|${subject}|${date}` */
function emailKey(from: string, subject: string, date: string): string {
  return `${from}|${subject}|${date}`
}

export const emailsSource: SignalSource<EmailsBundle> = {
  kind: 'emails',

  async collect(input: CollectInputs): Promise<EmailsBundle | null> {
    const items = input.emails ?? []
    if (items.length === 0) return null
    return {
      kind: 'emails',
      status: { syncedDate: '', staleness: 'ok', lastSuccess: null, lastError: null },
      items,
      classifications: input.emailClassifications ?? new Map(),
      silentContacts: input.silentContacts ?? [],
    }
  },

  render(bundle: EmailsBundle, ctx: RenderContext): string {
    const { escapeXml, fmt, emailLimit } = ctx
    let xml = `<source type="emails" window="last_30_days" count="${bundle.items.length}">\n`
    for (const e of bundle.items.slice(0, emailLimit)) {
      const intel = bundle.classifications.get(emailKey(e.from, e.subject, e.date))
      const classTag = intel ? ` [${intel.classification}]` : (e.actionRequired ? ' [ACTION REQUIRED]' : '')
      xml += `[${fmt(e.date)}] ${escapeXml(e.subject)}${e.snippet ? ` — ${escapeXml(e.snippet.slice(0, 500))}` : ''}${classTag}\n`
      if (intel?.competitive_mentions?.length) {
        for (const cm of intel.competitive_mentions) {
          xml += `  ⚠ Competitive: ${escapeXml(cm.competitor)} (${cm.risk_level}) — ${escapeXml(cm.context.slice(0, 120))}\n`
        }
      }
      if (intel?.action_items?.length) {
        for (const ai of intel.action_items) {
          xml += `  → Action: ${escapeXml(ai.text)}${ai.deadline ? ` (by ${escapeXml(ai.deadline)})` : ''}\n`
        }
      }
    }
    if (bundle.silentContacts.length) {
      xml += `  <silent_contacts>\n`
      for (const sc of bundle.silentContacts) {
        xml += `    ${escapeXml(sc.name ?? sc.email)}: ${sc.daysSilent}d silent (was ${sc.previousFrequency}/mo, now ${sc.currentFrequency}/mo)\n`
      }
      xml += `  </silent_contacts>\n`
    }
    xml += `</source>`
    return xml
  },
}
