// test/unit/node-role.test.ts — issue #10
//
// Unit tests for the node-role policy module.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
  getRole,
  isPrimary,
  assertPrimary,
  ifPrimary,
  __setRoleForTest,
  WrongRoleError,
} from '../../src/lib/node-role.ts'

// Snapshot whatever role the module booted with so we can restore between tests.
const ORIGINAL_ROLE = getRole()

beforeEach(() => {
  __setRoleForTest('hero')
})

afterEach(() => {
  __setRoleForTest(ORIGINAL_ROLE)
})

describe('node-role: getRole / isPrimary', () => {
  test('getRole reflects the current role', () => {
    __setRoleForTest('hero')
    expect(getRole()).toBe('hero')
    __setRoleForTest('primary')
    expect(getRole()).toBe('primary')
  })

  test('isPrimary is true on primary, false on hero', () => {
    __setRoleForTest('primary')
    expect(isPrimary()).toBe(true)
    __setRoleForTest('hero')
    expect(isPrimary()).toBe(false)
  })
})

describe('node-role: assertPrimary', () => {
  test('throws WrongRoleError on hero', () => {
    __setRoleForTest('hero')
    expect(() => assertPrimary('test.op')).toThrow(WrongRoleError)
  })

  test('error message includes the operation name', () => {
    __setRoleForTest('hero')
    try {
      assertPrimary('ccsp.scrapeOneAe')
      throw new Error('expected assertPrimary to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(WrongRoleError)
      expect((e as Error).message).toBe(
        "Operation 'ccsp.scrapeOneAe' is not available on a hero install"
      )
      expect((e as WrongRoleError).operation).toBe('ccsp.scrapeOneAe')
    }
  })

  test('does not throw on primary', () => {
    __setRoleForTest('primary')
    expect(() => assertPrimary('test.op')).not.toThrow()
  })
})

describe('node-role: ifPrimary', () => {
  test('returns undefined on hero and does not call fn', () => {
    __setRoleForTest('hero')
    let called = false
    const result = ifPrimary(() => {
      called = true
      return 42
    })
    expect(result).toBeUndefined()
    expect(called).toBe(false)
  })

  test('calls fn and returns its result on primary', () => {
    __setRoleForTest('primary')
    const result = ifPrimary(() => 42)
    expect(result).toBe(42)
  })

  test('preserves typed return values', () => {
    __setRoleForTest('primary')
    const result = ifPrimary(() => ({ ok: true, count: 7 }))
    expect(result).toEqual({ ok: true, count: 7 })
  })
})

describe('node-role: __setRoleForTest', () => {
  test('works in test environment (NODE_ENV=test)', () => {
    expect(process.env.NODE_ENV).toBe('test')
    __setRoleForTest('primary')
    expect(getRole()).toBe('primary')
    __setRoleForTest('hero')
    expect(getRole()).toBe('hero')
  })

  test('throws if called outside test environment', () => {
    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      expect(() => __setRoleForTest('primary')).toThrow(
        /NODE_ENV === "test"/
      )
    } finally {
      process.env.NODE_ENV = original
    }
  })
})

describe('node-role: WrongRoleError', () => {
  test('is an Error subclass with name set', () => {
    const e = new WrongRoleError('foo')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('WrongRoleError')
    expect(e.operation).toBe('foo')
  })
})
