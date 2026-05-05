import { defineConfig } from '@playwright/test'

export default defineConfig({
  testMatch: ['test/bootstrap-e2e.spec.ts'],
  timeout: 600_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.TEST_URL ?? 'http://localhost:7776',
    headless: true,
  },
  projects: [
    {
      name: 'e2e-tier',
      use: {
        baseURL: process.env.TEST_URL ?? 'http://localhost:7776',
      },
    },
  ],
})
