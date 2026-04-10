import { test, expect, describe } from 'bun:test'

const BASE = process.env.TEST_URL ?? 'http://localhost:7776'

async function postJSON(path: string, data: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('POST /api/setup/save-customers — validation', () => {
  test('rejects empty name', async () => {
    const { status, body } = await postJSON('/api/setup/save-customers', {
      customers: [{ name: '', domain: 'test.com', accountNumbers: ['123456'] }]
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('rejects HTML in name', async () => {
    const { status, body } = await postJSON('/api/setup/save-customers', {
      customers: [{ name: '<script>alert(1)</script>', domain: 'test.com', accountNumbers: ['123456'] }]
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('rejects non-array customers', async () => {
    const { status, body } = await postJSON('/api/setup/save-customers', {
      customers: 'not-an-array'
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('accepts valid customer array (ALLOW_RESET=true on test container)', async () => {
    const { status, body } = await postJSON('/api/setup/save-customers', {
      customers: [{ name: 'Test Customer', domain: 'test.com', accountNumbers: ['9900099'] }]
    })
    // Test container has ALLOW_RESET=true, so save should succeed
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok', true)
  })
})

describe('POST /api/setup/reset — production guard', () => {
  test('returns 400 without confirm param', async () => {
    const { status, body } = await postJSON('/api/setup/reset', {})
    expect(status).toBe(400)
    expect(body.error).toContain('confirm=true')
  })

  test('succeeds on test container (ALLOW_RESET=true)', async () => {
    const { status } = await postJSON('/api/setup/reset?confirm=true', {})
    // Test container has ALLOW_RESET=true, so reset should succeed even with >5 customers
    expect(status).toBe(200)
  })
})
