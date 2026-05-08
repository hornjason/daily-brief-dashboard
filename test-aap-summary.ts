#!/usr/bin/env bun
/**
 * Test AAP summary generation after removing lifecycleUrl
 */
import { fetchProductSummary } from './src/product-release-radar.ts'

process.env.DATA_DIR = './data'
process.env.CONFIG_DIR = './data/config'
process.env.CACHE_DIR = './data/cache'

console.log('Testing AAP summary generation without lifecycleUrl...\n')

const summary = await fetchProductSummary('aap')

console.log('✅ Summary generated:\n')
console.log(`Display Name: ${summary.displayName}`)
console.log(`Current Version: ${summary.currentVersion}`)
console.log(`\nSummary Text:\n${summary.summaryText}\n`)
console.log(`Summary Bullets:`)
summary.summaryBullets.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
console.log(`\nSources (${summary.sources.length}):`)
summary.sources.forEach(s => console.log(`  - ${s}`))
