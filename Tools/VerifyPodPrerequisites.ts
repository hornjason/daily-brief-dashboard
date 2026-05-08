#!/usr/bin/env bun
/**
 * Tools/VerifyPodPrerequisites.ts
 *
 * Checks if a pod has all required prerequisites to work:
 * 1. SF Bookings GSheet exists in Drive
 * 2. SF Report ID is accessible (if set)
 * 3. Pod key format is valid for CCSP territory filtering
 *
 * Usage: bun Tools/VerifyPodPrerequisites.ts --region east-commercial --pod EAST_COMM_CORP_POD01
 */

import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../src/google.ts'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { normalizeSettings } from '../src/region-config.ts'

const args = process.argv.slice(2)
const regionId = args[args.indexOf('--region') + 1]
const podKey = args[args.indexOf('--pod') + 1]

if (!regionId || !podKey) {
  console.error('Usage: bun Tools/VerifyPodPrerequisites.ts --region <id> --pod <podKey>')
  console.error('Example: bun Tools/VerifyPodPrerequisites.ts --region east-commercial --pod EAST_COMM_CORP_POD01')
  process.exit(1)
}

async function main() {
  console.log(`\n════════════════════════════════════════════════════════════`)
  console.log(`  Verifying Prerequisites: ${regionId} / ${podKey}`)
  console.log(`════════════════════════════════════════════════════════════\n`)

  // Read settings.json
  const settingsPath = resolve(import.meta.dir, '../scripts/seed-data/settings.json')
  const rawSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  const settings = normalizeSettings(rawSettings)

  // Find region
  const region = settings.regions.find(r => r.id === regionId)
  if (!region) {
    console.error(`❌ Region "${regionId}" not found in settings.json`)
    process.exit(1)
  }

  // Find pod
  const pod = region.pods[podKey]
  if (!pod) {
    console.error(`❌ Pod "${podKey}" not found in region "${regionId}"`)
    process.exit(1)
  }

  console.log(`Region: ${region.label}`)
  console.log(`Pod: ${pod.label}`)
  console.log(`SF Report ID: ${pod.sfReportId || '(not set)'}`)
  console.log(`\n────────────────────────────────────────────────────────────\n`)

  let allPassed = true

  // Check 1: Pod key format (must be all-caps, underscores, alphanumeric)
  const validFormat = /^[A-Z0-9_]+$/.test(podKey)
  if (validFormat) {
    console.log(`✅ Pod key format valid (matches CCSP territory filter pattern)`)
  } else {
    console.log(`❌ Pod key format invalid (must be all-caps, underscores, alphanumeric only)`)
    console.log(`   Got: "${podKey}"`)
    allPassed = false
  }

  // Check 2: SF Bookings GSheet exists
  console.log(`\nChecking for SF Bookings GSheet in Drive...`)
  const expectedSheetName = `${podKey} POD - Subscriptions`

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    if (!region.podBookingsFolderId) {
      console.log(`⚠️  podBookingsFolderId not set in region config`)
      allPassed = false
    } else {
      const listRes = await withQuotaRetry(() =>
        drive.files.list({
          q: `name = '${expectedSheetName}' and '${region.podBookingsFolderId}' in parents and trashed = false`,
          fields: 'files(id, name, modifiedTime)',
        })
      )

      const files = listRes.data.files ?? []
      if (files.length > 0) {
        console.log(`✅ SF Bookings GSheet found: "${files[0].name}"`)
        console.log(`   Drive ID: ${files[0].id}`)
        console.log(`   Last modified: ${files[0].modifiedTime}`)
      } else {
        console.log(`❌ SF Bookings GSheet NOT found`)
        console.log(`   Expected name: "${expectedSheetName}"`)
        console.log(`   Folder: ${region.podBookingsFolderId}`)
        allPassed = false
      }
    }
  } catch (e: any) {
    console.log(`❌ Drive API error: ${e.message}`)
    allPassed = false
  }

  // Check 3: SF Report ID (if set)
  if (!pod.sfReportId) {
    console.log(`\n⚠️  SF Report ID not set (pod will be skipped by L4 daemon)`)
    allPassed = false
  } else {
    console.log(`\n✅ SF Report ID is set: ${pod.sfReportId}`)
    console.log(`   Note: Cannot verify accessibility without Salesforce credentials`)
    console.log(`   Daemon will validate this on first sync attempt`)
  }

  // Check 4: CCSP CSV cache (if exists)
  console.log(`\nChecking for existing CCSP L3 cache in Drive...`)
  const today = new Date().toISOString().slice(0, 10)
  const ccspFileName = `CCSP-${podKey}-${today}.csv`

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    if (region.podBookingsFolderId) {
      const listRes = await withQuotaRetry(() =>
        drive.files.list({
          q: `name contains 'CCSP-${podKey}-' and '${region.podBookingsFolderId}' in parents and trashed = false`,
          fields: 'files(id, name, modifiedTime)',
          orderBy: 'modifiedTime desc',
        })
      )

      const files = listRes.data.files ?? []
      if (files.length > 0) {
        console.log(`✅ CCSP L3 cache found: "${files[0].name}"`)
        console.log(`   Last modified: ${files[0].modifiedTime}`)
        if (files[0].name === ccspFileName) {
          console.log(`   ✓ Today's cache exists — hero installs can use it immediately`)
        } else {
          console.log(`   ⚠️  Cache is from previous date — daemon needs to run L4 scrape`)
        }
      } else {
        console.log(`⚠️  No CCSP L3 cache found`)
        console.log(`   Daemon will need to run Tableau L4 scrape on first sync`)
      }
    }
  } catch (e: any) {
    console.log(`⚠️  Could not check CCSP cache: ${e.message}`)
  }

  console.log(`\n════════════════════════════════════════════════════════════`)
  if (allPassed) {
    console.log(`✅ ALL CHECKS PASSED — Pod is ready for L4 daemon sync`)
  } else {
    console.log(`⚠️  SOME CHECKS FAILED — See details above`)
  }
  console.log(`════════════════════════════════════════════════════════════\n`)

  process.exit(allPassed ? 0 : 1)
}

main().catch(e => {
  console.error(`\n❌ Fatal error: ${e.message}`)
  process.exit(1)
})
