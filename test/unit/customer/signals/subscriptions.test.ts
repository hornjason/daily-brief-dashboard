// BKL-ARCH-23: subscriptions signal source — TWO blocks + isFreeOrTrial filter.

import { describe, it, expect } from 'bun:test'
import { subscriptionsSource } from '../../../../src/customer/signals/subscriptions.ts'
import { makeCtx } from './_helpers.ts'
import type { CustomerSubscription, ProductSubscription, Customer } from '../../../../src/types.ts'

const customer: Customer = { name: 'Acme' }

describe('subscriptionsSource', () => {
  it('collect filters out free/trial products at collect time', async () => {
    const products: ProductSubscription[] = [
      { sku: 'PAID', productDescription: 'Paid', quantity: 10, status: 'Active' },
      { sku: 'FREE', productDescription: 'Free Trial', quantity: 1, status: 'Trial' },
    ]
    const bundle = await subscriptionsSource.collect({ customer, subscriptions: [], products })
    expect(bundle?.detailed.map(p => p.sku)).toEqual(['PAID'])
  })

  it('collect returns null when both summary and detailed are empty', async () => {
    expect(await subscriptionsSource.collect({ customer, subscriptions: [], products: [] })).toBeNull()
  })

  it('render emits both subscriptions block and subscriptions_detailed block when both present', () => {
    const summary: CustomerSubscription[] = [
      { subscriptionNumber: 'S1', productName: 'RHEL', quantity: 100, endDate: '2026-12-31', daysLeft: 200, status: 'Active' },
    ]
    const detailed: ProductSubscription[] = [
      { sku: 'RH00001', productDescription: 'RHEL', quantity: 100, status: 'Active', endDate: '2026-12-31' },
    ]
    const xml = subscriptionsSource.render(
      { kind: 'subscriptions', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, summary, detailed },
      makeCtx(),
    )
    expect(xml).toContain('<source type="subscriptions"')
    expect(xml).toContain('<source type="subscriptions_detailed"')
    expect(xml).toContain('RHEL | qty: 100')
    expect(xml).toContain('RH00001: RHEL')
    // The summary block ends with </source>\n\n; the detailed block ends with </source>
    expect(xml.endsWith('</source>')).toBe(true)
  })

  it('render emits only summary block when detailed empty (and trims trailing \\n\\n)', () => {
    const summary: CustomerSubscription[] = [
      { subscriptionNumber: 'S1', productName: 'RHEL', quantity: 100, endDate: '2026-12-31', daysLeft: 200, status: 'Active' },
    ]
    const xml = subscriptionsSource.render(
      { kind: 'subscriptions', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, summary, detailed: [] },
      makeCtx(),
    )
    expect(xml).toContain('<source type="subscriptions"')
    expect(xml).not.toContain('<source type="subscriptions_detailed"')
    expect(xml.endsWith('</source>')).toBe(true)
  })

  it('render exposes scraper status via ctx.sourceStatusAttr (e.g. supportable failed)', () => {
    const summary: CustomerSubscription[] = [
      { subscriptionNumber: 'S1', productName: 'X', quantity: 1, endDate: '2026-12-31', daysLeft: 200, status: 'Active' },
    ]
    const xml = subscriptionsSource.render(
      { kind: 'subscriptions', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, summary, detailed: [] },
      makeCtx({ sourceStatusAttr: () => ' status="scraper_failed" last_success="never"' }),
    )
    expect(xml).toContain('<source type="subscriptions" status="scraper_failed" last_success="never"')
  })
})
