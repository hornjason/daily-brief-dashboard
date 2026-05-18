#!/usr/bin/env bun
/**
 * Manual verification script for team member extraction across all commercial
 * territory sheet tabs.
 *
 * Reads all tabs from West and East commercial sheets, finds the ones with
 * "Account Executive" headers, and runs extractTeamMembers() on the first AE
 * column in each tab to verify the parser works consistently.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../src/google.ts'
import { extractTeamMembers } from '../src/territory-sync.ts'

interface Settings {
  regions: Array<{
    id: string
    label: string
    type: string
    territorySheetUrl: string
  }>
}

function extractSheetIdFromUrl(url: string): string {
  const m = url.match(/spreadsheets\/d\/([^/]+)/)
  return m ? m[1] : ''
}

async function main() {
  const configPath = resolve(process.env.CONFIG_DIR ?? 'config', 'settings.json')
  const settings: Settings = JSON.parse(readFileSync(configPath, 'utf-8'))

  const commercialRegions = settings.regions.filter(r => r.type === 'commercial')

  console.log(`\n${'='.repeat(80)}`)
  console.log('COMMERCIAL TERRITORY SHEET TEAM MEMBER EXTRACTION VERIFICATION')
  console.log(`${'='.repeat(80)}\n`)

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) {
    console.error('❌ Google auth not configured')
    process.exit(1)
  }

  const sheetsClient = google.sheets({ version: 'v4', auth })

  for (const region of commercialRegions) {
    const sheetId = extractSheetIdFromUrl(region.territorySheetUrl)
    if (!sheetId) {
      console.log(`⚠️  Skipping ${region.label} — no sheet URL`)
      continue
    }

    console.log(`\n━━━ ${region.label.toUpperCase()} ━━━`)
    console.log(`Sheet ID: ${sheetId}\n`)

    // Get all tab names
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
    const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

    for (const tabTitle of tabNames) {
      // Read A1:Z60 from the tab
      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z60`,
      })
      const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
        r.map((c: any) => String(c ?? '').trim())
      )

      // Find "Account Executive" header row
      let headerRowIdx = -1
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].some(cell => cell === 'Account Executive')) {
          headerRowIdx = r
          break
        }
      }

      if (headerRowIdx === -1) {
        // No AE header — skip silently (not a territory tab)
        continue
      }

      const aeNameRowIdx = headerRowIdx + 1
      const accountsStartIdx = aeNameRowIdx + 1
      const headerRow = rows[headerRowIdx] ?? []

      // Find all AE columns
      const aeCols = headerRow
        .map((cell, idx) => ({ cell, idx }))
        .filter(({ cell }) => cell === 'Account Executive')
        .map(({ idx }) => idx)

      console.log(`📄 ${tabTitle}`)
      console.log(`   AE columns found: ${aeCols.length}`)

      if (aeCols.length === 0) {
        console.log(`   ⚠️  No AE columns (header found but no "Account Executive" cells?)`)
        continue
      }

      // Extract team data from the FIRST AE column
      const firstAeCol = aeCols[0]
      const teamData = extractTeamMembers(rows, firstAeCol, accountsStartIdx)

      // Print results
      console.log(`   ASA: ${teamData.asa ? teamData.asa.name : '(none)'}`)
      console.log(`   Specialists: ${teamData.specialists.length}`)
      if (teamData.specialists.length > 0) {
        for (const spec of teamData.specialists) {
          console.log(`      - ${spec.name} (${spec.product} ${spec.role.toUpperCase()})`)
        }
      }
      console.log(`   Partner Sales: ${teamData.partnerSales ? teamData.partnerSales.name : '(none)'}`)
      console.log(`   Consulting Mgr: ${teamData.consultingManager ? teamData.consultingManager.name : '(none)'}`)

      // Highlight if this tab has a DIFFERENT structure than Northwest
      // (Different = different number of specialists or missing expected roles)
      const hasAsaDiff = !teamData.asa
      const hasSpecDiff = teamData.specialists.length === 0
      const hasPartnerDiff = !teamData.partnerSales
      const hasConsultingDiff = !teamData.consultingManager

      if (hasAsaDiff || hasSpecDiff || hasPartnerDiff || hasConsultingDiff) {
        console.log(`   ⚠️  LAYOUT DIFFERENCE DETECTED:`)
        if (hasAsaDiff) console.log(`      - No ASA found`)
        if (hasSpecDiff) console.log(`      - No specialists found`)
        if (hasPartnerDiff) console.log(`      - No Partner Sales found`)
        if (hasConsultingDiff) console.log(`      - No Consulting Manager found`)
      }

      console.log()
    }
  }

  console.log(`\n${'='.repeat(80)}`)
  console.log('VERIFICATION COMPLETE')
  console.log(`${'='.repeat(80)}\n`)
}

main().catch(err => {
  console.error('❌ Script failed:', err.message)
  process.exit(1)
})
