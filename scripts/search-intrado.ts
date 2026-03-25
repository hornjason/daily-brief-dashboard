import { google } from 'googleapis'
import { makeAuth } from '../src/google.ts'

const CI_CONFIG = '/Users/jhorn/.claude/PAI/Projects/CustomerIntelligence/config'
const driveAuth = makeAuth(`${CI_CONFIG}/.gdrive-server-credentials.json`)
const sheetsAuth = makeAuth(`${CI_CONFIG}/.sheets-token.json`)
const drive = google.drive({ version: 'v3', auth: driveAuth })
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

const parentId = process.env.AE_PARENT_FOLDER_ID!

// Get Elmer's folder
const foldersRes = await drive.files.list({
  q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  fields: 'files(id,name)', pageSize: 50,
})
const elmerFolder = (foldersRes.data.files ?? []).find(f => f.name?.toLowerCase().includes('elmer'))
if (!elmerFolder?.id) { console.log('No Elmer folder'); process.exit(1) }

// Get all spreadsheets in Elmer's folder
const filesRes = await drive.files.list({
  q: `'${elmerFolder.id}' in parents and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
  fields: 'files(id,name,mimeType,shortcutDetails)', pageSize: 50,
})

for (const file of filesRes.data.files ?? []) {
  let spreadsheetId = file.id!
  if (file.mimeType === 'application/vnd.google-apps.shortcut') {
    spreadsheetId = (file as any).shortcutDetails?.targetId
    if (!spreadsheetId) continue
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties.title,sheets.properties.title' }).catch(() => null)
  if (!meta) continue

  const title = meta.data.properties?.title
  const tabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
  console.log(`\n=== Spreadsheet: "${title}" ===`)

  for (const tab of tabs) {
    const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A:Z` }).catch(() => null)
    const rows = dataRes?.data.values ?? []
    // Search every cell for "intrado"
    const matchingRows = rows.filter(row => row.some(cell => String(cell ?? '').toLowerCase().includes('intrado')))
    if (matchingRows.length > 0) {
      console.log(`\n  Tab: "${tab}" — ${matchingRows.length} rows containing "intrado"`)
      if (rows.length > 0) console.log(`  Headers: ${rows[0].join(' | ')}`)
      for (const row of matchingRows.slice(0, 5)) {
        console.log(`  Row: ${row.join(' | ')}`)
      }
    }
  }
}
