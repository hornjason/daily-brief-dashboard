/**
 * Utility functions for sync-l3-daemon.ts
 * Extracted to support unit testing and reuse
 */

import type { BrowserContext } from '@playwright/test'

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
