// BKL-ARCH-23: Subscriptions signal source — emits TWO <source> blocks:
//   1. <source type="subscriptions">          (CustomerSubscription summary)
//   2. <source type="subscriptions_detailed"> (ProductSubscription detailed)
// The detailed block filters out free/trial/beta SKUs via isFreeOrTrial.
// Byte-identical to legacy customer.ts emission.

import type { SignalBundle, SignalSource, RenderContext, CollectInputs } from './types.ts'
import { isFreeOrTrial } from '../../health-score.ts'

type SubscriptionsBundle = Extract<SignalBundle, { kind: 'subscriptions' }>

export const subscriptionsSource: SignalSource<SubscriptionsBundle> = {
  kind: 'subscriptions',

  async collect(input: CollectInputs): Promise<SubscriptionsBundle | null> {
    const summary = input.subscriptions ?? []
    // Pre-filter detailed products at collect time so render() stays pure.
    const detailed = (input.products ?? []).filter(p => !isFreeOrTrial(p))
    if (summary.length === 0 && detailed.length === 0) return null
    return {
      kind: 'subscriptions',
      status: { syncedDate: '', staleness: 'ok', lastSuccess: null, lastError: null },
      summary,
      detailed,
    }
  },

  render(bundle: SubscriptionsBundle, ctx: RenderContext): string {
    const { escapeXml, fmt, today, sourceStatusAttr } = ctx
    let xml = ''
    if (bundle.summary.length) {
      xml += `<source type="subscriptions"${sourceStatusAttr('supportable')} synced="${today}" count="${bundle.summary.length}">\n`
      for (const sub of bundle.summary) {
        xml += `${escapeXml(sub.productName)} | qty: ${sub.quantity} | expires: ${fmt(sub.endDate)} | ${sub.daysLeft}d left | status: ${escapeXml(sub.status)}\n`
      }
      xml += `</source>\n\n`
    }
    if (bundle.detailed.length) {
      xml += `<source type="subscriptions_detailed"${sourceStatusAttr('supportable')} synced="${today}" count="${bundle.detailed.length}">\n`
      for (const p of bundle.detailed) {
        xml += `${escapeXml(p.sku)}: ${escapeXml(p.productDescription)} | qty: ${p.quantity} | status: ${escapeXml(p.status)}${p.endDate ? ` | ends: ${fmt(p.endDate)}` : ''}\n`
      }
      xml += `</source>`
    }
    // Trim trailing \n\n if only summary block was emitted (caller appends \n\n).
    if (xml.endsWith('</source>\n\n')) xml = xml.slice(0, -2)
    return xml
  },
}
