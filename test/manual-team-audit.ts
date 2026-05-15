/**
 * Full territory team audit — reads all commercial sheets, extracts team members
 * from every AE column in every tab, and produces a formatted report.
 */
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../src/google.ts'
import { extractTeamMembers } from '../src/territory-sync.ts'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')

interface RegionConfig {
  id: string
  label: string
  type: string
  territorySheetUrl?: string
  pods: Record<string, { label: string; sfReportId?: string }>
}

function loadSettings(): { regions: RegionConfig[] } {
  const settingsPath = resolve(CONFIG_DIR, 'settings.json')
  return JSON.parse(readFileSync(settingsPath, 'utf-8'))
}

function extractSheetId(url: string): string {
  const m = url?.match(/spreadsheets\/d\/([^/]+)/)
  return m ? m[1] : ''
}

async function auditRegion(
  sheetsClient: ReturnType<typeof google.sheets>,
  region: RegionConfig,
) {
  const sheetId = extractSheetId(region.territorySheetUrl ?? '')
  if (!sheetId) {
    console.log(`  ⚠️  No sheet URL configured — skipping`)
    return
  }

  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
  const allTabs = (meta.data.sheets ?? [])
    .filter(s => !s.properties?.hidden)
    .map(s => s.properties?.title ?? '')

  console.log(`  Sheet: ${sheetId}`)
  console.log(`  Tabs: ${allTabs.join(', ')}`)
  console.log(`  Pods: ${Object.entries(region.pods).map(([k, v]) => `${k} (${v.label})`).join(', ')}`)
  console.log('')

  // Enterprise regions now supported — scan the main tab

  for (const tabTitle of allTabs) {
    const lower = tabTitle.toLowerCase()
    if (lower.includes('accounts a') || lower.includes('sheet')) continue
    // Skip enterprise non-territory tabs
    if (region.type === 'enterprise' && (lower.includes('notebook') || lower.includes('industry') || lower.includes('useful') || lower.includes('supportable') || lower.includes('account_number') || lower.includes('accountnumber') || lower.includes('copy') || lower.includes('hide') || lower.includes('target') || lower.includes('dashboard'))) continue

    console.log(`  ━━━ Tab: ${tabTitle} ━━━`)

    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tabTitle}'!A1:Z${region.type === 'enterprise' ? '200' : '60'}`,
    })
    const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
      r.map((c: any) => String(c ?? '').trim())
    )

    // Find Account Executive header row
    let headerRowIdx = -1
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].some(cell => /^account executive$/i.test(cell))) {
        headerRowIdx = r
        break
      }
    }

    if (headerRowIdx === -1) {
      console.log(`    No "Account Executive" header found — skipping`)
      console.log('')
      continue
    }

    const headerRow = rows[headerRowIdx] ?? []
    const aeNameRow = rows[headerRowIdx + 1] ?? []
    const accountsStartIdx = headerRowIdx + 2

    const aeCols = headerRow
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => /^account executive$/i.test(cell))
      .map(({ idx }) => idx)

    console.log(`    ${aeCols.length} AE columns found`)
    console.log('')

    for (const col of aeCols) {
      const aeCell = aeNameRow[col] ?? ''
      if (!aeCell) continue

      const aeName = aeCell.split('\n')[0].trim()
      let terrCode = ''
      if (aeCell.includes('\n')) {
        terrCode = aeCell.split('\n')[1]?.trim() ?? ''
      } else {
        const m = aeCell.match(/\bTerr(\d+)\b/i)
        if (m) terrCode = m[0]
      }

      // Count accounts
      let accountCount = 0
      for (let r = accountsStartIdx; r < rows.length; r++) {
        const cell = rows[r][col] ?? ''
        if (!cell) continue
        if (/^\d{1,3}$/.test(cell)) break
        if (/^Account\s+S[Aa]/i.test(cell)) break
        if (/^(Support|Partner Sales|\d+ of \d+)$/i.test(cell)) break
        if (/^(Openshift|Ansible|Rhel|Ai|App Platform|Cloud)\s+(SSP|SSA)/i.test(cell)) break
        accountCount++
      }

      const team = extractTeamMembers(rows, col, accountsStartIdx)

      console.log(`    📋 ${aeName} (${terrCode || 'no territory code'}) — ${accountCount} accounts`)

      if (team.asa) {
        console.log(`       ASA: ${team.asa.name}`)
      } else {
        console.log(`       ASA: (none)`)
      }

      if (team.specialists.length > 0) {
        for (const s of team.specialists) {
          console.log(`       ${s.product} ${s.role.toUpperCase()}: ${s.name}`)
        }
      } else {
        console.log(`       Specialists: (none)`)
      }

      if (team.partnerSales) {
        console.log(`       Partner Sales: ${team.partnerSales.name}`)
      }
      if (team.consultingManager) {
        console.log(`       Consulting Mgr: ${team.consultingManager.name}`)
      }

      if (team.additionalRoles && team.additionalRoles.length > 0) {
        for (const r of team.additionalRoles) {
          console.log(`       ${r.label}: ${r.name}`)
        }
      }

      console.log('')
    }
  }
}

async function main() {
  const settings = loadSettings()
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) {
    console.error('Google auth not configured')
    process.exit(1)
  }

  const sheetsClient = google.sheets({ version: 'v4', auth })

  // Order: West Commercial, TOLA, East Commercial
  const order = ['west-commercial', 'central-enterprise-tola', 'east-commercial']
  const regionMap = new Map(settings.regions.map(r => [r.id, r]))

  for (const regionId of order) {
    const region = regionMap.get(regionId)
    if (!region) continue

    console.log(`\n${'═'.repeat(70)}`)
    console.log(`  ${region.label.toUpperCase()} (${region.type})`)
    console.log(`${'═'.repeat(70)}`)
    console.log('')

    await auditRegion(sheetsClient, region)
  }

  console.log(`\n${'═'.repeat(70)}`)
  console.log('  AUDIT COMPLETE')
  console.log(`${'═'.repeat(70)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
