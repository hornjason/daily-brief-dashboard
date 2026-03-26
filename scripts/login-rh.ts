#!/usr/bin/env bun
/**
 * scripts/login-rh.ts
 * Opens a headed browser so you can log into access.redhat.com via SSO.
 * After login, press Enter to save the session for automated scraping.
 *
 * Usage:  bun scripts/login-rh.ts
 */

import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_PATH = resolve(__dirname, '../config/.rh-session.json')
const TARGET_URL = 'https://access.redhat.com/support/cases/#/case/list'

function prompt(q: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, () => { rl.close(); resolve() })
  })
}

console.log('Opening Red Hat Customer Portal...\n')
const browser = await chromium.launch({ headless: false })
const context = await browser.newContext()
const page = await context.newPage()
await page.goto(TARGET_URL)

await prompt(
  '✅  Log in with your Red Hat SSO credentials in the browser window.\n' +
  '    Once you can see the support cases list, press Enter here to save your session.\n> '
)

const state = await context.storageState()
await writeFile(SESSION_PATH, JSON.stringify(state, null, 2))
console.log(`\nSession saved → ${SESSION_PATH}`)
console.log('Run scraper with:  bun scripts/scrape-cases.ts')

await browser.close()
