// src/scraper-registry.ts
// BKL-ARCH-02 Phase 1 — Single registry for scraper descriptors.
// Collapses repeated 4-line adoption blocks (rh-auth, sf-auth, scraper-manager
// context-recovery callback) into a single ScraperRegistry.adoptAll() call.
//
// Design (DA-approved 2026-05-02, Serena brief):
//  • Pure registry — depends on no other project modules
//  • Type-only Playwright imports so this file does NOT pull in the Playwright
//    runtime at module load
//  • Scrapers register themselves at module bottom (side-effect import order
//    is preserved by server.ts which already imports all scrapers before HTTP
//    routes fire — see ARCHITECTURE.md and SCRAPER-RULES.md)
//  • adoptAll skips descriptors marked retired (e.g. supportable, permanently
//    disabled per CLAUDE.md)
//  • Adoption is synchronous — adoptAll() is sync, NOT async (mirrors how
//    rh-auth/sf-auth call adopt*Context fns synchronously today)

import type { BrowserContext, Page } from 'playwright-core'
import type { ScraperName } from './scraper-status-store.ts'

export interface ScraperDescriptor {
  name: ScraperName
  /**
   * Adopt the shared post-login BrowserContext for this scraper.
   * livePage is optional and only meaningful for rh-cases (the live page
   * carries sessionStorage / PKCE state required for transparent SSO renewal).
   */
  adopt: (ctx: BrowserContext, profileDir: string, livePage?: Page) => void
  /** Read the in-memory "lastSync" hint exported by the scraper module. */
  getInMemoryLastSync: () => string | null
  /** Read the in-memory "lastError" hint exported by the scraper module. */
  getInMemoryLastError: () => string | null
  /** Read the in-memory "isRunning" flag exported by the scraper module. */
  getInMemoryIsRunning: () => boolean
  /**
   * If true, adoptAll() skips this descriptor entirely. Use for permanently
   * disabled scrapers (supportable) so they never re-attach a live context
   * but still appear in the registry for getUnifiedStatus() lookups.
   */
  retired?: boolean
}

const _descriptors = new Map<ScraperName, ScraperDescriptor>()

export const ScraperRegistry = {
  /** Register or replace a descriptor by name. */
  register(d: ScraperDescriptor): void {
    _descriptors.set(d.name, d)
  },

  /** Look up a descriptor by name. Returns undefined when not registered. */
  get(name: ScraperName): ScraperDescriptor | undefined {
    return _descriptors.get(name)
  },

  /** Snapshot of all registered descriptors (insertion order). */
  list(): ScraperDescriptor[] {
    return Array.from(_descriptors.values())
  },

  /**
   * Call adopt() on every non-retired descriptor exactly once.
   * Synchronous — never throws on individual descriptor failure.
   * Idempotent — safe to call repeatedly with the same context.
   */
  adoptAll(ctx: BrowserContext, profileDir: string, livePage?: Page): void {
    for (const d of _descriptors.values()) {
      if (d.retired) continue
      try {
        d.adopt(ctx, profileDir, livePage)
      } catch (e: any) {
        // Don't let one descriptor's failure stop sister adoptions —
        // mirrors the existing per-call try/catch shape in scraper-manager.ts.
        console.warn(`[scraper-registry] adopt failed for ${d.name}:`, e?.message ?? e)
      }
    }
  },
}
