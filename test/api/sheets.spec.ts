/**
 * Sheets API endpoint tests.
 *
 * Covers /api/sheets/status, /api/sheets/list, /api/sheets/headers,
 * /api/sheets/import, /api/sheets/sync, and /api/sheets/bootstrap-preview.
 * Most endpoints require Google auth — auth-dependent happy paths are skipped
 * with clear reasons; error paths are tested directly.
 */
import { test, expect, getJSON, postJSON } from '../fixtures'

// ── GET /api/sheets/status ──────────────────────────────────────────────────

test.describe('GET /api/sheets/status', () => {
  test('returns 200 with connected boolean', async () => {
    const { status, body } = await getJSON('/api/sheets/status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('connected')
    expect(typeof body.connected).toBe('boolean')
  })

  test('includes fileId and fileName when connected', async () => {
    const { body } = await getJSON('/api/sheets/status')
    if (body.connected) {
      expect(body).toHaveProperty('fileId')
      expect(body).toHaveProperty('fileName')
      expect(body).toHaveProperty('syncedAt')
      expect(typeof body.fileId).toBe('string')
      expect(typeof body.fileName).toBe('string')
    }
    // When not connected, only { connected: false } is returned — also valid
  })
})

// ── GET /api/sheets/list ────────────────────────────────────────────────────

test.describe('GET /api/sheets/list', () => {
  test('returns files array (or error with 500 if auth fails)', async () => {
    const { status, body } = await getJSON('/api/sheets/list')
    // With Google auth: 200 + files array
    // Without Google auth: 500 + files:[] + error
    if (status === 200) {
      expect(body).toHaveProperty('files')
      expect(Array.isArray(body.files)).toBe(true)
      // Each file should have id, name, webViewLink, modifiedTime
      if (body.files.length > 0) {
        const file = body.files[0]
        expect(file).toHaveProperty('id')
        expect(file).toHaveProperty('name')
      }
    } else {
      expect(status).toBe(500)
      expect(body).toHaveProperty('error')
    }
  })
})

// ── GET /api/sheets/headers — validation ────────────────────────────────────

test.describe('GET /api/sheets/headers', () => {
  test('returns 400 without fileId', async () => {
    const { status, body } = await getJSON('/api/sheets/headers')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('fileId')
  })

  test('returns 400 with invalid fileId format', async () => {
    const { status, body } = await getJSON('/api/sheets/headers?fileId=short')
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid file ID')
  })

  test.skip('returns headers for valid fileId (requires Google auth)', async () => {
    // Skipped: requires active Google OAuth session
  })
})

// ── POST /api/sheets/import — validation ────────────────────────────────────

test.describe('POST /api/sheets/import', () => {
  test('returns 400 without fileId and columnMap', async () => {
    const { status, body } = await postJSON('/api/sheets/import', {})
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('fileId')
  })

  test('returns 400 with fileId but no columnMap', async () => {
    const { status, body } = await postJSON('/api/sheets/import', {
      fileId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test('returns 400 with invalid fileId format', async () => {
    const { status, body } = await postJSON('/api/sheets/import', {
      fileId: 'bad',
      columnMap: { name: 0 },
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('Invalid file ID')
  })

  test.skip('imports customers from valid sheet (requires Google auth)', async () => {
    // Skipped: requires active Google OAuth session with Sheets read access
  })
})

// ── POST /api/sheets/sync — validation ──────────────────────────────────────

test.describe('POST /api/sheets/sync', () => {
  test('returns 400 when no sheet is connected', async () => {
    // If sheets-sync.json does not exist or is cleared, sync should fail gracefully
    const { status, body } = await postJSON('/api/sheets/sync')
    // Could be 400 (no sheet configured) or 200 (if a sheet was previously connected)
    if (status === 400) {
      expect(body).toHaveProperty('error')
      expect(body.error).toContain('No sheet connected')
    } else {
      // 200 means a sheet was already connected and re-synced successfully
      expect(status).toBe(200)
      expect(body).toHaveProperty('synced')
    }
  })
})

// ── POST /api/sheets/bootstrap-preview ──────────────────────────────────────

test.describe('POST /api/sheets/bootstrap-preview', () => {
  test('returns 400 when no AE folders are configured', async () => {
    const { status, body } = await postJSON('/api/sheets/bootstrap-preview', {})
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  test.skip('returns preview data with configured AE (requires Google auth + AE config)', async () => {
    // Skipped: requires configured AE with Drive folder and Google OAuth session
  })
})

// ── POST /api/sheets/bootstrap ──────────────────────────────────────────────

test.describe('POST /api/sheets/bootstrap', () => {
  test('returns error without proper configuration', async () => {
    const { status, body } = await postJSON('/api/sheets/bootstrap', {})
    // Should return 400 (missing config) or 401 (no auth) — not 500
    expect(status).toBeLessThan(500)
    expect(body).toHaveProperty('error')
  })
})
