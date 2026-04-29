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
  globalSetup: './test/globalSetup.ts',
  timeout: 30_000,
  // Retry flaky tests in CI (network timeouts, scraper race conditions)
  retries: process.env.CI ? 2 : 0,
  // BKL-OBS-01: Custom metrics reporter writes test-metrics.json (CI only).
  // Output lives in test-results/ — gitignored, posted as CI artifact.
  reporter: process.env.CI
    ? [['list'], ['./test/reporters/metrics-reporter.ts'], ['playwright-ctrf-json-reporter', { outputFile: 'ctrf-report.json' }]]
    : [['list'], ['playwright-ctrf-json-reporter', { outputFile: 'ctrf-report.json' }], ['./test/reporters/feed-dashboard-reporter.ts']],
  // Parallel execution enabled via serverState fixture (auto snapshot/restore per test).
  // See test/fixtures.ts and docs/adr/ADR-006.md for the isolation approach.
  fullyParallel: true,
  // Files that require live Google credentials or real AE data — excluded from CI.
  // Run locally with: npx playwright test --project=live-scrapers
  testIgnore: [
    '**/bootstrap-e2e.spec.ts',
    '**/unit/**',           // bun:test unit tests — run via `bun test`, not Playwright
    '**/ux84-validation.spec.ts', // Quinn QA session artifact — test comment says excluded from CI; filename doesn't match quinn-*.spec.ts pattern (BKL-UX84)
    '**/visual-baseline.spec.ts', // Visual snapshots are platform-specific (darwin vs linux) — not portable to CI
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
      testMatch: ['**/live-scrapers.spec.ts', '**/live-scraper-e2e.spec.ts'],
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
    // ─── Tiered taxonomy (BKL-TEST-HARNESS-TAXONOMY) ─────────────────
    // The projects below classify specs by tier so a run summary differentiates
    // integration / e2e / smoke output. They do NOT replace ci/live-scrapers/test
    // above — those remain the CI entry points. Tier projects are for targeted runs
    // and reporting. Unit tests run via `bun test test/unit/` — not a Playwright
    // project because the files use the `bun:test` API, not @playwright/test.
    {
      // Integration tier — specs under test/integration/. Target test container.
      // budget: <60s per spec
      name: 'integration-tier',
      testMatch: '**/integration/**/*.spec.ts',
      use: {
        baseURL: process.env.TEST_URL ?? 'http://localhost:7776',
      },
    },
    {
      // E2E tier — top-level test/*.spec.ts specs (testIgnore at root excludes
      // bootstrap-e2e, quinn-*, qa-ae-section). Target test container.
      // budget: <90s per spec
      name: 'e2e-tier',
      testMatch: ['test/*.spec.ts', 'test/regression/**/*.spec.ts'],
      use: {
        baseURL: process.env.TEST_URL ?? 'http://localhost:7776',
      },
    },
    {
      // API tier — API contract and contract specs. Target test container.
      // budget: <60s per spec
      name: 'api-tier',
      testDir: './test',
      testMatch: ['api/**/*.spec.ts', 'contracts/**/*.spec.ts'],
      use: {
        baseURL: process.env.TEST_URL ?? 'http://localhost:7776',
      },
    },
    {
      // Smoke tier — fast prod gate. Target defaults to BASE_URL (7777).
      // budget: <30s total
      name: 'smoke',
      testMatch: '**/smoke-prod.spec.ts',
    },
    {
      // Demo tier — non-destructive tests against Mac Mini demo instance.
      // Uses mini.local:7779 (LAN direct) to avoid Cloudflare beacon CSP errors.
      // Excludes @destructive tests to protect demo data.
      name: 'demo',
      testMatch: ['**/smoke-prod.spec.ts', 'test/*.spec.ts'],
      grepInvert: /@destructive/,
      use: {
        baseURL: 'http://mini.local:7779',
      },
    },
  ],
  webServer: process.env.CI ? {
    command: 'bun run server.ts',
    url: 'http://localhost:7777',
    reuseExistingServer: true,
    timeout: 30_000,
  } : undefined,
})
