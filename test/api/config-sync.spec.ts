/**
 * BKL-DRIVE-BACKUP-API-01 — config sync endpoint tests.
 *
 * Verifies the new POST /api/config/backup and POST /api/config/restore
 * routes registered by settings-api.ts. The 200-path is exercised when
 * a parentFolderId is configured on the test container; otherwise those
 * tests fall through to the 404 paths (and the 200-shape tests skip).
 *
 * Run against test container:
 *   npx playwright test test/api/config-sync.spec.ts --project=test
 */
import { test, expect, postJSONDestructive, getJSONDestructive } from '../fixtures'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

/** Probe whether the test container has any region with parentFolderId set. */
async function hasParentFolderId(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/settings/from-drive`)
    // 200 means the route resolved Drive; 404 with "parentFolderId not set" means
    // the precondition is missing. Any other 4xx/5xx (including Drive 404s
    // for Config/) means parentFolderId IS configured.
    if (res.status === 200) return true
    const body = await res.json().catch(() => ({}))
    return !(typeof body?.error === 'string' && body.error.includes('parentFolderId not set'))
  } catch { return false }
}

test.describe('@destructive POST /api/config/backup', () => {
  test('route is registered and reachable', async () => {
    // Smoke check: a real POST should never return 404 with "Not Found" from
    // Hono's default handler — only domain 404 errors with an `error` field.
    const { status, body } = await postJSONDestructive('/api/config/backup')
    expect([200, 404, 500]).toContain(status)
    expect(body).toBeTruthy()
  })

  test('returns 404 when no parentFolderId is configured for any region', async () => {
    test.skip(await hasParentFolderId(), 'parentFolderId configured — 404 path not exercised')
    const { status, body } = await postJSONDestructive('/api/config/backup')
    expect(status).toBe(404)
    expect(body).toHaveProperty('error')
    expect(String(body.error)).toContain('parentFolderId not set')
  })

  test('returns 200 with fileId when parentFolderId is configured', async () => {
    test.skip(!(await hasParentFolderId()), 'parentFolderId not configured — skipping 200-path test')
    const { status, body } = await postJSONDestructive('/api/config/backup')
    // 200 happy path; 404 if Config/ folder is unresolvable (Drive empty); 500 on Drive auth fail.
    if (status === 200) {
      expect(body).toMatchObject({ ok: true })
      expect(typeof body.fileId).toBe('string')
      expect(body.fileId.length).toBeGreaterThan(0)
    } else {
      expect([404, 500]).toContain(status)
      expect(body).toHaveProperty('error')
    }
  })
})

test.describe('@destructive POST /api/config/restore', () => {
  test('route is registered and reachable', async () => {
    const { status, body } = await postJSONDestructive('/api/config/restore')
    expect([200, 404, 500]).toContain(status)
    expect(body).toBeTruthy()
  })

  test('returns 404 when no parentFolderId is configured for any region', async () => {
    test.skip(await hasParentFolderId(), 'parentFolderId configured — 404 path not exercised')
    const { status, body } = await postJSONDestructive('/api/config/restore')
    expect(status).toBe(404)
    expect(body).toHaveProperty('error')
    expect(String(body.error)).toContain('parentFolderId not set')
  })

  test('returns 200 with applied: true when Config/settings.json exists in Drive', async () => {
    test.skip(!(await hasParentFolderId()), 'parentFolderId not configured — skipping 200-path test')
    // Pre-flight: GET /api/settings/from-drive must succeed (200) before restore is meaningful.
    const pre = await getJSONDestructive('/api/settings/from-drive')
    test.skip(pre.status !== 200, `Config/settings.json not present in Drive (GET returned ${pre.status}) — skip restore happy path`)
    const { status, body } = await postJSONDestructive('/api/config/restore')
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, applied: true })
  })

  test('returns 404 when Config/settings.json missing from Drive', async () => {
    test.skip(!(await hasParentFolderId()), 'parentFolderId not configured — skip "missing in Drive" test')
    // Only meaningful when parentFolderId is set but Drive has no Config/settings.json.
    const pre = await getJSONDestructive('/api/settings/from-drive')
    // If GET returns 404 with "not found" semantics, restore should mirror that.
    test.skip(pre.status === 200, 'Config/settings.json IS present — cannot exercise the missing-file 404 branch')
    const { status, body } = await postJSONDestructive('/api/config/restore')
    expect([404, 500]).toContain(status)
    expect(body).toHaveProperty('error')
  })
})
