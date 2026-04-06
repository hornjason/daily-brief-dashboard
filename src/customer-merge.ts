// src/customer-merge.ts
// Merge-not-replace helper for customers.json writes.
// Preserves AI-enriched fields across rewrites.

// Fields that must survive a customers.json overwrite.
// Also preserves any field whose key starts with 'ai' or 'intelligence'.
const PRESERVED_FIELDS = ['segment', 'industry', 'confidenceScore'] as const

function isPreservedField(key: string): boolean {
  return (PRESERVED_FIELDS as readonly string[]).includes(key)
    || key.startsWith('ai')
    || key.startsWith('intelligence')
}

/**
 * Merge incoming customer records over existing ones, preserving enriched
 * fields from existing records that the incoming data doesn't supply.
 *
 * - New records not in `existing` are passed through unchanged.
 * - Existing records not in `incoming` are dropped (caller decides list).
 * - For records in both: incoming fields win; missing enriched fields from
 *   `existing` are carried forward.
 *
 * @param incoming  Fresh array being written to disk
 * @param existing  Current on-disk array (may be empty if file didn't exist)
 */
export function mergeCustomers(
  incoming: Record<string, any>[],
  existing: Record<string, any>[]
): Record<string, any>[] {
  const existingMap = new Map(existing.map(c => [c.id ?? c.name, c]))
  return incoming.map(c => {
    const key = c.id ?? c.name
    const prev = existingMap.get(key)
    if (!prev) return c
    const preserved: Record<string, any> = {}
    for (const field of Object.keys(prev)) {
      if (isPreservedField(field) && prev[field] !== undefined && c[field] === undefined) {
        preserved[field] = prev[field]
      }
    }
    return { ...c, ...preserved }
  })
}

import { readFileSync } from 'node:fs'

/**
 * Read the existing customers array from a JSON file on disk.
 * Returns an empty array if the file doesn't exist or can't be parsed.
 */
export function readExistingCustomers(filePath: string): Record<string, any>[] {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw).customers ?? []
  } catch {
    return []
  }
}
