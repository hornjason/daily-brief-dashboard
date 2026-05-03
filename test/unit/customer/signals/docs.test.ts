// BKL-ARCH-23: docs signal source — strategic_signals gating + 3000-char excerpt cap.

import { describe, it, expect } from 'bun:test'
import { docsSource } from '../../../../src/customer/signals/docs.ts'
import { makeCtx } from './_helpers.ts'
import type { DriveFile } from '../../../../src/types.ts'
import type { DocClassification } from '../../../../src/doc-extraction.ts'

function emptyClass(type: DocClassification['type']): DocClassification {
  return { type, action_items: [], decisions: [], stakeholders_mentioned: [], technical_signals: [], competitive_mentions: [], timelines: [], pain_points: [], strategic_signals: [] }
}

describe('docsSource', () => {
  it('caps content excerpt at 3000 chars', () => {
    const longContent = 'x'.repeat(5000)
    const items: DriveFile[] = [{ name: 'big.doc', mimeType: 'application/vnd.google-apps.document', content: longContent }]
    const xml = docsSource.render(
      { kind: 'docs', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items, classifications: new Map() },
      makeCtx(),
    )
    // The excerpt shows exactly 3000 'x' chars
    const match = xml.match(/Content excerpt: (x+)/)
    expect(match?.[1].length).toBe(3000)
  })

  it('renders strategic_signals only for COMPANY_INTELLIGENCE / INDUSTRY_ANALYSIS doc types', () => {
    const items: DriveFile[] = [
      { name: 'company.doc', mimeType: 'application/vnd.google-apps.document', content: 'c' },
      { name: 'meeting.doc', mimeType: 'application/vnd.google-apps.document', content: 'm' },
    ]
    const cls = new Map<string, DocClassification>([
      ['company.doc', { ...emptyClass('COMPANY_INTELLIGENCE'), strategic_signals: [{ signal_type: 'trigger_event', text: 'CEO change', significance: 'high' }] }],
      ['meeting.doc', { ...emptyClass('MEETING_NOTES'),         strategic_signals: [{ signal_type: 'trigger_event', text: 'should not appear' }] }],
    ])
    const xml = docsSource.render(
      { kind: 'docs', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items, classifications: cls },
      makeCtx(),
    )
    expect(xml).toContain('CEO change')
    expect(xml).not.toContain('should not appear')
    expect(xml).toContain('<strategic_signals priority="high">')
  })

  it('omits typeTag when type is OTHER', () => {
    const items: DriveFile[] = [{ name: 'doc', mimeType: 'application/vnd.google-apps.document', content: 'x' }]
    const cls = new Map<string, DocClassification>([['doc', emptyClass('OTHER')]])
    const xml = docsSource.render(
      { kind: 'docs', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items, classifications: cls },
      makeCtx(),
    )
    expect(xml).not.toContain('[OTHER]')
  })
})
