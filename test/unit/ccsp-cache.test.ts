// test/unit/ccsp-cache.test.ts — Issue #15 Step 2
//
// Unit tests for the in-memory tier of src/ccsp-cache.ts.
// Drive-touching paths (tryDriveCache, writeCaches Drive write) are covered
// by integration tests; here we verify only what is pure-ish: the test-only
// reset helper and the empty-cache miss path of tryMemoryCache.
//
// Drive modifiedTime check is bypassed when the cache has no driveFileId,
// so a freshly-empty cache returns { hit: false } without any network call.

import { test, expect, describe } from 'bun:test'
import { tryMemoryCache, _resetMemoryCacheForTests } from '../../src/ccsp-cache.ts'

describe('ccsp-cache — in-memory tier (no Drive IO)', () => {
  test('_resetMemoryCacheForTests() leaves the cache empty', async () => {
    _resetMemoryCacheForTests()
    const result = await tryMemoryCache('WEST_COMM_CORP_NORTHWEST')
    expect(result.hit).toBe(false)
  })

  test('tryMemoryCache returns miss for any pod after reset', async () => {
    _resetMemoryCacheForTests()
    const r1 = await tryMemoryCache('WEST_COMM_CORP_NORTHWEST')
    const r2 = await tryMemoryCache('CENTRAL_ENT_TOLA_POD')
    const r3 = await tryMemoryCache('')
    expect(r1.hit).toBe(false)
    expect(r2.hit).toBe(false)
    expect(r3.hit).toBe(false)
  })

  test('miss result has no rows / period / source fields populated', async () => {
    _resetMemoryCacheForTests()
    const result = await tryMemoryCache('SOME_POD')
    expect(result.hit).toBe(false)
    expect(result.rows).toBeUndefined()
    expect(result.period).toBeUndefined()
    expect(result.source).toBeUndefined()
  })
})
