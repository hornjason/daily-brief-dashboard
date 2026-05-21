/**
 * Utility functions for sync-l3-daemon.ts
 * Extracted to support unit testing and reuse
 */

import type { BrowserContext, Page } from '@playwright/test'

/**
 * Health check for browser context.
 * Returns true if context responds to .pages() within timeout.
 * Used by keepalive to detect dead/unresponsive contexts.
 *
 * @param ctx - Browser context to test
 * @param timeoutMs - Max time to wait for response (default 5000ms)
 * @returns true if healthy, false if dead/timeout
 */
export async function isContextHealthy(
  ctx: BrowserContext,
  timeoutMs: number = 5000,
): Promise<boolean> {
  try {
    // Race between the health check and a timeout
    const result = await Promise.race([
      ctx.pages().then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ])
    return result
  } catch (e: any) {
    console.warn(`[sync-daemon] context health check failed: ${e?.message ?? e}`)
    return false
  }
}

/**
 * BKL-SYNC-CHROME-LEAK Layer 3: Rendering health check.
 * Tests actual rendering capability — not just IPC connectivity.
 * Creates a temporary page, evaluates document.readyState, and closes the page.
 *
 * After ~48h uptime with Chrome process leaks, contexts can respond to IPC
 * (pages() works) but fail to render complex content (SF Lightning iframes
 * show empty body). This check catches that degraded state.
 *
 * @param ctx - Browser context to test
 * @param timeoutMs - Max time to wait for render test (default 10_000ms)
 * @returns true if context can render pages, false if degraded
 */
export async function canContextRender(
  ctx: BrowserContext,
  timeoutMs: number = 10_000,
): Promise<boolean> {
  let page: Page | null = null
  try {
    page = await Promise.race([
      ctx.newPage(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('newPage timeout')), timeoutMs)),
    ]) as Page
    const result = await page.evaluate(() => document.readyState)
    return result === 'complete' || result === 'interactive' || result === 'loading'
  } catch {
    return false
  } finally {
    if (page) await page.close().catch(() => {})
  }
}
