import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { writeJsonAtomic, writeJsonAtomicAsync, writeFileAtomic, appendLine } from '../../src/lib/atomic-write.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('writeJsonAtomic', () => {
  test('creates file with correct JSON content', () => {
    const path = join(dir, 'data.json')
    writeJsonAtomic(path, { a: 1, b: [2, 3] })
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed).toEqual({ a: 1, b: [2, 3] })
  })

  test('sets mode 0o600 on the file', () => {
    const path = join(dir, 'secret.json')
    writeJsonAtomic(path, { token: 'x' })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('creates parent directory when it does not exist (mkdir option)', () => {
    const path = join(dir, 'nested', 'sub', 'config.json')
    writeJsonAtomic(path, { ok: true })
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ ok: true })
  })

  test('does NOT overwrite non-empty file with empty object (stale-overwrite guard)', () => {
    const path = join(dir, 'cache.json')
    writeJsonAtomic(path, { customers: [{ name: 'Acme' }] })
    writeJsonAtomic(path, {})
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed).toEqual({ customers: [{ name: 'Acme' }] })
  })

  test('does NOT overwrite non-empty file with empty array (stale-overwrite guard)', () => {
    const path = join(dir, 'rows.json')
    writeJsonAtomic(path, [{ id: 1 }, { id: 2 }])
    writeJsonAtomic(path, [])
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('DOES overwrite non-empty file with non-empty value', () => {
    const path = join(dir, 'cache.json')
    writeJsonAtomic(path, { customers: [{ name: 'Acme' }] })
    writeJsonAtomic(path, { customers: [{ name: 'Globex' }, { name: 'Initech' }] })
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed).toEqual({ customers: [{ name: 'Globex' }, { name: 'Initech' }] })
  })

  test('leaves no .tmp file after success', () => {
    const path = join(dir, 'data.json')
    writeJsonAtomic(path, { a: 1 })
    const entries = readdirSync(dir)
    expect(entries).toContain('data.json')
    expect(entries.some(e => e.endsWith('.tmp'))).toBe(false)
  })
})

describe('writeFileAtomic', () => {
  test('creates file with correct content (string)', () => {
    const path = join(dir, 'note.txt')
    writeFileAtomic(path, 'hello world')
    expect(readFileSync(path, 'utf-8')).toBe('hello world')
  })

  test('sets mode correctly', () => {
    const path = join(dir, 'data.bin')
    writeFileAtomic(path, 'x', { mode: 0o644 })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o644)
  })

  test('default mode is 0o600', () => {
    const path = join(dir, 'data.bin')
    writeFileAtomic(path, 'x')
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('migration call-site coverage (BKL-ARCH-06)', () => {
  // Validates that the helpers replicate the byte-level behavior of the
  // hand-rolled writeFileSync(tmp) + renameSync(tmp, dest) pattern that
  // existed across scrape-api.ts, settings-api.ts, scraper-status-store.ts,
  // ae-routes.ts, and account-intelligence.ts before BKL-ARCH-06.

  test('writeJsonAtomic produces same on-disk JSON as hand-rolled tmp+rename', () => {
    // Simulates the previous pattern in src/scraper-status-store.ts:
    //   writeFileSync(tmpPath, JSON.stringify(_store, null, 2), { mode: 0o600 })
    //   renameSync(tmpPath, getStatusFilePath())
    const path = join(dir, 'scraper-status.json')
    const store = {
      'rh-cases': { state: 'fresh', recordCount: 42 },
      'ccsp':     { state: 'stale', recordCount: 0 },
    }
    writeJsonAtomic(path, store)

    // On-disk content matches the expected JSON.stringify(_, null, 2) bytes
    const expected = JSON.stringify(store, null, 2)
    expect(readFileSync(path, 'utf-8')).toBe(expected)

    // Mode matches the hand-rolled { mode: 0o600 } site
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)

    // No leftover .tmp file (atomic rename completed)
    expect(readdirSync(dir)).toEqual(['scraper-status.json'])
  })

  test('stale-overwrite guard protects customers.json from accidental wipe (account-intelligence.ts)', () => {
    // Simulates the previous pattern in src/account-intelligence.ts:
    //   const tmp = CUSTOMERS_PATH + '.tmp'
    //   writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    //   renameSync(tmp, CUSTOMERS_PATH)
    // The hand-rolled version had no guard; writeJsonAtomic adds one.
    const path = join(dir, 'customers.json')
    const real = { customers: [{ name: 'Acme' }, { name: 'Globex' }] }
    writeJsonAtomic(path, real)

    // A failed read upstream might produce { customers: [] } — but the
    // *outer* object is non-empty, so the guard does NOT trigger here.
    // This documents the guard's exact contract.
    writeJsonAtomic(path, { customers: [] })
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ customers: [] })

    // However, an empty top-level object {} would trigger the guard if the
    // file is non-empty. Restore real data first, then attempt {}.
    writeJsonAtomic(path, real)
    writeJsonAtomic(path, {})
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(real)
  })
})

describe('writeJsonAtomicAsync', () => {
  test('writes correct JSON content and no .tmp remains', async () => {
    const path = join(dir, 'async-data.json')
    await writeJsonAtomicAsync(path, { service: 'rh', count: 5 })
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed).toEqual({ service: 'rh', count: 5 })
    // No leftover .tmp file after atomic rename
    const entries = readdirSync(dir)
    expect(entries).toContain('async-data.json')
    expect(entries.some(e => e.endsWith('.tmp'))).toBe(false)
  })

  test('sets mode 0o600 on written file', async () => {
    const path = join(dir, 'async-secret.json')
    await writeJsonAtomicAsync(path, { token: 'abc' })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('creates parent directory when it does not exist', async () => {
    const path = join(dir, 'nested', 'async', 'config.json')
    await writeJsonAtomicAsync(path, { ok: true })
    expect(existsSync(path)).toBe(true)
  })

  test('is atomic — .tmp file is absent after write completes', async () => {
    // After the call resolves, only the final path exists (no leftover .tmp)
    const path = join(dir, 'atomic-check.json')
    await writeJsonAtomicAsync(path, [1, 2, 3])
    expect(existsSync(path + '.tmp')).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  test('stale-overwrite guard prevents empty object from clobbering non-empty file', async () => {
    const path = join(dir, 'async-cache.json')
    await writeJsonAtomicAsync(path, { accounts: [{ id: '001' }] })
    await writeJsonAtomicAsync(path, {})
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed).toEqual({ accounts: [{ id: '001' }] })
  })
})

describe('appendLine', () => {
  test('appends a line + newline to existing file', () => {
    const path = join(dir, 'log.txt')
    writeFileSync(path, 'first line\n')
    appendLine(path, 'second line')
    expect(readFileSync(path, 'utf-8')).toBe('first line\nsecond line\n')
  })

  test('creates file if it does not exist', () => {
    const path = join(dir, 'new-log.txt')
    appendLine(path, 'first line')
    expect(readFileSync(path, 'utf-8')).toBe('first line\n')
  })

  test('creates parent directory when needed', () => {
    const path = join(dir, 'nested', 'log.txt')
    appendLine(path, 'hello')
    expect(readFileSync(path, 'utf-8')).toBe('hello\n')
  })
})
