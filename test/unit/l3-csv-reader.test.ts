/**
 * Unit tests for src/lib/l3-csv-reader.ts — ADR-019
 *
 * Uses hand-written stubs for the Drive API. No real network, no auth.
 */
import { test, expect, describe } from 'bun:test'
import { discoverL3Csv, readL3CsvRaw } from '../../src/lib/l3-csv-reader.ts'

// ── Stub Drive API ──────────────────────────────────────────────────────────

interface StubFile {
  id: string
  name: string
  modifiedTime: string
  parents: string[]
}

function makeStubDrive(files: StubFile[]) {
  return {
    files: {
      list: async (params: any) => {
        const q: string = params.q ?? ''
        // Parse folder constraint
        const parentMatch = q.match(/'([^']+)' in parents/)
        const parentId = parentMatch?.[1] ?? ''

        // Filter by parent
        let results = files.filter(f => f.parents.includes(parentId))

        // Filter by name contains clauses
        const nameContainsMatches = [...q.matchAll(/name contains '([^']+)'/g)]
        for (const m of nameContainsMatches) {
          const term = m[1]
          results = results.filter(f => f.name.includes(term))
        }

        // Filter trashed = false (all stub files are not trashed)

        // Sort by modifiedTime desc
        results.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))

        // Apply pageSize
        const pageSize = params.pageSize ?? results.length
        results = results.slice(0, pageSize)

        return {
          data: {
            files: results.map(f => ({
              id: f.id,
              name: f.name,
              modifiedTime: f.modifiedTime,
            })),
          },
        }
      },
      get: async (params: any, opts: any) => {
        const file = files.find(f => f.id === params.fileId)
        if (!file) throw new Error(`File not found: ${params.fileId}`)
        // Return CSV text for media downloads
        return { data: `header1,header2\nval1,val2\n` }
      },
    },
  } as any
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('discoverL3Csv', () => {
  test('finds most recent CSV by modifiedTime', async () => {
    const drive = makeStubDrive([
      { id: 'old', name: 'SF-PIPELINE-WEST_COMM_CORP_NORTHWEST-2026-05-01.csv', modifiedTime: '2026-05-01T00:00:00Z', parents: ['folder1'] },
      { id: 'new', name: 'SF-PIPELINE-WEST_COMM_CORP_NORTHWEST-2026-05-10.csv', modifiedTime: '2026-05-10T00:00:00Z', parents: ['folder1'] },
      { id: 'mid', name: 'SF-PIPELINE-WEST_COMM_CORP_NORTHWEST-2026-05-05.csv', modifiedTime: '2026-05-05T00:00:00Z', parents: ['folder1'] },
    ])

    const result = await discoverL3Csv('folder1', 'SF-PIPELINE-', 'WEST_COMM_CORP_NORTHWEST', drive)
    expect(result).not.toBeNull()
    expect(result!.fileId).toBe('new')
    expect(result!.modifiedTime).toBe('2026-05-10T00:00:00Z')
  })

  test('falls back to any-prefix when pod-specific search returns nothing', async () => {
    const drive = makeStubDrive([
      // No pod-specific file, but a generic pipeline file exists
      { id: 'generic', name: 'SF-PIPELINE-ALL-2026-05-10.csv', modifiedTime: '2026-05-10T00:00:00Z', parents: ['folder1'] },
    ])

    const result = await discoverL3Csv('folder1', 'SF-PIPELINE-', 'NONEXISTENT_POD', drive)
    expect(result).not.toBeNull()
    expect(result!.fileId).toBe('generic')
  })

  test('returns null when no CSV exists', async () => {
    const drive = makeStubDrive([])

    const result = await discoverL3Csv('folder1', 'SF-PIPELINE-', 'ANY_POD', drive)
    expect(result).toBeNull()
  })

  test('returns null for empty folder (no fallback match either)', async () => {
    const drive = makeStubDrive([
      // File in different folder
      { id: 'wrong-folder', name: 'SF-PIPELINE-POD1-2026-05-10.csv', modifiedTime: '2026-05-10T00:00:00Z', parents: ['other-folder'] },
    ])

    const result = await discoverL3Csv('folder1', 'SF-PIPELINE-', 'POD1', drive)
    expect(result).toBeNull()
  })
})

describe('readL3CsvRaw', () => {
  test('returns CSV text from Drive', async () => {
    const drive = makeStubDrive([
      { id: 'file1', name: 'test.csv', modifiedTime: '2026-05-10T00:00:00Z', parents: ['f'] },
    ])

    const text = await readL3CsvRaw('file1', drive)
    expect(text).toContain('header1,header2')
    expect(text).toContain('val1,val2')
  })
})
