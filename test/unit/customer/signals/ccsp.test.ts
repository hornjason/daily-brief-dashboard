// BKL-ARCH-23: ccsp signal source.

import { describe, it, expect } from 'bun:test'
import { ccspSource } from '../../../../src/customer/signals/ccsp.ts'
import { makeCtx } from './_helpers.ts'
import type { CCSPRecord } from '../../../../src/sheets.ts'
import type { Customer } from '../../../../src/types.ts'

const customer: Customer = { name: 'Acme' }

describe('ccspSource', () => {
  it('collect returns null on empty', async () => {
    expect(await ccspSource.collect({ customer, ccsp: [] })).toBeNull()
  })

  it('render emits cloudPartner, quarter, ACV+, close date', () => {
    const items = [
      { cloudPartner: 'AWS', quarter: 'Q2-2026', acvPlus: 50000, closeDate: '2026-06-15' } as unknown as CCSPRecord,
    ]
    const xml = ccspSource.render(
      { kind: 'ccsp', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items },
      makeCtx(),
    )
    expect(xml).toContain('<source type="cloud_spend" synced="2026-05-02" count="1">')
    expect(xml).toContain('AWS | Q2-2026 | ACV+: $50000 | close: 2026-06-15')
    expect(xml.endsWith('</source>')).toBe(true)
  })
})
