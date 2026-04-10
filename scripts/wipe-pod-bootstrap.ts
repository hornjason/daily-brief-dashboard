/**
 * Wipe all POD bootstrap data:
 * - Delete AE Drive folders from Google Drive
 * - Clear aes.json
 * - Remove bootstrapped AE customers from customers.json
 *
 * Usage: bun run scripts/wipe-pod-bootstrap.ts
 */
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { google } from 'googleapis'
import { makeAuth } from '../src/google.ts'

const CONFIG_DIR = resolve(import.meta.dir, '../data/config')
const GOOGLE_UNIFIED_TOKEN_PATH = resolve(CONFIG_DIR, '.google-token.json')
const AES_PATH = resolve(CONFIG_DIR, 'aes.json')
const CUSTOMERS_PATH = resolve(CONFIG_DIR, 'customers.json')

async function main() {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')
  const drive = google.drive({ version: 'v3', auth })

  const aesData = JSON.parse(readFileSync(AES_PATH, 'utf-8')) as { aes: Array<{ name: string; driveFolderId?: string }> }
  const aesToWipe = aesData.aes

  console.log(`Found ${aesToWipe.length} AEs to wipe`)

  // 1. Delete Drive folders
  for (const ae of aesToWipe) {
    if (!ae.driveFolderId) {
      console.log(`  [skip] ${ae.name} — no driveFolderId`)
      continue
    }
    try {
      await drive.files.update({ fileId: ae.driveFolderId, requestBody: { trashed: true } })
      console.log(`  [trashed] ${ae.name} — folder ${ae.driveFolderId}`)
    } catch (e: any) {
      if (e?.code === 404 || e?.status === 404) {
        console.log(`  [already gone] ${ae.name} — folder ${ae.driveFolderId}`)
      } else {
        console.error(`  [error] ${ae.name} — ${e?.message}`)
      }
    }
  }

  // 2. Clear aes.json
  const aeNames = new Set(aesToWipe.map(a => a.name))
  writeFileSync(AES_PATH, JSON.stringify({ aes: [] }, null, 2))
  console.log(`\naes.json cleared (${aesToWipe.length} AEs removed)`)

  // 3. Remove their customers from customers.json
  const customersFile = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8')) as { customers: Array<{ ae?: string }> }
  const before = customersFile.customers.length
  const remaining = customersFile.customers.filter(c => !c.ae || !aeNames.has(c.ae))
  writeFileSync(CUSTOMERS_PATH, JSON.stringify({ customers: remaining }, null, 2))
  console.log(`customers.json: removed ${before - remaining.length} customers, ${remaining.length} remain`)

  console.log('\nWipe complete.')
}

main().catch(e => { console.error(e); process.exit(1) })
