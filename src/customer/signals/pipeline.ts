// BKL-ARCH-23: Pipeline signal source — emits <source type="pipeline">.
// Byte-identical to legacy customer.ts emission.

import type { SignalBundle, SignalSource, RenderContext, CollectInputs } from './types.ts'

type PipelineBundle = Extract<SignalBundle, { kind: 'pipeline' }>

export const pipelineSource: SignalSource<PipelineBundle> = {
  kind: 'pipeline',

  async collect(input: CollectInputs): Promise<PipelineBundle | null> {
    const items = input.pipeline ?? []
    if (items.length === 0) return null
    return {
      kind: 'pipeline',
      status: { syncedDate: '', staleness: 'ok', lastSuccess: null, lastError: null },
      items,
    }
  },

  render(bundle: PipelineBundle, ctx: RenderContext): string {
    const { escapeXml, today, sourceStatusAttr } = ctx
    let xml = `<source type="pipeline"${sourceStatusAttr('sf-pipeline')} synced="${today}" count="${bundle.items.length}">\n`
    for (const opp of bundle.items) {
      xml += `${escapeXml(opp.oppName)} | stage: ${escapeXml(opp.forecastCategory)} | amount: $${opp.acv} | close: ${escapeXml(opp.closeDate)}\n`
    }
    xml += `</source>`
    return xml
  },
}
