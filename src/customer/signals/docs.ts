// BKL-ARCH-23: Docs signal source — emits <source type="documents"> with
// classification (action_items, decisions, stakeholders, competitive_mentions,
// strategic_signals). Byte-identical to legacy customer.ts emission.
//
// collect() is the only signal source that performs I/O — it delegates to the
// docs-fetcher module to pull from Drive when items are not pre-supplied.

import type { SignalBundle, SignalSource, RenderContext, CollectInputs } from './types.ts'
import { fetchCustomerDocsImpl } from '../docs-fetcher.ts'

type DocsBundle = Extract<SignalBundle, { kind: 'docs' }>

export const docsSource: SignalSource<DocsBundle> = {
  kind: 'docs',

  async collect(input: CollectInputs): Promise<DocsBundle | null> {
    // Allow caller to pre-supply docs (test path / generateBrief uses pre-fetched docs).
    // Only hit Drive if docs are completely absent.
    let items = input.docs
    if (items === undefined) {
      items = await fetchCustomerDocsImpl(input.customer)
    }
    if (items.length === 0) return null
    return {
      kind: 'docs',
      status: { syncedDate: '', staleness: 'ok', lastSuccess: null, lastError: null },
      items,
      classifications: input.docClassifications ?? new Map(),
    }
  },

  render(bundle: DocsBundle, ctx: RenderContext): string {
    const { escapeXml, fmt, today } = ctx
    let xml = `<source type="documents" synced="${today}" count="${bundle.items.length}">\n`
    for (const d of bundle.items) {
      const cls = bundle.classifications.get(d.name)
      const typeTag = cls && cls.type !== 'OTHER' ? ` [${cls.type}]` : ''
      const header = `${escapeXml(d.name)}${d.modifiedTime ? ` (${fmt(d.modifiedTime)})` : ''}${typeTag}`
      xml += d.content ? `${header}\n  Content excerpt: ${escapeXml(d.content.slice(0, 3000))}\n` : `${header}\n`
      if (cls) {
        if (cls.action_items.length) {
          xml += `  <action_items>\n`
          for (const ai of cls.action_items) {
            xml += `    ${escapeXml(ai.text)}${ai.owner ? ` (owner: ${escapeXml(ai.owner)})` : ''}${ai.deadline ? ` (by ${escapeXml(ai.deadline)})` : ''}\n`
          }
          xml += `  </action_items>\n`
        }
        if (cls.decisions.length) {
          xml += `  <decisions>\n`
          for (const dec of cls.decisions) {
            xml += `    ${escapeXml(dec.text)}\n`
          }
          xml += `  </decisions>\n`
        }
        if (cls.stakeholders_mentioned.length) {
          xml += `  <stakeholders>\n`
          for (const sh of cls.stakeholders_mentioned) {
            xml += `    ${escapeXml(sh.name)}${sh.role ? ` (${escapeXml(sh.role)})` : ''}${sh.sentiment ? ` — ${escapeXml(sh.sentiment)}` : ''}\n`
          }
          xml += `  </stakeholders>\n`
        }
        if (cls.competitive_mentions.length) {
          xml += `  <competitive_mentions>\n`
          for (const cm of cls.competitive_mentions) {
            xml += `    ${escapeXml(cm.competitor)}: ${escapeXml(cm.context)}\n`
          }
          xml += `  </competitive_mentions>\n`
        }
        if (cls.strategic_signals?.length &&
            (cls.type === 'COMPANY_INTELLIGENCE' || cls.type === 'INDUSTRY_ANALYSIS')) {
          xml += `  <strategic_signals priority="high">\n`
          for (const ss of cls.strategic_signals) {
            xml += `    [${ss.signal_type.toUpperCase()}] ${escapeXml(ss.text)}${ss.significance ? ` — significance: ${escapeXml(ss.significance)}` : ''}\n`
          }
          xml += `  </strategic_signals>\n`
        }
      }
    }
    xml += `</source>`
    return xml
  },
}
