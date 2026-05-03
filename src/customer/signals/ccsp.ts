// BKL-ARCH-23: CCSP cloud-spend signal source — emits <source type="cloud_spend">.
// Byte-identical to legacy customer.ts emission.

import type { SignalBundle, SignalSource, RenderContext, CollectInputs } from './types.ts'

type CcspBundle = Extract<SignalBundle, { kind: 'ccsp' }>

export const ccspSource: SignalSource<CcspBundle> = {
  kind: 'ccsp',

  async collect(input: CollectInputs): Promise<CcspBundle | null> {
    const items = input.ccsp ?? []
    if (items.length === 0) return null
    return {
      kind: 'ccsp',
      status: { syncedDate: '', staleness: 'ok', lastSuccess: null, lastError: null },
      items,
    }
  },

  render(bundle: CcspBundle, ctx: RenderContext): string {
    const { escapeXml, today, sourceStatusAttr } = ctx
    let xml = `<source type="cloud_spend"${sourceStatusAttr('ccsp')} synced="${today}" count="${bundle.items.length}">\n`
    for (const row of bundle.items) {
      xml += `${escapeXml(row.cloudPartner)} | ${escapeXml(row.quarter)} | ACV+: $${row.acvPlus} | close: ${escapeXml(row.closeDate)}\n`
    }
    xml += `</source>`
    return xml
  },
}
