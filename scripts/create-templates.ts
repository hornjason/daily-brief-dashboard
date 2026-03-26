/**
 * Creates 3 template Google Sheets in the specified Drive folder:
 *   - [AE Name] Supportable
 *   - [AE Name] CCSP
 *   - [AE Name] Pipeline
 */
import { google } from 'googleapis'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const CI_CONFIG = resolve(import.meta.dir, '../../CustomerIntelligence/config')
const OAUTH_KEYS_PATH = process.env.GOOGLE_OAUTH_KEYS ?? `${CI_CONFIG}/gcp-oauth.keys.json`
const TOKEN_PATH      = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, '.google-token.json')
  : `${CI_CONFIG}/.google-token.json`

const FOLDER_ID = '1jE11e-FQBDTrsdmvf9_jyNxcl43mWtrM'

function makeAuth() {
  const keys = JSON.parse(readFileSync(OAUTH_KEYS_PATH, 'utf-8'))
  const { client_id, client_secret } = keys.installed ?? keys.web
  const auth = new google.auth.OAuth2(client_id, client_secret)
  auth.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')))
  return auth
}

async function createSpreadsheet(
  sheets: ReturnType<typeof google.sheets>,
  drive: ReturnType<typeof google.drive>,
  title: string,
  sheetDefs: { name: string; headers: string[]; exampleRows: string[][] }[],
) {
  // Create the spreadsheet
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheetDefs.map(s => ({ properties: { title: s.name } })),
    },
  })

  const spreadsheetId = res.data.spreadsheetId!
  const createdSheets = res.data.sheets ?? []

  // Write headers + example rows to each sheet
  const data = sheetDefs.map((def) => ({
    range: `'${def.name}'!A1`,
    values: [def.headers, ...def.exampleRows],
  }))

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  })

  // Bold the header row on each sheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: createdSheets.map(s => ({
        repeatCell: {
          range: {
            sheetId: s.properties!.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
          },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      })),
    },
  })

  // Move to target folder
  await drive.files.update({
    fileId: spreadsheetId,
    addParents: FOLDER_ID,
    removeParents: 'root',
    fields: 'id,parents',
  })

  console.log(`✓ Created: ${title}`)
  console.log(`  https://docs.google.com/spreadsheets/d/${spreadsheetId}`)
  return spreadsheetId
}

const ACCOUNT_TAB_HEADERS = [
  'Account Number',
  'Product Description',
  'Internal Sku',
  'Quantity',
  'Status',
  'Start Date',
  'End Date',
]

async function updateSpreadsheet(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetDefs: { name: string; headers: string[]; exampleRows: string[][] }[],
) {
  // Single read to get existing sheet IDs
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' })
  const existingSheets = meta.data.sheets ?? []
  const existingIds = existingSheets.map(s => s.properties!.sheetId!)
  const firstSheetId = existingIds[0]

  // In one batchUpdate: rename first sheet, delete rest, add new sheets
  const renameFirst = {
    updateSheetProperties: {
      properties: { sheetId: firstSheetId, title: sheetDefs[0].name },
      fields: 'title',
    },
  }
  const deleteRest = existingIds.slice(1).map(sheetId => ({ deleteSheet: { sheetId } }))
  const addNew = sheetDefs.slice(1).map(s => ({ addSheet: { properties: { title: s.name } } }))

  const batchRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [renameFirst, ...deleteRest, ...addNew] },
  })

  // Collect sheetIds for all sheets: first sheet + newly added
  const addedIds: number[] = (batchRes.data.replies ?? [])
    .filter(r => r.addSheet)
    .map(r => r.addSheet!.properties!.sheetId!)

  const allSheetIds = [firstSheetId, ...addedIds]

  // Write all data in one call
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: sheetDefs.map(def => ({
        range: `'${def.name}'!A1`,
        values: [def.headers, ...def.exampleRows],
      })),
    },
  })

  // Bold headers in one call
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: allSheetIds.map(sheetId => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      })),
    },
  })

  console.log(`✓ Updated: https://docs.google.com/spreadsheets/d/${spreadsheetId}`)
}

async function main() {
  if (!existsSync(OAUTH_KEYS_PATH)) { console.error('OAuth keys not found:', OAUTH_KEYS_PATH); process.exit(1) }
  if (!existsSync(TOKEN_PATH))      { console.error('Token not found:', TOKEN_PATH); process.exit(1) }

  const auth   = makeAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const drive  = google.drive({ version: 'v3', auth })

  // ── 1. [AE Name] Supportable — recreate in place ─────────────────────────────
  console.log('Updating [AE Name] Supportable...')
  await updateSpreadsheet(sheets, '17EL8vf-WLRhRphWCmcWzW5aEAf5xbGqQ-dpJbinAU1c', [
    {
      name: 'Account List',
      headers: ['Account Name', 'Segment', 'Aliases'],
      exampleRows: [
        ['Acme Corp',          'Enterprise',  ''],
        ['Globex Corporation', 'Commercial',  'Globex, Globex Corp'],
        ['Initech',            'Mid-Market',  ''],
      ],
    },
    {
      name: 'Acme Corp',
      headers: ACCOUNT_TAB_HEADERS,
      exampleRows: [
        ['1234567', 'Red Hat Enterprise Linux Server',          'RH00798', '10', 'ACTIVE', '2024-01-01', '2025-01-01'],
        ['1234567', 'Red Hat OpenShift Container Platform',     'RH00003', '2',  'ACTIVE', '2024-01-01', '2025-01-01'],
        ['1234567', 'Red Hat Ansible Automation Platform',      'RH00440', '1',  'ACTIVE', '2024-01-01', '2025-01-01'],
        ['1234567', 'Red Hat Satellite',                        'RH00845', '1',  'EXPIRED','2023-01-01', '2024-01-01'],
      ],
    },
    {
      name: 'Globex Corporation',
      headers: ACCOUNT_TAB_HEADERS,
      exampleRows: [
        ['2345678', 'Red Hat Enterprise Linux Server', 'RH00798', '5', 'ACTIVE', '2024-06-01', '2025-06-01'],
        ['2345678', 'Red Hat Satellite',               'RH00845', '1', 'ACTIVE', '2024-06-01', '2025-06-01'],
      ],
    },
    {
      name: 'Initech',
      headers: ACCOUNT_TAB_HEADERS,
      exampleRows: [
        ['3456789', 'Red Hat Enterprise Linux Server', 'RH00798', '3', 'ACTIVE', '2024-03-01', '2025-03-01'],
      ],
    },
  ])

  // ── 2. [AE Name] CCSP — recreate in place ────────────────────────────────────
  console.log('Updating [AE Name] CCSP...')
  await updateSpreadsheet(sheets, '1HUlZsqQVIVCbyrgSU467f7vVSLoSOdGFNplyefJRGwg', [
    {
      name: 'CCSP',
      headers: [
        'Account Name',
        'Fiscal Year Quarter',
        'Opportunity Close Date',
        'Financial Partner',
        'ACV Plus',
      ],
      exampleRows: [
        ['Acme Corp',          'FY25-Q1', '2025-01-15', 'Amazon Web Services', '45000'],
        ['Acme Corp',          'FY25-Q2', '2025-04-10', 'Amazon Web Services', '52000'],
        ['Globex Corporation', 'FY25-Q1', '2025-02-28', 'Microsoft Azure',     '31000'],
        ['Initech',            'FY25-Q3', '2025-07-01', 'Google Cloud',        '18000'],
      ],
    },
  ])

  // ── 3. [AE Name] Pipeline — recreate in place ────────────────────────────────
  console.log('Updating [AE Name] Pipeline...')
  await updateSpreadsheet(sheets, '1af6JuVNilnUhMII9x9-r1Pkvlp9o_1hEU3ul-JaTMLA', [
    {
      name: 'Pipeline',
      headers: [
        'Opportunity Number',
        'Account Name',
        'Opportunity Name',
        'ACV Opportunity',
        'Close Date',
        'Forecast Category',
        'Opportunity Owner',
        'Renewal',
        'Offering Group',
        'Probability (%)',
        'Product Description',
      ],
      exampleRows: [
        ['OPP-001', 'Acme Corp',          'RHEL Expansion 2025',     '48000',  '2025-06-30', 'Commit',    'Jane Smith', '0', 'RHEL',       '90', 'Red Hat Enterprise Linux Server'],
        ['OPP-001', 'Acme Corp',          'RHEL Expansion 2025',     '48000',  '2025-06-30', 'Commit',    'Jane Smith', '0', 'RHEL',       '90', 'Red Hat Satellite'],
        ['OPP-002', 'Globex Corporation', 'OpenShift New Logo',       '120000', '2025-09-30', 'Best Case', 'Jane Smith', '0', 'OpenShift',  '60', 'Red Hat OpenShift Container Platform'],
        ['OPP-003', 'Initech',            'RHEL Renewal FY25',        '22000',  '2025-03-31', 'Commit',    'Jane Smith', '1', 'RHEL',       '95', 'Red Hat Enterprise Linux Server'],
        ['OPP-004', 'Acme Corp',          'Ansible Expansion',        '35000',  '2025-12-15', 'Pipeline',  'Jane Smith', '0', 'Automation', '30', 'Red Hat Ansible Automation Platform'],
      ],
    },
  ])

  console.log('\nAll 3 templates created and placed in the shared folder.')
}

main().catch(e => { console.error(e.message); process.exit(1) })
