/**
 * Bootstrap E2E config — used exclusively for bootstrap-e2e.spec.ts
 * which requires a clean-slate (0 AEs) container state.
 *
 * Run: BOOTSTRAP_E2E=1 BASE_URL=http://localhost:7776 \
 *      bunx playwright test --config playwright.bootstrap.config.ts
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  testMatch: '**/bootstrap-e2e.spec.ts',
  timeout: 1_200_000,
  workers: 1,
  globalSetup: './test/globalSetup.ts',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:7776',
  },
})
