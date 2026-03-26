import { google } from 'googleapis'
import { makeAuth } from './src/google.ts'
import { resolve } from 'path'

const CI_CONFIG = resolve(import.meta.dir, '../../config')
const SHEETS_TOKEN_PATH = process.env.SHEETS_TOKEN ?? `${CI_CONFIG}/.sheets-token.json`
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? `${CI_CONFIG}/.gdrive-server-credentials.json`

const parentId = process.env.AE_PARENT_FOLDER_ID
if (!parentId) { console.error('AE_PARENT_FOLDER_ID not set'); process.exit(1) }

const driveAuth = makeAuth(GDRIVE_TOKEN_PATH)
const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
const drive = google.drive({ version: 'v3', auth: driveAuth })
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

const foldersRes = await drive.files.list({
  q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  fields: 'files(id,name)', pageSize: 50,
})

console.log('AE folders found:')
for (const f of foldersRes.data.files ?? []) {
  console.log(' -', f.name, ':', f.id)
}

for (const folder of foldersRes.data.files ?? []) {
  if (!folder.name?.toLowerCase().includes('elmer') && !folder.name?.toLowerCase().includes('carolanne')) continue
  
  console.log(`\n--- Searching folder: ${folder.name} ---`)
  
  const filesRes = await drive.files.list({
    q: `'${folder.id}' in parents and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
    fields: 'files(id,name,mimeType,shortcutDetails)', pageSize: 50,
  })
  
  for (const file of filesRes.data.files ?? []) {
    let spreadsheetId = file.id!
    if (file.mimeType === 'application/vnd.google-apps.shortcut') {
      spreadsheetId = (file as any).shortcutDetails?.targetId
      if (!spreadsheetId) continue
    }
    
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets.properties.title'
    }).catch(() => null)
    
    if (!meta) continue
    const title = meta.data.properties?.title
    const tabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
    
    const ccspTab = tabs.find(t => t.toLowerCase().includes('ccsp'))
    if (ccspTab) {
      console.log(`\nFOUND in: "${title}" (${spreadsheetId})`)
      console.log(`Tab: "${ccspTab}"`)
      console.log(`All tabs: ${tabs.join(', ')}`)
      
      const dataRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${ccspTab}'!A:Z`
      })
      const rows = dataRes.data.values ?? []
      if (rows.length > 0) {
        console.log(`\nHeaders: ${rows[0].join(' | ')}`)
        console.log(`Row count: ${rows.length - 1} data rows`)
        console.log('\nFirst 3 data rows:')
        for (const row of rows.slice(1, 4)) {
          console.log(' ', row.join(' | '))
        }
        // Show all unique customers
        if (rows.length > 1) {
          const custCol = rows[0].findIndex((h: string) => h.toLowerCase().includes('customer') || h.toLowerCase().includes('account'))
          if (custCol >= 0) {
            const customers = [...new Set(rows.slice(1).map((r: string[]) => r[custCol]).filter(Boolean))]
            console.log(`\nUnique customers/accounts: ${customers.join(', ')}`)
          }
        }
      }
    } else {
      console.log(`Spreadsheet "${title}" tabs: ${tabs.join(', ')}`)
    }
  }
}
