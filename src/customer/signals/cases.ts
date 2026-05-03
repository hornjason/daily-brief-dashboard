// BKL-ARCH-23: Cases signal source — emits the <source type="support_cases">
// block. No enrichment. Byte-identical to the legacy customer.ts emission.

import type { SignalBundle, SignalSource, RenderContext, CollectInputs } from './types.ts'

type CasesBundle = Extract<SignalBundle, { kind: 'cases' }>

export const casesSource: SignalSource<CasesBundle> = {
  kind: 'cases',

  async collect(input: CollectInputs): Promise<CasesBundle | null> {
    const items = input.cases ?? []
    if (items.length === 0) return null
    return {
      kind: 'cases',
      // status filled in by buildXmlSources via ctx.sourceStatusAttr — bundle.status
      // is reserved for future use (the byte-identical legacy implementation
      // resolves status at render-time through the shared ctx, not the bundle).
      status: { syncedDate: '', staleness: 'ok', lastSuccess: null, lastError: null },
      items,
    }
  },

  render(bundle: CasesBundle, ctx: RenderContext): string {
    const { escapeXml, today, sourceStatusAttr } = ctx
    let xml = `<source type="support_cases"${sourceStatusAttr('rh-cases')} synced="${today}" count="${bundle.items.length}">\n`
    for (const c of bundle.items) {
      xml += `Sev${c.severity} | ${escapeXml(c.caseNumber)}: ${escapeXml(c.summary)} — ${c.daysOpen}d open${c.product ? ` [${escapeXml(c.product)}]` : ''}\n`
    }
    xml += `</source>`
    return xml
  },
}
