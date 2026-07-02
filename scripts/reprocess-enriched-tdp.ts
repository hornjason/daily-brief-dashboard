/**
 * scripts/reprocess-enriched-tdp.ts — Apply TDP normalization to existing enriched data (#962)
 *
 * Reads _enriched.json files, applies resolveTdpAlignment() to each document's
 * tdpAlignment field, writes back. No Gemini calls — pure deterministic transform.
 *
 * Usage: bun scripts/reprocess-enriched-tdp.ts [product-slug]
 * If no slug given, processes all products.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { resolveTdpAlignment } from '../src/lib/document-intelligence-resolver.ts'

const PRODUCTS_DIR = resolve(import.meta.dir, '../config-templates/saleshub-products')

function processEnrichedFile(filePath: string): { total: number, changed: number, before: Set<string>, after: Set<string> } {
  const raw = readFileSync(filePath, 'utf-8')
  const data = JSON.parse(raw)
  const docs = data.documents ?? []

  const beforeValues = new Set<string>()
  const afterValues = new Set<string>()
  let changed = 0

  for (const doc of docs) {
    const original = doc.tdpAlignment as string[] | null
    if (original) {
      for (const v of original) beforeValues.add(v)
    }

    const normalized = resolveTdpAlignment(original)
    if (normalized) {
      for (const v of normalized) afterValues.add(v)
    }

    if (JSON.stringify(original) !== JSON.stringify(normalized)) {
      doc.tdpAlignment = normalized
      changed++
    }
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
  return { total: docs.length, changed, before: beforeValues, after: afterValues }
}

const slug = process.argv[2]
const dirs = slug
  ? [join(PRODUCTS_DIR, slug)]
  : readdirSync(PRODUCTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(PRODUCTS_DIR, d.name))

for (const dir of dirs) {
  const enrichedPath = join(dir, '_enriched.json')
  if (!existsSync(enrichedPath)) continue

  const productName = dir.split('/').pop()
  console.log(`\nProcessing: ${productName}`)

  const result = processEnrichedFile(enrichedPath)
  console.log(`  Total docs: ${result.total}`)
  console.log(`  Changed: ${result.changed}`)
  console.log(`  TDP values before (${result.before.size}): ${[...result.before].sort().join(', ')}`)
  console.log(`  TDP values after (${result.after.size}): ${[...result.after].sort().join(', ')}`)
}
