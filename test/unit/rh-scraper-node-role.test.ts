// test/unit/rh-scraper-node-role.test.ts
// Verifies BKL-ARCH-01: runRhScrape is blocked on hero nodes.
import { describe, test, expect } from 'bun:test'
import { WrongRoleError, __setRoleForTest } from '../../src/lib/node-role.ts'
import { runRhScrape } from '../../src/rh-scraper.ts'

describe('rh-scraper node-role guard (BKL-ARCH-01)', () => {
  test('runRhScrape throws WrongRoleError on hero role', async () => {
    __setRoleForTest('hero')
    try {
      await runRhScrape({
        accountNumbers: ['ACC001'],
        profileDir: '/tmp/test-rh-profile',
        cachePath: '/tmp/test-cases.json',
        shouldCancel: () => false,
        accountToCustomer: {},
      })
      throw new Error('expected WrongRoleError')
    } catch (e) {
      expect(e).toBeInstanceOf(WrongRoleError)
      expect((e as WrongRoleError).operation).toBe('rh-scraper.runRhScrape')
    } finally {
      __setRoleForTest('hero') // reset (node-role.test.ts afterEach handles full reset)
    }
  })
})
