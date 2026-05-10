#!/usr/bin/env bun
/**
 * Test script: Swap name ↔ aliases and run domain inference
 *
 * Tests whether swapping short names to aliases improves domain inference accuracy.
 * Uses production waterfall: Gemini LLM → Clearbit fallback → validation.
 * Does NOT modify production config — report only.
 */

import { waterfallInferDomain } from '../src/domain-waterfall.ts'
import type { Customer } from '../src/types.ts'

interface TestResult {
  originalName: string
  swappedName: string
  currentDomain: string
  inferredDomain: string
  tier: 'llm' | 'clearbit' | null
  verified: boolean | null
  changed: boolean
}

async function main() {
  // Read production customer config from mounted volume
  const configPath = '/Users/jhorn/hero-test/data/config/customers.json'
  const configFile = Bun.file(configPath)
  const config = await configFile.json()

  const targetAE = 'Garrett Dixon'
  const customers: Customer[] = config.customers.filter((c: Customer) => c.ae === targetAE)

  console.log(`\n## Domain Inference Test: name ↔ aliases swap\n`)
  console.log(`Testing ${customers.length} customers for AE: ${targetAE}\n`)

  const results: TestResult[] = []

  for (const customer of customers) {
    console.log(`Testing: ${customer.name}`)

    // Skip if no aliases to swap with
    if (!customer.aliases || customer.aliases.length === 0) {
      console.log(`  ⚠️  No aliases — skipping\n`)
      results.push({
        originalName: customer.name,
        swappedName: customer.name,
        currentDomain: customer.domain || 'none',
        inferredDomain: 'NO_ALIASES',
        tier: null,
        verified: null,
        changed: false
      })
      continue
    }

    // Swapped name = use the legal name (first alias) as the lookup name
    const swappedName = customer.aliases[0]

    console.log(`  Original: name="${customer.name}", aliases=${JSON.stringify(customer.aliases)}`)
    console.log(`  Swapped:  name="${swappedName}"`)

    // Run production waterfall inference on swapped name (Gemini → Clearbit → validate)
    try {
      const result = await waterfallInferDomain(swappedName)

      const inferredDomain = result.domain || 'NOT_FOUND'
      const changed = inferredDomain !== customer.domain && inferredDomain !== 'NOT_FOUND'

      console.log(`  Result: ${inferredDomain} via ${result.tier || 'none'} ${result.verified === true ? '(verified)' : result.verified === false ? '(unverified)' : ''} ${changed ? '(CHANGED!)' : '(same)'}`)
      console.log(``)

      results.push({
        originalName: customer.name,
        swappedName: swappedName,
        currentDomain: customer.domain || 'none',
        inferredDomain,
        tier: result.tier,
        verified: result.verified,
        changed
      })
    } catch (err) {
      console.error(`  ❌ Error: ${err}`)
      results.push({
        originalName: customer.name,
        swappedName: swappedName,
        currentDomain: customer.domain || 'none',
        inferredDomain: 'ERROR',
        tier: null,
        verified: null,
        changed: false
      })
    }
  }

  // Print markdown table report
  console.log(`\n## Summary Report\n`)
  console.log(`| Original Name | Swapped Name | Current Domain | Inferred Domain | Method | Verified | Changed? |`)
  console.log(`|---------------|--------------|----------------|-----------------|--------|----------|----------|`)

  for (const r of results) {
    const tierStr = r.tier ? r.tier.toUpperCase() : 'NONE'
    const verifiedStr = r.verified === true ? '✅' : r.verified === false ? '❌' : ''
    const changedStr = r.changed ? '✅ YES' : ''
    console.log(`| ${r.originalName} | ${r.swappedName} | ${r.currentDomain} | ${r.inferredDomain} | ${tierStr} | ${verifiedStr} | ${changedStr} |`)
  }

  const changedCount = results.filter(r => r.changed).length
  const llmCount = results.filter(r => r.tier === 'llm').length
  const clearbitCount = results.filter(r => r.tier === 'clearbit').length
  console.log(`\n**${changedCount} of ${results.length} customers would get different domains after swap**`)
  console.log(`**Method breakdown:** ${llmCount} via Gemini LLM, ${clearbitCount} via Clearbit fallback\n`)
}

main().catch(console.error)
