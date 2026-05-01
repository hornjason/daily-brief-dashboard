import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { writeJsonAtomic, writeFileAtomic, appendLine } from '../../src/lib/atomic-write.ts'

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
