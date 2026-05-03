// BKL-ARCH-23: cases signal source — render() contract + collect() null-on-empty.

import { describe, it, expect } from 'bun:test'
import { casesSource } from '../../../../src/customer/signals/cases.ts'
import { makeCtx } from './_helpers.ts'
import type { Customer, SupportCase } from '../../../../src/types.ts'

const customer: Customer = { name: 'Acme' }

describe('casesSource', () => {
  it('collect returns null for empty cases array', async () => {
    expect(await casesSource.collect({ customer, cases: [] })).toBeNull()
  })

  it('collect returns bundle with items when cases present', async () => {
    const cases: SupportCase[] = [
      { caseNumber: 'CASE1', summary: 's', status: 'Open', severity: '2', accountNumber: '1', daysOpen: 3 },
    ]
    const bundle = await casesSource.collect({ customer, cases })
    expect(bundle?.kind).toBe('cases')
    expect(bundle?.items).toHaveLength(1)
  })

  it('render emits Sev/case-number/summary/days-open and product tag when present', () => {
    const cases: SupportCase[] = [
      { caseNumber: 'CASE1', summary: 'Crash', status: 'Open', severity: '1', accountNumber: '1', daysOpen: 5, product: 'OpenShift' },
      { caseNumber: 'CASE2', summary: 'Slow', status: 'Open', severity: '3', accountNumber: '1', daysOpen: 1 },
    ]
    const xml = casesSource.render(
      { kind: 'cases', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items: cases },
      makeCtx(),
    )
    expect(xml).toContain('<source type="support_cases" synced="2026-05-02" count="2">')
    expect(xml).toContain('Sev1 | CASE1: Crash — 5d open [OpenShift]')
    expect(xml).toContain('Sev3 | CASE2: Slow — 1d open\n')
    expect(xml).not.toContain('CASE2: Slow — 1d open [')
    expect(xml.endsWith('</source>')).toBe(true)
  })

  it('render escapes XML-significant chars in case fields', () => {
    const cases: SupportCase[] = [
      { caseNumber: 'C&1', summary: '<bug>', status: 'Open', severity: '2', accountNumber: '1', daysOpen: 1, product: 'A&B' },
    ]
    const xml = casesSource.render(
      { kind: 'cases', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items: cases },
      makeCtx(),
    )
    expect(xml).toContain('C&amp;1')
    expect(xml).toContain('&lt;bug&gt;')
    expect(xml).toContain('[A&amp;B]')
  })

  it('render includes scraper status attr when ctx provides one', () => {
    const cases: SupportCase[] = [
      { caseNumber: 'C', summary: 's', status: 'Open', severity: '2', accountNumber: '1', daysOpen: 1 },
    ]
    const xml = casesSource.render(
      { kind: 'cases', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items: cases },
      makeCtx({ sourceStatusAttr: () => ' status="stale" last_success="x"' }),
    )
    expect(xml).toContain('<source type="support_cases" status="stale" last_success="x" synced="2026-05-02" count="1">')
  })
})
