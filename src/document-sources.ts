/**
 * Document Sources — GitHub Issue #316
 *
 * CRUD operations for configurable document sources.
 * Sources represent external documents/URLs the system ingests from:
 * Google Slides decks, RSS feeds, email queries, Drive folders, etc.
 *
 * Persisted to document-sources.json in the config directory.
 */

import { existsSync, readFileSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { randomUUID } from 'crypto'

export type DocumentSourceType =
  | 'google-slides'
  | 'google-doc'
  | 'google-drive-folder'
  | 'url'
  | 'email'
  | 'rss'

export interface DocumentSource {
  id: string
  name: string
  type: DocumentSourceType
  identifier: string
  configKey?: string
  lastFetched?: string | null
  status: 'ok' | 'error' | 'pending' | 'stale'
  error?: string
}

interface DocumentSourcesFile {
  sources: DocumentSource[]
}

function readFile(path: string): DocumentSourcesFile {
  if (!existsSync(path)) return { sources: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return { sources: Array.isArray(raw.sources) ? raw.sources : [] }
  } catch {
    return { sources: [] }
  }
}

function writeFile(path: string, data: DocumentSourcesFile): void {
  writeJsonAtomic(path, data)
}

export function loadDocumentSources(path: string): DocumentSource[] {
  return readFile(path).sources
}

export function addDocumentSource(
  path: string,
  source: Omit<DocumentSource, 'id'>,
): DocumentSource {
  const data = readFile(path)
  const newSource: DocumentSource = {
    ...source,
    id: randomUUID().slice(0, 8),
  }
  data.sources.push(newSource)
  writeFile(path, data)
  return newSource
}

export function updateDocumentSource(
  path: string,
  id: string,
  updates: Partial<Omit<DocumentSource, 'id'>>,
): DocumentSource | null {
  const data = readFile(path)
  const idx = data.sources.findIndex(s => s.id === id)
  if (idx === -1) return null
  data.sources[idx] = { ...data.sources[idx], ...updates }
  writeFile(path, data)
  return data.sources[idx]
}

export function removeDocumentSource(path: string, id: string): boolean {
  const data = readFile(path)
  const before = data.sources.length
  data.sources = data.sources.filter(s => s.id !== id)
  if (data.sources.length === before) return false
  writeFile(path, data)
  return true
}
