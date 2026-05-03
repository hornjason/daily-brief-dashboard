/**
 * Unit tests for src/lib/drive-client.ts.
 *
 * Uses a hand-written stub for `drive.files.list` and `drive.files.create`
 * — no real Drive folder, no network, no auth. Each test asserts on
 * observable behavior through the public DriveFolderClient interface.
 */
import { test, expect, describe } from 'bun:test'
import type { drive_v3 } from 'googleapis'
import { DriveFolderClient } from '../../src/lib/drive-client.ts'

// ── Stub Drive backend ───────────────────────────────────────────────────────

interface FolderEntry {
  id: string
  name: string
  parents: string[]
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
  shortcutDetails?: { targetId: string; targetMimeType: string }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

interface ListCall {
  q: string
  supportsAllDrives?: boolean
  includeItemsFromAllDrives?: boolean
  pageSize?: number
}
interface CreateCall {
  name: string
  mimeType: string
  parents?: string[]
  supportsAllDrives?: boolean
}

class StubDrive {
  entries: FolderEntry[] = []
  listCalls: ListCall[] = []
  createCalls: CreateCall[] = []

  files = {
    list: async (params: any) => {
      this.listCalls.push({
        q: params.q,
        supportsAllDrives: params.supportsAllDrives,
        includeItemsFromAllDrives: params.includeItemsFromAllDrives,
        pageSize: params.pageSize,
      })
      const result = this.runQuery(params.q ?? '')
      return { data: { files: result, nextPageToken: undefined } }
    },
    create: async (params: any) => {
      const body = params.requestBody ?? {}
      this.createCalls.push({
        name: body.name,
        mimeType: body.mimeType,
        parents: body.parents,
        supportsAllDrives: params.supportsAllDrives,
      })
      const id = `created-${this.createCalls.length}`
      const entry: FolderEntry = {
        id,
        name: body.name,
        parents: body.parents ?? [],
        mimeType: body.mimeType,
      }
      this.entries.push(entry)
      return { data: { id } }
    },
  }

  /**
   * Tiny query parser — enough to handle the patterns drive-client emits:
   *   - "'<parentId>' in parents"
   *   - "mimeType = '<mime>'"  /  "mimeType != '<mime>'"
   *   - "name='<n>'"  /  "name = '<n>'"
   *   - "trashed = false"  /  "trashed=false"
   *   - "modifiedTime > '<iso>'"
   * Combined with " and ".
   */
  private runQuery(q: string): drive_v3.Schema$File[] {
    if (!q) return []
    const clauses = q.split(/\s+and\s+/i)
    const filters: Array<(e: FolderEntry) => boolean> = []
    for (const raw of clauses) {
      const c = raw.trim()
      let m: RegExpMatchArray | null
      if ((m = c.match(/^'([^']+)' in parents$/))) {
        const parent = m[1]
        filters.push((e) => e.parents.includes(parent))
        continue
      }
      if ((m = c.match(/^mimeType\s*=\s*'([^']+)'$/))) {
        const mime = m[1]
        filters.push((e) => e.mimeType === mime)
        continue
      }
      if ((m = c.match(/^mimeType\s*!=\s*'([^']+)'$/))) {
        const mime = m[1]
        filters.push((e) => e.mimeType !== mime)
        continue
      }
      if ((m = c.match(/^name\s*=\s*'(.+)'$/))) {
        const name = m[1].replace(/\\'/g, "'")
        filters.push((e) => e.name === name)
        continue
      }
      if ((m = c.match(/^trashed\s*=\s*false$/))) {
        // all stub entries are not trashed
        continue
      }
      if ((m = c.match(/^modifiedTime\s*>\s*'([^']+)'$/))) {
        const cutoff = new Date(m[1]).getTime()
        filters.push((e) => {
          if (!e.modifiedTime) return false
          return new Date(e.modifiedTime).getTime() > cutoff
        })
        continue
      }
      // Unknown clause: be conservative — match nothing
      filters.push(() => false)
    }
    return this.entries
      .filter((e) => filters.every((f) => f(e)))
      .map((e) => ({
        id: e.id,
        name: e.name,
        mimeType: e.mimeType,
        modifiedTime: e.modifiedTime,
        webViewLink: e.webViewLink,
        shortcutDetails: e.shortcutDetails,
      }))
  }
}

function makeClient(stub: StubDrive): DriveFolderClient {
  return new DriveFolderClient('/dev/null/test-token-path-not-used', {
    drive: stub as unknown as drive_v3.Drive,
  })
}

function folder(id: string, name: string, parents: string[]): FolderEntry {
  return { id, name, parents, mimeType: FOLDER_MIME }
}
function sheet(id: string, name: string, parents: string[], modifiedTime?: string): FolderEntry {
  return { id, name, parents, mimeType: SPREADSHEET_MIME, modifiedTime }
}
function file(
  id: string,
  name: string,
  parents: string[],
  mimeType = 'application/pdf',
  modifiedTime?: string,
): FolderEntry {
  return { id, name, parents, mimeType, modifiedTime }
}

// ── findDescendantFolder ─────────────────────────────────────────────────────

describe('findDescendantFolder', () => {
  test('returns folder ID on exact match at depth 1', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('aeRoot', 'AE Root', []),
      folder('cust1', 'Acme Corp', ['aeRoot']),
      folder('cust2', 'Other', ['aeRoot']),
    )
    const client = makeClient(stub)

    const id = await client.findDescendantFolder('aeRoot', 'Acme Corp')

    expect(id).toBe('cust1')
    // Always-on supportsAllDrives flags
    expect(stub.listCalls.every((c) => c.supportsAllDrives === true)).toBe(true)
    expect(stub.listCalls.every((c) => c.includeItemsFromAllDrives === true)).toBe(true)
  })

  test('returns folder ID on fuzzy match at depth 1', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('aeRoot', 'AE', []),
      folder('cust1', 'Acme Corporation, Inc.', ['aeRoot']),
    )
    const client = makeClient(stub)

    const id = await client.findDescendantFolder('aeRoot', 'Acme', { fuzzy: true })

    expect(id).toBe('cust1')
  })

  test('searches depth 2 when depth 1 has no match', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('aeRoot', 'AE', []),
      folder('subA', 'Accounts', ['aeRoot']),
      folder('cust1', 'Globex', ['subA']),
    )
    const client = makeClient(stub)

    const id = await client.findDescendantFolder('aeRoot', 'Globex', { maxDepth: 2 })

    expect(id).toBe('cust1')
  })

  test('returns null when no match at any depth', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('aeRoot', 'AE', []),
      folder('subA', 'Accounts', ['aeRoot']),
      folder('cust1', 'Initech', ['subA']),
    )
    const client = makeClient(stub)

    const id = await client.findDescendantFolder('aeRoot', 'Globex', { maxDepth: 2 })

    expect(id).toBeNull()
  })
})

// ── ensureChildFolder ────────────────────────────────────────────────────────

describe('ensureChildFolder', () => {
  test('returns existing folder ID when folder already exists', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('aeRoot', 'AE', []),
      folder('plansFolder', 'Account Plans', ['aeRoot']),
    )
    const client = makeClient(stub)

    const id = await client.ensureChildFolder('aeRoot', 'Account Plans')

    expect(id).toBe('plansFolder')
    expect(stub.createCalls.length).toBe(0)
  })

  test('creates and returns new folder ID when folder does not exist', async () => {
    const stub = new StubDrive()
    stub.entries.push(folder('aeRoot', 'AE', []))
    const client = makeClient(stub)

    const id = await client.ensureChildFolder('aeRoot', 'Account Plans')

    expect(id).toBe('created-1')
    expect(stub.createCalls.length).toBe(1)
    expect(stub.createCalls[0]).toMatchObject({
      name: 'Account Plans',
      mimeType: FOLDER_MIME,
      parents: ['aeRoot'],
      supportsAllDrives: true,
    })
  })
})

// ── listSpreadsheetsUnder ────────────────────────────────────────────────────

describe('listSpreadsheetsUnder', () => {
  test('returns IDs from multiple folder depths', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'POD', []),
      sheet('sheetA', 'Top Sheet', ['root']),
      folder('sub1', 'Subfolder', ['root']),
      sheet('sheetB', 'Nested Sheet', ['sub1']),
    )
    const client = makeClient(stub)

    const result = await client.listSpreadsheetsUnder('root')

    const ids = result.map((r) => r.id).sort()
    expect(ids).toEqual(['sheetA', 'sheetB'])
  })

  test('with maxDepth: 0 returns only root-level sheets', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'POD', []),
      sheet('sheetA', 'Top Sheet', ['root']),
      folder('sub1', 'Subfolder', ['root']),
      sheet('sheetB', 'Nested Sheet', ['sub1']),
    )
    const client = makeClient(stub)

    const result = await client.listSpreadsheetsUnder('root', { maxDepth: 0 })

    expect(result.map((r) => r.id)).toEqual(['sheetA'])
  })

  test('deduplicates IDs across depths', async () => {
    // A spreadsheet that lives at root AND is also targeted by a shortcut in a subfolder
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'POD', []),
      sheet('sheetA', 'Sheet A', ['root']),
      folder('sub1', 'Subfolder', ['root']),
      {
        id: 'shortcutA',
        name: 'Shortcut to Sheet A',
        parents: ['sub1'],
        mimeType: SHORTCUT_MIME,
        shortcutDetails: { targetId: 'sheetA', targetMimeType: SPREADSHEET_MIME },
      },
    )
    const client = makeClient(stub)

    const result = await client.listSpreadsheetsUnder('root')

    expect(result.map((r) => r.id)).toEqual(['sheetA'])
  })
})

// ── listFilesUnder ───────────────────────────────────────────────────────────

describe('listFilesUnder', () => {
  test('collects files across subdirectories', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'Customer', []),
      file('f1', 'doc1.pdf', ['root']),
      folder('sub1', 'Sub', ['root']),
      file('f2', 'doc2.pdf', ['sub1']),
    )
    const client = makeClient(stub)

    const result = await client.listFilesUnder('root')

    const ids = result.map((r) => r.id).sort()
    expect(ids).toEqual(['f1', 'f2'])
  })

  test('respects modifiedAfter filter', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'Customer', []),
      file('fNew', 'new.pdf', ['root'], 'application/pdf', '2026-04-01T00:00:00Z'),
      file('fOld', 'old.pdf', ['root'], 'application/pdf', '2024-01-01T00:00:00Z'),
    )
    const client = makeClient(stub)

    const cutoff = new Date('2025-06-01T00:00:00Z')
    const result = await client.listFilesUnder('root', { modifiedAfter: cutoff })

    expect(result.map((r) => r.id)).toEqual(['fNew'])
  })

  test('respects maxFiles cap', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'Customer', []),
      file('f1', 'a.pdf', ['root'], 'application/pdf', '2026-04-01T00:00:00Z'),
      file('f2', 'b.pdf', ['root'], 'application/pdf', '2026-04-02T00:00:00Z'),
      file('f3', 'c.pdf', ['root'], 'application/pdf', '2026-04-03T00:00:00Z'),
      file('f4', 'd.pdf', ['root'], 'application/pdf', '2026-04-04T00:00:00Z'),
    )
    const client = makeClient(stub)

    const result = await client.listFilesUnder('root', { maxFiles: 2 })

    expect(result.length).toBe(2)
  })
})

// ── followFolderShortcuts option ─────────────────────────────────────────────

describe('followFolderShortcuts option', () => {
  test('followFolderShortcuts: false (default) — shortcut files excluded and targets not traversed', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'Customer', []),
      file('f1', 'doc1.pdf', ['root']),
      // A shortcut pointing to a folder
      {
        id: 'sc1',
        name: 'Shortcut to Sub',
        parents: ['root'],
        mimeType: SHORTCUT_MIME,
        shortcutDetails: { targetId: 'targetFolder', targetMimeType: FOLDER_MIME },
      },
      // The target folder and a file inside it
      folder('targetFolder', 'Target Subfolder', []),
      file('f2', 'doc2.pdf', ['targetFolder']),
    )
    const client = makeClient(stub)

    const result = await client.listFilesUnder('root')

    // f2 must not appear — shortcut target was not traversed
    const ids = result.map((r) => r.id).sort()
    expect(ids).toEqual(['f1'])
    // No query that specifically lists shortcuts (mimeType = SHORTCUT_MIME) should have been issued
    const shortcutListCalls = stub.listCalls.filter((c) => c.q.includes(`mimeType = '${SHORTCUT_MIME}'`))
    expect(shortcutListCalls.length).toBe(0)
  })

  test('followFolderShortcuts: true — shortcut pointing to a folder causes that folder files to be included', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'Customer', []),
      file('f1', 'doc1.pdf', ['root']),
      // A shortcut pointing to a folder
      {
        id: 'sc1',
        name: 'Shortcut to Sub',
        parents: ['root'],
        mimeType: SHORTCUT_MIME,
        shortcutDetails: { targetId: 'targetFolder', targetMimeType: FOLDER_MIME },
      },
      // The target folder and a file inside it
      folder('targetFolder', 'Target Subfolder', []),
      file('f2', 'doc2.pdf', ['targetFolder']),
    )
    const client = makeClient(stub)

    const result = await client.listFilesUnder('root', { followFolderShortcuts: true })

    const ids = result.map((r) => r.id).sort()
    expect(ids).toEqual(['f1', 'f2'])
  })

  test('followFolderShortcuts: true with maxDepth: 0 — shortcut targets are not followed (depth budget exhausted)', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('root', 'Customer', []),
      file('f1', 'doc1.pdf', ['root']),
      // A shortcut pointing to a folder at root level
      {
        id: 'sc1',
        name: 'Shortcut to Sub',
        parents: ['root'],
        mimeType: SHORTCUT_MIME,
        shortcutDetails: { targetId: 'targetFolder', targetMimeType: FOLDER_MIME },
      },
      folder('targetFolder', 'Target Subfolder', []),
      file('f2', 'doc2.pdf', ['targetFolder']),
    )
    const client = makeClient(stub)

    const result = await client.listFilesUnder('root', { followFolderShortcuts: true, maxDepth: 0 })

    // maxDepth: 0 means no subfolder recursion at all — shortcut targets must not be followed
    const ids = result.map((r) => r.id).sort()
    expect(ids).toEqual(['f1'])
  })
})

// ── findSheetByName ──────────────────────────────────────────────────────────

describe('findSheetByName', () => {
  test('returns ID on exact name match', async () => {
    const stub = new StubDrive()
    stub.entries.push(
      folder('aeFolder', 'AE Folder', []),
      sheet('s1', 'Supportable — Acme', ['aeFolder']),
    )
    const client = makeClient(stub)

    const id = await client.findSheetByName('aeFolder', 'Supportable — Acme')

    expect(id).toBe('s1')
  })

  test('returns null when no match', async () => {
    const stub = new StubDrive()
    stub.entries.push(folder('aeFolder', 'AE Folder', []))
    const client = makeClient(stub)

    const id = await client.findSheetByName('aeFolder', 'Supportable — Acme')

    expect(id).toBeNull()
  })
})
