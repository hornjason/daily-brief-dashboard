#!/usr/bin/env bun
/**
 * Tools/TestSettingsMerge.ts
 *
 * Tests merging an updated settings.json from GitHub with existing local settings.
 * Simulates the auto-update mechanism to verify no data loss.
 *
 * Usage: bun Tools/TestSettingsMerge.ts --local <path> [--remote <path>] [--apply]
 *
 * Without --apply: dry-run, shows diff
 * With --apply: actually writes the merged file
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const args = process.argv.slice(2)
const localPath = args[args.indexOf('--local') + 1]
const remotePath = args[args.indexOf('--remote') + 1] || 'scripts/seed-data/settings.json'
const apply = args.includes('--apply')

if (!localPath) {
  console.error('Usage: bun Tools/TestSettingsMerge.ts --local <path> [--remote <path>] [--apply]')
  console.error('')
  console.error('Example (dry-run):')
  console.error('  bun Tools/TestSettingsMerge.ts --local data/config/settings.json')
  console.error('')
  console.error('Example (apply):')
  console.error('  bun Tools/TestSettingsMerge.ts --local data/config/settings.json --apply')
  process.exit(1)
}

interface Settings {
  regions?: any[]
  enabledRegions?: string[]
  enabledPods?: string[]
  [key: string]: any
}

function main() {
  console.log(`\n════════════════════════════════════════════════════════════`)
  console.log(`  Settings Merge Test`)
  console.log(`════════════════════════════════════════════════════════════\n`)

  // Read local (user's current config)
  console.log(`Reading LOCAL:  ${localPath}`)
  const localRaw = readFileSync(resolve(localPath), 'utf-8')
  const local: Settings = JSON.parse(localRaw)

  // Read remote (canonical source)
  console.log(`Reading REMOTE: ${remotePath}`)
  const remoteRaw = readFileSync(resolve(remotePath), 'utf-8')
  const remote: Settings = JSON.parse(remoteRaw)

  console.log(`\n────────────────────────────────────────────────────────────\n`)

  // Merge strategy:
  // 1. Start with remote (latest regions/pods)
  // 2. Preserve local's user-specific fields (enabledRegions, enabledPods, parentFolderId per region)
  const merged: Settings = { ...remote }

  // Preserve user's enabled selections
  if (local.enabledRegions) {
    merged.enabledRegions = local.enabledRegions
    console.log(`✅ Preserved enabledRegions: ${local.enabledRegions.join(', ')}`)
  }

  if (local.enabledPods) {
    merged.enabledPods = local.enabledPods
    console.log(`✅ Preserved enabledPods: ${local.enabledPods.join(', ')}`)
  }

  // Preserve parentFolderId per region (user-specific, set during bootstrap)
  if (merged.regions && local.regions) {
    for (const remoteRegion of merged.regions) {
      const localRegion = local.regions.find(r => r.id === remoteRegion.id)
      if (localRegion && localRegion.parentFolderId) {
        remoteRegion.parentFolderId = localRegion.parentFolderId
        console.log(`✅ Preserved ${remoteRegion.id} parentFolderId: ${localRegion.parentFolderId}`)
      }
    }
  }

  console.log(`\n────────────────────────────────────────────────────────────\n`)

  // Analyze changes
  const localRegions = local.regions || []
  const remoteRegions = remote.regions || []
  const mergedRegions = merged.regions || []

  const newRegions = remoteRegions.filter(r => !localRegions.find(l => l.id === r.id))
  const removedRegions = localRegions.filter(l => !remoteRegions.find(r => r.id === l.id))

  let newPods = 0
  let removedPods = 0

  for (const remoteRegion of remoteRegions) {
    const localRegion = localRegions.find(l => l.id === remoteRegion.id)
    if (localRegion) {
      const remotePodKeys = Object.keys(remoteRegion.pods || {})
      const localPodKeys = Object.keys(localRegion.pods || {})
      newPods += remotePodKeys.filter(k => !localPodKeys.includes(k)).length
      removedPods += localPodKeys.filter(k => !remotePodKeys.includes(k)).length
    }
  }

  console.log(`CHANGES DETECTED:`)
  console.log(`  New regions:    ${newRegions.length}`)
  console.log(`  Removed regions: ${removedRegions.length}`)
  console.log(`  New pods:        ${newPods}`)
  console.log(`  Removed pods:    ${removedPods}`)

  if (newRegions.length > 0) {
    console.log(`\nNew regions:`)
    for (const r of newRegions) {
      console.log(`  + ${r.id} (${r.label}) — ${Object.keys(r.pods || {}).length} pods`)
    }
  }

  if (removedRegions.length > 0) {
    console.log(`\nRemoved regions:`)
    for (const r of removedRegions) {
      console.log(`  - ${r.id} (${r.label})`)
    }
  }

  // Show pod-level changes
  for (const remoteRegion of remoteRegions) {
    const localRegion = localRegions.find(l => l.id === remoteRegion.id)
    if (localRegion) {
      const remotePodKeys = Object.keys(remoteRegion.pods || {})
      const localPodKeys = Object.keys(localRegion.pods || {})
      const added = remotePodKeys.filter(k => !localPodKeys.includes(k))
      const removed = localPodKeys.filter(k => !remotePodKeys.includes(k))

      if (added.length > 0 || removed.length > 0) {
        console.log(`\n${remoteRegion.label} (${remoteRegion.id}):`)
        for (const key of added) {
          const pod = remoteRegion.pods[key]
          console.log(`  + ${key} (${pod.label})`)
        }
        for (const key of removed) {
          console.log(`  - ${key}`)
        }
      }
    }
  }

  console.log(`\n────────────────────────────────────────────────────────────\n`)

  // Verify no critical data loss
  const checks = []

  if (local.enabledRegions && merged.enabledRegions?.length !== local.enabledRegions.length) {
    checks.push(`❌ enabledRegions count mismatch: ${local.enabledRegions.length} → ${merged.enabledRegions?.length}`)
  } else if (local.enabledRegions) {
    checks.push(`✅ enabledRegions preserved (${local.enabledRegions.length} entries)`)
  }

  if (local.enabledPods && merged.enabledPods?.length !== local.enabledPods.length) {
    checks.push(`❌ enabledPods count mismatch: ${local.enabledPods.length} → ${merged.enabledPods?.length}`)
  } else if (local.enabledPods) {
    checks.push(`✅ enabledPods preserved (${local.enabledPods.length} entries)`)
  }

  // Check parentFolderId preservation
  let parentFolderPreserved = 0
  if (merged.regions && local.regions) {
    for (const mergedRegion of merged.regions) {
      const localRegion = local.regions.find(r => r.id === mergedRegion.id)
      if (localRegion && localRegion.parentFolderId && mergedRegion.parentFolderId === localRegion.parentFolderId) {
        parentFolderPreserved++
      }
    }
  }

  if (parentFolderPreserved > 0) {
    checks.push(`✅ parentFolderId preserved for ${parentFolderPreserved} region(s)`)
  }

  console.log(`DATA INTEGRITY CHECKS:`)
  for (const check of checks) {
    console.log(`  ${check}`)
  }

  console.log(`\n════════════════════════════════════════════════════════════`)

  if (apply) {
    console.log(`\n📝 APPLYING MERGE...`)
    const mergedJson = JSON.stringify(merged, null, 2)
    writeFileSync(localPath, mergedJson, 'utf-8')
    console.log(`✅ Wrote merged settings to: ${localPath}`)
    console.log(`\n⚠️  IMPORTANT: Restart the container for changes to take effect`)
  } else {
    console.log(`\n💡 DRY RUN COMPLETE`)
    console.log(`   To apply changes, run with --apply flag`)
    console.log(`   Example: bun Tools/TestSettingsMerge.ts --local ${localPath} --apply`)
  }

  console.log(`════════════════════════════════════════════════════════════\n`)
}

main()
