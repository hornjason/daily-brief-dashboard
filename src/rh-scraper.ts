/**
 * src/rh-scraper.ts
 * Headless Playwright scraper for Red Hat support cases.
 * Called by the server scheduler and can be imported by scripts/scrape-cases.ts.
 */

import { chromium } from '@playwright/test'
import { writeFile, mkdir } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type { SupportCase } from './types.ts'

export class SessionExpiredError extends Error {
  constructor() {
    super('Red Hat session expired — please reconnect via the dashboard')
    this.name = 'SessionExpiredError'
  }
}

export interface ScrapeOptions {
  accountNumbers: string[]
  sessionPath: string
  cachePath: string
}

export async function runRhScrape(options: ScrapeOptions): Promise<SupportCase[]> {
  const { accountNumbers, sessionPath, cachePath } = options

  if (!existsSync(sessionPath)) {
    throw new SessionExpiredError()
  }

  const sessionState = JSON.parse(readFileSync(sessionPath, 'utf-8'))

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ storageState: sessionState })
  const page = await context.newPage()

  const allCases: SupportCase[] = []

  try {
    for (const accountNum of accountNumbers) {
      const url =
        `https://access.redhat.com/support/cases/#/case/list` +
        `?query=accountNumber%3A%20(%22${accountNum}%22)%20orderBy%20severity%20asc` +
        `&p=1&size=100&searchType=basic`

      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })

      // Detect expired session
      const currentUrl = page.url()
      if (currentUrl.includes('sso.redhat.com') || currentUrl.includes('/login')) {
        await browser.close()
        throw new SessionExpiredError()
      }

      await page.waitForTimeout(2000)

      const rowCount = await page.locator('table tbody tr').count()
      if (rowCount === 0) {
        await page.waitForSelector('table tbody tr', { timeout: 10_000 }).catch(() => {})
      }

      const cases = await page.evaluate((acctNum: string) => {
        const results: Array<{
          caseNumber: string
          summary: string
          status: string
          severity: string
          accountNumber: string
          product: string
        }> = []

        const rows = document.querySelectorAll('table tbody tr')
        for (const row of rows) {
          const caseLink = row.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
          if (!caseLink) continue

          const caseNumber = caseLink.textContent?.trim() ?? ''
          if (!/^\d{7,10}$/.test(caseNumber)) continue

          const cells = Array.from(row.querySelectorAll('td')).map(
            (td) => td.textContent?.trim() ?? ''
          )

          results.push({
            caseNumber,
            summary: cells[1] ?? '',
            status: cells[2] ?? '',
            severity: cells[3] ?? '',
            product: cells[4] ?? '',
            accountNumber: acctNum,
          })
        }

        return results
      }, accountNum)

      for (const c of cases) {
        const severityNum = String(c.severity).match(/^(\d)/)?.[1] ?? c.severity
        allCases.push({
          caseNumber: c.caseNumber,
          summary: c.summary,
          status: c.status,
          severity: severityNum,
          accountNumber: c.accountNumber,
          daysOpen: 0,
          product: c.product || undefined,
        } satisfies SupportCase)
      }

      console.log(`[rh-scraper] account ${accountNum}: ${cases.length} cases`)
    }
  } finally {
    await browser.close()
  }

  // Write cache
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(
    cachePath,
    JSON.stringify({
      scrapedAt: new Date().toISOString(),
      accounts: accountNumbers,
      cases: allCases,
    }, null, 2)
  )

  return allCases
}
