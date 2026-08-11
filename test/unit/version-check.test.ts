/**
 * Unit tests for version comparison logic (GitHub issue #73)
 *
 * Tests the pure function that compares semantic versions to determine
 * if an update is available. Handles release candidates, dev builds,
 * and standard semver.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { compareVersions, shouldShowUpdate } from '../../src/lib/version-utils.ts'
import { createAdminRouter, _resetUpdateCheckCacheForTesting } from '../../src/admin-routes.ts'
import { Hono } from 'hono'

describe('compareVersions', () => {
  test('identifies newer patch version', () => {
    expect(compareVersions('1.7.0', '1.7.1')).toBe(1) // 1.7.1 is newer
  })

  test('identifies newer minor version', () => {
    expect(compareVersions('1.7.0', '1.8.0')).toBe(1)
  })

  test('identifies newer major version', () => {
    expect(compareVersions('1.7.0', '2.0.0')).toBe(1)
  })

  test('identifies same version', () => {
    expect(compareVersions('1.7.0', '1.7.0')).toBe(0)
  })

  test('identifies older version', () => {
    expect(compareVersions('1.7.1', '1.7.0')).toBe(-1)
  })

  test('RC version is older than stable', () => {
    expect(compareVersions('1.7.0-rc8', '1.7.0')).toBe(1) // 1.7.0 is newer
  })

  test('RC version is older than next patch', () => {
    expect(compareVersions('1.7.0-rc8', '1.7.1')).toBe(1) // 1.7.1 is newer
  })

  test('higher RC number is newer than lower RC', () => {
    expect(compareVersions('1.7.0-rc8', '1.7.0-rc9')).toBe(1)
  })

  test('dev version comparison returns 0 (no update check)', () => {
    expect(compareVersions('1.0.0-dev', '2.0.0')).toBe(0)
  })
})

describe('shouldShowUpdate', () => {
  test('shows update when newer version available', () => {
    expect(shouldShowUpdate('1.7.0', '1.7.1')).toBe(true)
  })

  test('does not show update when same version', () => {
    expect(shouldShowUpdate('1.7.0', '1.7.0')).toBe(false)
  })

  test('does not show update when current is newer', () => {
    expect(shouldShowUpdate('1.7.1', '1.7.0')).toBe(false)
  })

  test('shows update when RC and stable available', () => {
    expect(shouldShowUpdate('1.7.0-rc8', '1.7.0')).toBe(true)
  })

  test('does not show update for dev builds', () => {
    expect(shouldShowUpdate('1.0.0-dev', '2.0.0')).toBe(false)
  })
})

describe('update check endpoint', () => {
  let originalFetch: typeof globalThis.fetch
  let app: Hono

  beforeEach(() => {
    originalFetch = globalThis.fetch
    _resetUpdateCheckCacheForTesting()
    const router = createAdminRouter()
    app = new Hono()
    app.route('/', router)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    _resetUpdateCheckCacheForTesting()
  })

  test('force=true bypasses cache', async () => {
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount++
      return new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    // First call — populates cache
    await app.request('/api/updates/check')
    expect(fetchCount).toBe(1)

    // Second call without force — should use cache
    await app.request('/api/updates/check')
    expect(fetchCount).toBe(1)

    // Third call with force=true — should bypass cache
    await app.request('/api/updates/check?force=true')
    expect(fetchCount).toBe(2)
  })

  test('non-200 response returns updateAvailable: false', async () => {
    globalThis.fetch = (async () => {
      return new Response('Server Error', { status: 500 })
    }) as typeof fetch

    const res = await app.request('/api/updates/check')
    const data = await res.json()
    expect(data.updateAvailable).toBe(false)
  })

  test('404 response returns updateAvailable: false', async () => {
    globalThis.fetch = (async () => {
      return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    const res = await app.request('/api/updates/check')
    const data = await res.json()
    expect(data.updateAvailable).toBe(false)
  })

  test('correct repo URL is used (daily-brief-dashboard)', async () => {
    let capturedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return new Response(JSON.stringify({ tag_name: 'v1.0.0', html_url: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await app.request('/api/updates/check')
    expect(capturedUrl).toContain('daily-brief-dashboard')
    expect(capturedUrl).not.toContain('asaCommandCenter')
  })
})
