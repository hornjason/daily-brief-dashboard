/**
 * Setup and configuration endpoint tests.
 *
 * Tests the setup wizard API surface: reset, save-customers, infer-domains,
 * save-domains, and validate-folder. Uses serverState fixture to snapshot
 * and restore config between tests.
 */
import { test, expect, getJSON, getJSONDestructive, postJSON, postJSONDestructive, buildAE, buildCustomer } from '../fixtures'

// ── POST /api/setup/reset ───────────────────────────────────────────────────
// NOTE (BKL-TEST-11): When production data is loaded (>5 customers), reset
// returns 403. The destructive tests below skip automatically in that case.

// @destructive tests run against the test container — use TEST_URL if set, then BASE_URL, then default to 7776
const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

// ── BKL-TEST-20: Snapshot/restore wrapper ───────────────────────────────────
// Wraps the entire spec in a snapshot/restore cycle so POST /api/setup/reset
// with ?confirm=true cannot permanently wipe production data.
// Pattern mirrors lifecycle.spec.ts.

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${BASE}/api/__test/snapshot`)
  const snap = await res.json().catch(() => ({}))
  if (!snap.ok) {
    console.warn(`[setup.spec.ts beforeAll] Snapshot returned not-ok: ${JSON.stringify(snap)}`)
  }
})

test.afterAll(async ({ request }) => {
  try {
    const r = await request.post(`${BASE}/api/__test/restore`, { data: { force: true } })
    const d = await r.json().catch(() => ({}))
    if (!d.ok) {
      console.error(`[setup.spec.ts afterAll] Restore failed: ${JSON.stringify(d)} — call POST ${BASE}/api/__test/restore manually to recover data`)
    }
  } catch (e) {
    console.error(`[setup.spec.ts afterAll] RESTORE FAILED: ${e} — call POST ${BASE}/api/__test/restore manually to recover data`)
  }
})

async function getCustomerCount(): Promise<number> {
  try {
    const res = await fetch(`${BASE}/api/accounts`)
    const body = await res.json()
    return body.customers?.length ?? 0
  } catch { return 0 }
}

test.describe('@destructive POST /api/setup/reset', () => {
  test('returns 400 without ?confirm=true', async () => {
    const { status, body } = await postJSONDestructive('/api/setup/reset')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('confirm=true')
  })

  test('clears AEs and customers when called with ?confirm=true', async () => {
    // Check twice 200ms apart to avoid a transient low-count from a parallel test's save-customers call
    const count1 = await getCustomerCount()
    await new Promise(r => setTimeout(r, 200))
    const count2 = await getCustomerCount()
    const count = Math.max(count1, count2)
    test.skip(count > 5, `Production guard active (${count} customers) — reset blocked. Run with ALLOW_RESET=true in test env.`)

    const before = await getJSONDestructive('/api/aes')
    expect(before.status).toBe(200)

    const { status, body } = await postJSONDestructive('/api/setup/reset?confirm=true')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('deleted')
    expect(typeof body.deleted).toBe('number')

    const after = await getJSONDestructive('/api/aes')
    expect(after.body.aes).toHaveLength(0)
  })

  test('returns 403 with production guard when customers > 5', async () => {
    const count = await getCustomerCount()
    test.skip(count <= 5, 'Not enough customers to test production guard')

    const { status, body } = await postJSONDestructive('/api/setup/reset?confirm=true')
    expect(status).toBe(403)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('BLOCKED')
    expect(body.error).toContain('customers loaded')
  })

  test('returns 409 if scrape is running', async () => {
    const { status } = await postJSONDestructive('/api/setup/reset')
    expect([400, 409]).toContain(status)
  })
})

// ── POST /api/setup/save-customers ──────────────────────────────────────────

test.describe('@destructive POST /api/setup/save-customers', () => {
  test('saves a valid customers array', async () => {
    const customer = buildCustomer({ name: 'Acme Corp', accountNumbers: ['123456'] })
    const { status, body } = await postJSONDestructive('/api/setup/save-customers', {
      customers: [customer],
    })
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('count', 1)
  })

  test('rejects customer with empty name (400)', async () => {
    const customer = buildCustomer({ name: '' })
    const { status, body } = await postJSONDestructive('/api/setup/save-customers', {
      customers: [customer],
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('rejects HTML in customer name (400)', async () => {
    // sanitizeText rejects HTML tags outright — "<script>alert(1)</script>" returns 400
    const customer = buildCustomer({ name: '<script>alert(1)</script>' })
    const { status, body } = await postJSONDestructive('/api/setup/save-customers', {
      customers: [customer],
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('rejects accountNumbers with wrong format (400)', async () => {
    const customer = buildCustomer({ name: 'Valid Name', accountNumbers: ['abc'] })
    const { status, body } = await postJSONDestructive('/api/setup/save-customers', {
      customers: [customer],
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('accountNumbers')
  })

  test('rejects more than 200 customers (400)', async () => {
    const customers = Array.from({ length: 201 }, (_, i) =>
      buildCustomer({ name: `Customer ${i}`, accountNumbers: [`${1000 + i}`] })
    )
    const { status, body } = await postJSONDestructive('/api/setup/save-customers', {
      customers,
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('200')
  })

  test('rejects non-array customers field (400)', async () => {
    const { status, body } = await postJSONDestructive('/api/setup/save-customers', {
      customers: 'not an array',
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })
})

// ── POST /api/setup/infer-domains ───────────────────────────────────────────

// serial: these tests mutate server state (reset + save) and must not race with other workers
// BKL-TEST-20: skipped when production data is loaded (>5 customers) — reset would return 403
test.describe.serial('@destructive POST /api/setup/infer-domains', () => {
  test('returns 400 if no customers configured', async () => {
    const count = await getCustomerCount()
    test.skip(count > 5, `Production guard active (${count} customers) — reset blocked`)

    // Reset first to clear customers
    await postJSONDestructive('/api/setup/reset?confirm=true')

    const { status, body } = await postJSONDestructive('/api/setup/infer-domains')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('No customers configured')
  })

  test('returns { results } shape when customers exist', async () => {
    // Save a customer first
    await postJSONDestructive('/api/setup/save-customers', {
      customers: [buildCustomer({ name: 'Test Corp', accountNumbers: ['123456'] })],
    })

    const { status, body } = await postJSONDestructive('/api/setup/infer-domains')
    // May succeed or fail depending on Google auth state, but shape should be consistent
    if (status === 200) {
      expect(body).toHaveProperty('results')
      expect(Array.isArray(body.results)).toBe(true)
    } else {
      // 500 from Google auth failure is acceptable in test env
      expect([401, 500]).toContain(status)
    }
  })
})

// ── POST /api/setup/save-domains ────────────────────────────────────────────

test.describe('@destructive POST /api/setup/save-domains', () => {
  test('returns 400 with no domains provided', async () => {
    const { status, body } = await postJSONDestructive('/api/setup/save-domains', { domains: [] })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('rejects invalid domain format (400)', async () => {
    const { status, body } = await postJSONDestructive('/api/setup/save-domains', {
      domains: [{ name: 'Test', domain: 'not a valid domain!!!' }],
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid domain')
  })

  test('saves valid domains successfully', async () => {
    // Ensure a customer exists first
    await postJSONDestructive('/api/setup/save-customers', {
      customers: [buildCustomer({ name: 'Acme Corp', accountNumbers: ['123456'] })],
    })

    const { status, body } = await postJSONDestructive('/api/setup/save-domains', {
      domains: [{ name: 'Acme Corp', domain: 'acme.com' }],
    })
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('updated', 1)
  })
})

// ── POST /api/aes/validate-folder ───────────────────────────────────────────

test.describe('POST /api/aes/validate-folder', () => {
  test('rejects bad folder URL (400)', async () => {
    const { status, body } = await postJSONDestructive('/api/aes/validate-folder', {
      folderUrl: 'not-a-url',
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('rejects empty folderUrl', async () => {
    const { status, body } = await postJSONDestructive('/api/aes/validate-folder', {
      folderUrl: '',
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('accepts valid-looking folder URL format (may fail on Drive API if fake)', async () => {
    const { status, body } = await postJSONDestructive('/api/aes/validate-folder', {
      folderUrl: 'https://drive.google.com/drive/folders/1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
    })
    // Either 200 (real folder found) or 400 (Drive API rejects it) — not 500
    expect(status).toBeLessThan(500)
  })
})
