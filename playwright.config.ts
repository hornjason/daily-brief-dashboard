import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:7777',
    headless: true,
  },
  webServer: process.env.CI ? {
    command: 'bun run server.ts',
    url: 'http://localhost:7777',
    reuseExistingServer: false,
    timeout: 15_000,
  } : undefined,
})
