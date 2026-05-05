import { defineConfig } from '@playwright/test'

// Dedicated config for the bootstrap E2E gate.
// Bypasses the testIgnore and @destructive grep in playwright.config.ts.
// Run from Mac Mini after setting TEST_DRIVE_PARENT_URL and TEST_AE_NAME:
//
//   TEST_DRIVE_PARENT_URL='https://drive.google.com/drive/folders/...' \
//   TEST_AE_NAME='Carolanne Farrell' \
//   npx playwright test --config playwright.e2e.config.ts
//
// Targets the test container (7776). Never run against 7777 — beforeAll wipes AE state.

export default defineConfig({
  testDir: './test',
  globalSetup: './test/globalSetup.ts',
  testMatch: '**/bootstrap-e2e.spec.ts',
  timeout: 20 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  projects: [
    {
      name: 'bootstrap-e2e',
      use: {
        baseURL: process.env.TEST_URL ?? 'http://localhost:7776',
      },
    },
  ],
})
