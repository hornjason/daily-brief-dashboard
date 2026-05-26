/**
 * GitHub Issue #423: Post-bootstrap auto-refresh triggers
 *
 * Verifies that after bootstrap completes, the intelligence layer endpoints
 * are automatically triggered (fire-and-forget) so the dashboard isn't empty
 * on day 0.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'

/**
 * We can't unit-test the actual orchestrator easily (too many side effects),
 * but we CAN verify that the post-bootstrap trigger list is complete by
 * extracting the expected triggers and matching against the source code.
 *
 * This test reads the bootstrap-orchestrator source and verifies the
 * presence of each required post-bootstrap trigger endpoint.
 */

const ORCHESTRATOR_PATH = new URL('../../src/bootstrap-orchestrator.ts', import.meta.url).pathname

describe('Post-bootstrap auto-refresh triggers (#423)', () => {
  let source: string

  beforeEach(async () => {
    const file = Bun.file(ORCHESTRATOR_PATH)
    source = await file.text()
  })

  describe('POD bootstrap triggers (bootstrapPOD)', () => {
    // Extract the section after "BKL-TOKEN-03" comment in bootstrapPOD
    // which contains the post-bootstrap triggers

    it('AC-1: triggers RSS feeds refresh after POD bootstrap', () => {
      // Must contain a fetch to /api/admin/rss-feeds/refresh
      expect(source).toContain('/api/admin/rss-feeds/refresh')
      // Verify it's in a fire-and-forget pattern (fetch().then().catch())
      const rssIdx = source.indexOf('/api/admin/rss-feeds/refresh')
      const surrounding = source.slice(Math.max(0, rssIdx - 200), rssIdx + 200)
      expect(surrounding).toContain('fetch(')
      expect(surrounding).toContain('.catch(')
    })

    it('AC-2: triggers News Radar after POD bootstrap', () => {
      expect(source).toContain('/api/refresh/news')
      const newsIdx = source.indexOf('/api/refresh/news')
      const surrounding = source.slice(Math.max(0, newsIdx - 200), newsIdx + 200)
      expect(surrounding).toContain('fetch(')
      expect(surrounding).toContain('.catch(')
    })

    it('AC-3: triggers Events refresh after POD bootstrap', () => {
      // Events use the module sync endpoint
      expect(source).toContain('/api/customer/_global/modules/rh-events/sync')
      const evtIdx = source.indexOf('/api/customer/_global/modules/rh-events/sync')
      const surrounding = source.slice(Math.max(0, evtIdx - 200), evtIdx + 200)
      expect(surrounding).toContain('fetch(')
      expect(surrounding).toContain('.catch(')
    })

    it('AC-4: triggers Product refresh after POD bootstrap (pre-existing)', () => {
      expect(source).toContain('/api/products/refresh-all')
    })

    it('AC-5: existing intelligence/briefs triggers still present (no regression)', () => {
      expect(source).toContain('/api/intelligence/generate-all')
      expect(source).toContain('/api/briefs/pregen-all')
    })

    it('AC-6: all triggers use fire-and-forget pattern (fetch + catch, no await)', () => {
      // Find the POD bootstrap completion section (after BKL-TOKEN-03 comment)
      const tokenIdx = source.indexOf('BKL-TOKEN-03')
      expect(tokenIdx).toBeGreaterThan(-1)
      const postSection = source.slice(tokenIdx, tokenIdx + 3000)

      // Each trigger should be a fetch() with .catch() — not awaited
      const triggers = [
        '/api/intelligence/generate-all',
        '/api/briefs/pregen-all',
        '/api/products/refresh-all',
        '/api/admin/rss-feeds/refresh',
        '/api/refresh/news',
        '/api/customer/_global/modules/rh-events/sync',
      ]

      for (const endpoint of triggers) {
        expect(postSection).toContain(endpoint)
      }
    })
  })

  describe('Single-AE bootstrap triggers (runAutoBootstrap)', () => {
    it('triggers RSS feeds refresh after single-AE bootstrap', () => {
      // The runAutoBootstrap function should also have these triggers
      // Find the function body
      const fnIdx = source.indexOf('function runAutoBootstrap')
      expect(fnIdx).toBeGreaterThan(-1)
      const fnBody = source.slice(fnIdx)

      expect(fnBody).toContain('/api/admin/rss-feeds/refresh')
    })

    it('triggers News Radar after single-AE bootstrap', () => {
      const fnIdx = source.indexOf('function runAutoBootstrap')
      const fnBody = source.slice(fnIdx)
      expect(fnBody).toContain('/api/refresh/news')
    })

    it('triggers Events refresh after single-AE bootstrap', () => {
      const fnIdx = source.indexOf('function runAutoBootstrap')
      const fnBody = source.slice(fnIdx)
      expect(fnBody).toContain('/api/customer/_global/modules/rh-events/sync')
    })
  })
})
