// src/browser-utils.ts — Shared Chromium launch flags (no imports from other src/ modules)

import type { BrowserContext } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Base Chromium flags required for container stability (2GB shm, 8GB mem) */
export const BASE_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--renderer-process-limit=2',
  '--no-restore-last-session', // BKL-UX74: prevent stale tabs (e.g. Supportable) from restoring on launch
  '--hide-crash-restore-bubble', // suppress "Restore pages?" infobar on Chromium relaunch
]

/**
 * Sanitize the persistent Chromium profile so it doesn't show the "Restore pages?"
 * bubble on relaunch. Marks the previous exit as clean so Chromium skips the
 * crash-restore prompt. No-op when the Preferences file doesn't exist yet.
 */
export function sanitizeChromiumProfile(profileDir: string): void {
  const prefsPath = join(profileDir, 'Default', 'Preferences')
  try {
    if (!existsSync(prefsPath)) return
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'))
    if (prefs.profile) {
      prefs.profile.exit_type = 'Normal'
      prefs.profile.exited_cleanly = true
    }
    writeFileSync(prefsPath, JSON.stringify(prefs), { mode: 0o600 })
  } catch {
    // non-fatal — profile may not have Preferences yet on first run
  }
}

/**
 * Close any open Tableau dashboard tabs in the given context.
 * Prevents CDP Network-domain calls from hanging due to live Tableau WebSocket connections
 * (BKL-CONN-TABLEAU-CDP-AUDIT-01). Safe to call before any ctx.cookies() / ctx.addCookies() /
 * ctx.storageState() / ctx.clearCookies() call.
 */
export async function closeTableauTabs(ctx: BrowserContext, label: string): Promise<number> {
  const isTableauTab = (u: string) => u.startsWith('https://10ay.online.tableau.com')
  let closed = 0
  for (const p of ctx.pages()) {
    try {
      if (isTableauTab(p.url())) {
        await p.close()
        closed++
      }
    } catch { /* already closed */ }
  }
  if (closed > 0) console.log(`[tab-janitor] ${label}: closed ${closed} Tableau tab(s)`)
  return closed
}

/**
 * Wrap a CDP Network-domain call in a timeout race.
 * If the call hangs past timeoutMs, logs a warning and returns the fallback value.
 * Call closeTableauTabs() before this when Tableau tabs may be present.
 */
export async function safeCookieOp<T>(
  ctx: BrowserContext,
  label: string,
  op: (ctx: BrowserContext) => Promise<T>,
  fallback: T,
  timeoutMs = 10_000,
): Promise<T> {
  return Promise.race([
    op(ctx),
    new Promise<T>(resolve =>
      setTimeout(() => {
        console.warn(`[safe-cookie] ${label}: timed out after ${timeoutMs}ms — using fallback`)
        resolve(fallback)
      }, timeoutMs)
    ),
  ])
}
