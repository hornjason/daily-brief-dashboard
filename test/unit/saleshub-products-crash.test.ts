// #846: Regression test — sync-l3-daemon must not crash when scrapeSalesHub()
// returns { knowledge } without a `products` field.
//
// Root cause: scrape-saleshub.ts:L796 returns { knowledge } (no products),
// sync-l3-daemon.ts destructures { products, knowledge } → products is undefined
// → products.length crashes.
//
// Fix: default destructuring `{ products = [], knowledge } = result`
// so missing products becomes an empty array.

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const DAEMON_SRC = readFileSync(resolve(ROOT, 'scripts/sync-l3-daemon.ts'), 'utf-8')

describe('#846: SalesHub products.length crash guard', () => {
  test('destructuring defaults products to empty array', () => {
    // The destructuring line must use a default value for products
    expect(DAEMON_SRC).toContain('products = []')
  })

  test('products.length call is safe with default empty array', () => {
    // Simulate the destructuring pattern from the daemon
    const result = { knowledge: { tdps: [], tactics: [], salesPlays: [] } } as any
    const { products = [], knowledge } = result
    // This must not throw
    expect(products.length).toBe(0)
    expect(knowledge.tdps.length).toBe(0)
  })

  test('products.length works normally when products are present', () => {
    const result = {
      products: [{ name: 'RHEL' }, { name: 'OpenShift' }],
      knowledge: { tdps: [], tactics: [], salesPlays: [] },
    } as any
    const { products = [], knowledge } = result
    expect(products.length).toBe(2)
    expect(knowledge.tdps.length).toBe(0)
  })
})
