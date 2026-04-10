import { defineConfig } from '@playwright/test'

// Container map:
//   pai-dashboard      → port 7777  (production, never wipe)
//   pai-dashboard-dev  → port 7778  (dev snapshot)
//   pai-dashboard-test → port 7776  (ALLOW_RESET=true, safe to wipe)
//
// Environment variables:
//   BASE_URL  — overrides the default production URL (7777) for all tests
//   TEST_URL  — overrides the test container URL (7776) for @destructive tests
//              and snapshot/restore calls in the serverState fixture
//
// Run destructive tests: npx playwright test --project=test

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
      // Safe to run against production (port 7777) — excludes @live and @destructive.
      name: 'ci',
      grepInvert: /@live|@destructive/,
    },
    {
      name: 'live-scrapers',
      grep: /@live/,
      testMatch: '**/live-scrapers.spec.ts',
    },
    {
      // Destructive tests — always routed to the test container (port 7776).
      // Tests must be tagged @destructive. Set TEST_URL to override the container URL.
      // TEST_KNOWN_CUSTOMER is set to a seed customer so API tests find real data.
      name: 'test',
      use: {
        baseURL: process.env.TEST_URL ?? 'http://localhost:7776',
        extraHTTPHeaders: {},
      },
      grep: /@destructive/,
    },
  ],
  webServer: process.env.CI ? {
    command: 'bun run server.ts',
    url: 'http://localhost:7777',
    reuseExistingServer: false,
    timeout: 30_000,
  } : undefined,
})
