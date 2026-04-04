import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  timeout: 30_000,
  // Retry flaky tests in CI (network timeouts, scraper race conditions)
  retries: process.env.CI ? 2 : 0,
  // Parallel execution enabled via serverState fixture (auto snapshot/restore per test).
  // See test/fixtures.ts and docs/adr/ADR-006.md for the isolation approach.
  fullyParallel: true,
  // Files that require live Google credentials or real AE data — excluded from CI.
  // Run locally with: npx playwright test --project=live-scrapers
  testIgnore: [
    '**/bootstrap-e2e.spec.ts',
    '**/e2e-carolanne.spec.ts',
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:7777',
    headless: true,
  },
  projects: [
    {
      name: 'ci',
      grepInvert: /@live/,
    },
    {
      name: 'live-scrapers',
      grep: /@live/,
      testMatch: '**/live-scrapers.spec.ts',
    },
  ],
  webServer: process.env.CI ? {
    command: 'bun run server.ts',
    url: 'http://localhost:7777',
    reuseExistingServer: false,
    timeout: 15_000,
  } : undefined,
})
