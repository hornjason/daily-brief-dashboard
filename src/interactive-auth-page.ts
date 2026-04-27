/**
 * src/interactive-auth-page.ts
 *
 * Manages the Interactive Auth Page (IAP) — a dedicated ephemeral Playwright
 * Page used exclusively for headed auth flows (Tableau VNC login, SF re-auth).
 * Keeps _livePage clean so the scraper SSO anchor is never corrupted by
 * cross-domain redirect chains driven through it.
 *
 * BKL-CONN-TABLEAU-CTX-01: cross-domain SSO chains driven through _livePage
 * corrupted the renderer process and hung every subsequent ctx.newPage() call,
 * leading to zombie Chrome processes and forced container restarts. SSO cookies
 * are Context-level (not Page-level), so a fresh ephemeral page in the same
 * context still inherits the login result after IAP close.
 */

import type { BrowserContext, Page } from '@playwright/test'

let _iap: Page | null = null

export async function acquireIap(ctx: BrowserContext, url: string): Promise<Page> {
  await releaseIap()
  const page = await ctx.newPage()
  page.on('crash', () => { _iap = null })
  page.on('close', () => { if (_iap === page) _iap = null })
  _iap = page
  await page.goto(url, { waitUntil: 'commit' })
  return page
}

export function getIap(): Page | null {
  return _iap
}

export async function releaseIap(): Promise<void> {
  const page = _iap
  _iap = null
  if (page && !page.isClosed()) {
    await page.close({ runBeforeUnload: false }).catch(() => {})
  }
}

export function isIapAlive(): boolean {
  return _iap !== null && !_iap.isClosed()
}
