// BKL-ARCH-23: docs-fetcher — folder resolution priority + BFS dedup logic.
// Tests the pure helpers (normalizeFolderName, folderMatchScore,
// fuzzyFindCustomerFolder); the Drive-driven fetchCustomerDocsImpl is covered
// indirectly by the buildXmlSources golden test and by integration tests.

import { describe, it, expect } from 'bun:test'
import {
  normalizeFolderName,
  folderMatchScore,
  fuzzyFindCustomerFolder,
} from '../../../src/customer/docs-fetcher.ts'

describe('normalizeFolderName', () => {
  it('strips legal suffixes and punctuation', () => {
    expect(normalizeFolderName('Acme, Inc.')).toBe('acme')
    expect(normalizeFolderName('Big Corp')).toBe('big')
    expect(normalizeFolderName('  Foo Holdings  ')).toBe('foo')
  })

  it('lowercases and collapses', () => {
    expect(normalizeFolderName('FooBar Inc')).toBe('foobar')
  })
})

describe('folderMatchScore', () => {
  it('returns 1 for exact normalized match', () => {
    expect(folderMatchScore('Acme Inc', 'Acme')).toBe(1)
  })

  it('returns 0.9 for substring match (where neither side normalizes to legal-suffix)', () => {
    // After normalization "Acme Foundation" stays "acme foundation" (foundation isn't in
    // the legal-suffix list), so substring match against "acme" yields 0.9.
    expect(folderMatchScore('Acme Foundation', 'Acme')).toBe(0.9)
  })

  it('returns word-overlap fraction otherwise', () => {
    const score = folderMatchScore('Big Banana Foods', 'Big Apple Foods')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(0.9)
  })

  it('returns 0 when no shared significant words', () => {
    expect(folderMatchScore('xyz', 'abc')).toBe(0)
  })
})

describe('fuzzyFindCustomerFolder', () => {
  it('returns the highest-scoring folder above 0.5 threshold', () => {
    const folders = [
      { id: '1', name: 'Some Other Customer' },
      { id: '2', name: 'Acme Corp' },
      { id: '3', name: 'Different Co' },
    ]
    expect(fuzzyFindCustomerFolder(folders, 'Acme')).toEqual({ id: '2', name: 'Acme Corp' })
  })

  it('returns undefined when no folder scores above 0.5', () => {
    const folders = [
      { id: '1', name: 'Apple' },
      { id: '2', name: 'Orange' },
    ]
    expect(fuzzyFindCustomerFolder(folders, 'Banana')).toBeUndefined()
  })

  it('skips folders with missing id or name', () => {
    const folders = [
      { id: null, name: 'Acme' },
      { id: '2', name: null },
      { id: '3', name: 'Acme Corp' },
    ]
    expect(fuzzyFindCustomerFolder(folders, 'Acme')).toEqual({ id: '3', name: 'Acme Corp' })
  })
})
