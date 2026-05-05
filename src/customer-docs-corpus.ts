/**
 * Customer Docs Corpus — Wave 5 Phase 1
 *
 * Caches extracted text from a customer's Google Drive account docs
 * for use in product intel generation. Written at brief-generation time,
 * read by product intel route. Zero additional Drive API calls.
 *
 * Cache path: data/cache/product-intel/customer-docs/{customerSlug}.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import type { DriveFile } from './types.ts'
import { getAutomationConfig } from './ai-config.ts'

export interface CustomerDocsCorpusFile {
  name: string
  textContent: string
  modifiedTime?: string
  mimeType: string
}

export interface CustomerDocsCorpus {
  customerSlug: string
  files: CustomerDocsCorpusFile[]
  corpusHash: string
  extractedAt: string
}

const TOTAL_TEXT_CAP = 60_000  // chars across all docs

function corpusCacheDir(): string {
  return resolve(process.env.CACHE_DIR ?? resolve(import.meta.dir, '../data/cache'), 'product-intel/customer-docs')
}

function corpusCachePath(customerSlug: string): string {
  if (!customerSlug || /[^a-zA-Z0-9_-]/.test(customerSlug)) {
    throw new Error(`[customer-docs-corpus] unsafe slug for cache path: "${customerSlug}"`)
  }
  return resolve(corpusCacheDir(), `${customerSlug}.json`)
}

export function getCachedCustomerDocsCorpus(customerSlug: string): CustomerDocsCorpus | null {
  try {
    return JSON.parse(readFileSync(corpusCachePath(customerSlug), 'utf-8'))
  } catch {
    return null
  }
}

export function writeCustomerDocsCorpus(customerSlug: string, docs: DriveFile[]): CustomerDocsCorpus {
  const files: CustomerDocsCorpusFile[] = []
  let totalChars = 0

  for (const doc of docs) {
    if (!doc.content || doc.content.length < 50) continue
    if (totalChars >= TOTAL_TEXT_CAP) break
    const capped = doc.content.slice(0, getAutomationConfig().driveDocTextCap)
    files.push({
      name: doc.name,
      textContent: capped,
      modifiedTime: doc.modifiedTime,
      mimeType: doc.mimeType,
    })
    totalChars += capped.length
  }

  const corpusHash = createHash('sha256')
    .update(files.map(f => f.textContent).join('\n'))
    .digest('hex')
    .slice(0, 16)

  const corpus: CustomerDocsCorpus = {
    customerSlug,
    files,
    corpusHash,
    extractedAt: new Date().toISOString(),
  }

  try {
    mkdirSync(corpusCacheDir(), { recursive: true })
    writeFileSync(corpusCachePath(customerSlug), JSON.stringify(corpus, null, 2), { mode: 0o600 })
  } catch (e: any) {
    console.warn(`[customer-docs-corpus] write failed for ${customerSlug}:`, e?.message)
  }

  return corpus
}
