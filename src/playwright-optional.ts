// Lazy-load @playwright/test so the hero image (which has no Playwright)
// can start without crashing.  Every scraper file imports `chromium` from
// here instead of directly from '@playwright/test'.
//
// Type-only imports (`import type { … } from '@playwright/test'`) are
// erased at compile time and never cause a runtime resolution error, so
// they remain in the scraper files untouched.

let _chromium: typeof import('@playwright/test')['chromium'] | null = null

try {
  _chromium = (await import('@playwright/test')).chromium
} catch {
  // @playwright/test not installed — browser features disabled (hero image)
}

export const chromium = _chromium
