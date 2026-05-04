// Read-only domain inference test — serial + Flash-Lite
// Usage: bun run scripts/test-domain-inference.ts
// Does NOT write to customers.json

import { waterfallInferDomain } from '../src/domain-waterfall.ts'

// Override model to Flash-Lite for this test
process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite'

// Load customers from test data + known Elmer hard cases
const customersFile = Bun.file('/data/config/customers.json')
let customers: { name: string; domain?: string }[] = []

if (await customersFile.exists()) {
  const { customers: all } = await customersFile.json() as { customers: { name: string; domain?: string; inactive?: boolean }[] }
  customers = all.filter(c => !c.inactive)
} else {
  console.warn('data-test/config/customers.json not found — using hardcoded list only')
}

// Elmer's known hard cases (not currently in test container)
const elmersHardCases = [
  'Condor Bidco',
  'Intrado Life Safety',
  'Taylor Fresh Foods',
  'Uber Technologies',
  'Zoom Video Communications',
  'ServiceNow',
  'Palo Alto Networks',
]

// Merge — avoid duplicates
const toTest = [
  ...customers.map(c => ({ name: c.name, existingDomain: c.domain })),
  ...elmersHardCases
    .filter(n => !customers.some(c => c.name === n))
    .map(n => ({ name: n, existingDomain: undefined })),
]

console.log(`\n=== Domain Inference Test — Flash-Lite + Serial ===`)
console.log(`Testing ${toTest.length} companies...\n`)

const results: { name: string; existing: string; resolved: string; tier: string; verified: string; ms: number }[] = []

for (const { name, existingDomain } of toTest) {
  const start = Date.now()
  const wf = await waterfallInferDomain(name).catch(() => ({ domain: null, tier: null, verified: null }))
  const ms = Date.now() - start

  const result = {
    name,
    existing: existingDomain ?? '—',
    resolved: wf.domain ?? '(none)',
    tier: wf.tier ?? '—',
    verified: wf.verified === true ? '✓' : wf.verified === false ? '✗' : '—',
    ms,
  }
  results.push(result)

  const status = wf.domain
    ? (existingDomain && existingDomain !== wf.domain ? '⚠ DIFF' : '✅')
    : '❌'
  console.log(`${status} ${name.padEnd(40)} → ${(wf.domain ?? '(none)').padEnd(30)} [${wf.tier ?? 'miss'}] ${ms}ms`)
}

console.log('\n=== Summary ===')
const resolved = results.filter(r => r.resolved !== '(none)').length
const missed = results.filter(r => r.resolved === '(none)').length
const diffs = results.filter(r => r.existing !== '—' && r.resolved !== '(none)' && r.existing !== r.resolved)
console.log(`Resolved: ${resolved}/${results.length}`)
console.log(`Missed:   ${missed}/${results.length}`)
if (diffs.length > 0) {
  console.log(`\nDifferences from existing:`)
  diffs.forEach(r => console.log(`  ${r.name}: ${r.existing} → ${r.resolved}`))
}
console.log(`\nMissed companies:`)
results.filter(r => r.resolved === '(none)').forEach(r => console.log(`  ${r.name}`))
