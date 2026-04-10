import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'fs'
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import type { Hono } from 'hono'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, OAUTH_KEYS_PATH } from './google.ts'
import { customers, aes, saveAes, CUSTOMERS_PATH, AES_PATH, setAes, setCustomers } from './server-state.ts'
import type { Customer } from './types.ts'
import { NORMAL_SCOPES, BOOTSTRAP_SCOPES, getScopeLevel, type StoredToken } from './oauth-scopes.ts'
import { inferCustomerDomain } from './domains.ts'
import { sanitizeErr, sanitizeText } from './utils.ts'
import { supportableScrapeRunning } from './supportable-scraper.ts'
import { ccspScrapeRunning } from './ccsp-scraper.ts'
import { _rhScrapeRunning } from './scraper-manager.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let SRV_CONFIG_DIR = ''
let CACHE_DIR = ''
let SHEETS_SYNC_PATH = ''
let DATA_SOURCES_PATH = ''
let ADMIN_EMAIL = ''

// CSRF state tokens — Map keyed by token, with mode + expiry (replaces single-slot variable)
export const pendingOAuthStates = new Map<string, { mode: string; createdAt: number }>()

export function initSetupRoutes(opts: {
  srvConfigDir: string
  cacheDir: string
  customersPath: string
  sheetsSyncPath: string
  dataSourcesPath: string
  adminEmail: string
}): void {
  SRV_CONFIG_DIR = opts.srvConfigDir
  CACHE_DIR = opts.cacheDir
  SHEETS_SYNC_PATH = opts.sheetsSyncPath
  DATA_SOURCES_PATH = opts.dataSourcesPath
  ADMIN_EMAIL = opts.adminEmail
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Loose domain validation — allows subdomains, TLDs, IP-like strings, localhost. Rejects HTML. */
function isValidDomain(value: unknown): boolean {
  if (typeof value !== 'string') return true // optional field — absent is OK
  if (value === '') return true
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-._]{0,251}[a-zA-Z0-9])?$/.test(value)) return false
  const parts = value.split('.')
  if (parts.length > 4) return false
  return true
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerSetupRoutes(app: Hono): void {

  // ── Google OAuth browser flow ─────────────────────────────────────────────

  // GET /oauth/start — Redirect browser to Google consent screen
  app.get('/oauth/start', (c) => {
    if (!existsSync(OAUTH_KEYS_PATH)) {
      return c.html(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9">
        <h2 style="color:#f1f5f9">OAuth Keys Not Found</h2>
        <p style="color:#94a3b8">Place your GCP OAuth credentials file at:</p>
        <code style="background:#1e293b;padding:.5rem 1rem;border-radius:.5rem;display:block;margin:1rem 0;color:#e2e8f0">gcp-oauth.keys.json</code>
        <p style="color:#94a3b8">Or set the <code>GOOGLE_OAUTH_KEYS</code> environment variable.</p>
        <p><a href="/dashboard/setup" style="color:#818cf8">← Back to Setup</a></p>
      </body></html>`, 400)
    }

    // Default to bootstrap (full) scopes; only use normal (read-only) scopes if user explicitly requests downgrade
    const mode = c.req.query('mode') === 'normal' ? 'normal' : 'bootstrap'
    const scopes = mode === 'normal' ? NORMAL_SCOPES : BOOTSTRAP_SCOPES

    const keys = JSON.parse(readFileSync(OAUTH_KEYS_PATH, 'utf-8'))
    const { client_id, client_secret } = keys.installed ?? keys.web
    const redirectUri = `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

    const csrfToken = crypto.randomUUID().replace(/-/g, '')
    pendingOAuthStates.set(csrfToken, { mode, createdAt: Date.now() })
    // Expire tokens older than 10 minutes
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [k, v] of pendingOAuthStates) { if (v.createdAt < cutoff) pendingOAuthStates.delete(k) }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state: `${csrfToken}:${mode}`,
      scope: [...scopes],
    })

    return c.redirect(authUrl)
  })

  // GET /oauth/callback — Handle Google redirect, exchange code for tokens
  app.get('/oauth/callback', async (c) => {
    const code  = c.req.query('code')
    const state = c.req.query('state')
    const error = c.req.query('error')

    const escHtml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    const errorPage = (msg: string, detail?: string) => c.html(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9">
        <h2 style="color:#f87171">Authentication Failed</h2>
        <p style="color:#94a3b8">${escHtml(msg)}</p>
        ${detail ? `<code style="background:#1e293b;padding:.5rem 1rem;border-radius:.5rem;display:block;margin:1rem 0;color:#fca5a5">${escHtml(detail)}</code>` : ''}
        <p><a href="/dashboard/setup" style="color:#818cf8">← Back to Setup</a></p>
      </body></html>`, 400)

    if (error) {
      if (error === 'access_denied') {
        return c.html(`
          <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9;max-width:600px;margin:0 auto">
            <h2 style="color:#fbbf24">Access Denied</h2>
            <p style="color:#94a3b8">Your Google account hasn't been added as a test user yet.</p>
            <p style="color:#94a3b8">Email <strong style="color:#f1f5f9">${escHtml(ADMIN_EMAIL)}</strong> and ask to be added, then try again.</p>
            <p style="margin-top:1.5rem">
              <a href="mailto:${escHtml(ADMIN_EMAIL)}?subject=Dashboard%20Access%20Request&body=Please%20add%20my%20Google%20account%20as%20a%20test%20user.%0A%0AMy%20email%3A%20%5Byour%40email.com%5D"
                 style="background:#4f46e5;color:white;padding:.75rem 1.5rem;border-radius:.5rem;text-decoration:none;display:inline-block">
                Request Access via Email
              </a>
              &nbsp;
              <a href="/dashboard/setup" style="color:#818cf8;margin-left:1rem">← Back to Setup</a>
            </p>
            <hr style="border-color:#1e293b;margin:2rem 0">
            <p style="color:#64748b;font-size:.875rem">
              💡 If you're the admin: switching the GCP OAuth consent screen from <strong style="color:#94a3b8">External → Internal</strong>
              means any @redhat.com user can connect without being added individually.
            </p>
          </body></html>`, 403)
      }
      return errorPage('Google returned an error', error)
    }

    if (!code) return errorPage('No authorization code received')
    const [stateToken] = (state ?? '').split(':')
    const pendingState = pendingOAuthStates.get(stateToken)
    if (!pendingState) return errorPage('Invalid or expired state parameter — please try authorizing again')
    pendingOAuthStates.delete(stateToken)
    const scopeMode = pendingState.mode === 'bootstrap' ? 'bootstrap' : 'normal'

    try {
      const keys = JSON.parse(readFileSync(OAUTH_KEYS_PATH, 'utf-8'))
      const { client_id, client_secret } = keys.installed ?? keys.web
      const redirectUri = `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`
      const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

      const { tokens } = await oauth2Client.getToken(code)
      const tokenData = { ...tokens, configuredAt: new Date().toISOString(), scopeLevel: scopeMode }

      // Save to config dir (works both locally and in container via volume mount)
      const tokenPath = GOOGLE_UNIFIED_TOKEN_PATH
      writeFileSyncRaw(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 })

      return c.html(`
        <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9;max-width:600px;margin:0 auto">
          <h2 style="color:#34d399">✓ Google Workspace Connected</h2>
          <p style="color:#94a3b8">Calendar, Gmail, Drive, and Sheets access authorized.</p>
          <p style="color:#94a3b8">Redirecting to setup wizard…</p>
          <meta http-equiv="refresh" content="1;url=/dashboard/setup?step=2">
          <p><a href="/dashboard/setup?step=2" style="color:#818cf8">Continue →</a></p>
        </body></html>`)
    } catch (e: any) {
      return errorPage('Token exchange failed', sanitizeErr(e))
    }
  })

  // GET /api/oauth/status — Check if unified Google token exists
  app.get('/api/oauth/status', async (c) => {
    if (!existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) return c.json({ authorized: false })
    try {
      const token = JSON.parse(readFileSync(GOOGLE_UNIFIED_TOKEN_PATH, 'utf-8'))
      // Validate token is actually live
      let email: string | undefined
      let expired = false
      try {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        const gmail = google.gmail({ version: 'v1', auth })
        const profile = await gmail.users.getProfile({ userId: 'me' })
        email = profile.data.emailAddress ?? undefined
      } catch (e: any) {
        expired = e.message?.includes('invalid_grant') || e.message?.includes('Token has been expired') || e.message?.includes('invalid_token')
      }
      const scopeLevel = getScopeLevel(token as StoredToken)
      return c.json({ authorized: !expired, expired, email, configuredAt: token.configuredAt ?? null, scopeLevel })
    } catch {
      return c.json({ authorized: false })
    }
  })

  // ── Setup wizard routes ───────────────────────────────────────────────────

  // GET /api/setup/check-auth — Check Google OAuth token availability
  app.get('/api/setup/check-auth', async (c) => {
    const check = (filename: string) => existsSync(resolve(SRV_CONFIG_DIR, filename))
    const unified = check('.google-token.json')
    const hasFile = {
      gmail:    unified || check('.gmail-token.json'),
      drive:    unified || check('.gdrive-server-credentials.json'),
      calendar: unified || check('.calendar-token.json'),
    }

    // Validate token is actually live with a lightweight Gmail profile call
    let valid = false
    let expired = false
    let email: string | undefined
    if (hasFile.gmail) {
      try {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        const gmail = google.gmail({ version: 'v1', auth })
        const profile = await gmail.users.getProfile({ userId: 'me' })
        email = profile.data.emailAddress ?? undefined
        valid = true
      } catch (e: any) {
        expired = e.message?.includes('invalid_grant') || e.message?.includes('Token has been expired')
      }
    }

    const tokens = {
      gmail:    hasFile.gmail,
      drive:    hasFile.drive,
      calendar: hasFile.calendar,
      allConfigured: Object.values(hasFile).every(Boolean),
    }
    return c.json({ tokens, valid, expired, email })
  })

  // GET /api/setup/oauth-keys-status — Check if OAuth keys file exists
  app.get('/api/setup/oauth-keys-status', (c) => {
    return c.json({ exists: existsSync(OAUTH_KEYS_PATH) })
  })

  // GET /api/setup/preflight — Return onboarding readiness checks
  app.get('/api/setup/preflight', (c) => {
    const checks = [
      { name: 'Environment file',  ok: existsSync('.env') || existsSync('/data/.env'),                         detail: '.env file present' },
      { name: 'RH Portal token',   ok: !!process.env.REDHAT_OFFLINE_TOKEN,                                    detail: 'REDHAT_OFFLINE_TOKEN configured' },
      { name: 'OAuth keys',        ok: existsSync(resolve(SRV_CONFIG_DIR, 'gcp-oauth.keys.json')),            detail: 'Google OAuth keys uploaded' },
      { name: 'Config directory',  ok: existsSync(SRV_CONFIG_DIR),                                            detail: 'Config storage ready' },
      { name: 'Cache directory',   ok: existsSync(CACHE_DIR),                                                 detail: 'Cache storage ready' },
    ]
    return c.json({ checks, allPassed: checks.every(ch => ch.ok) })
  })

  // POST /api/setup/upload-oauth-keys — Save uploaded GCP OAuth keys JSON
  app.post('/api/setup/upload-oauth-keys', async (c) => {
    try {
      const body = await c.req.json()
      if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON' }, 400)
      const credType = body.installed ? 'installed' : body.web ? 'web' : null
      if (!credType) return c.json({ error: 'Keys file must have an "installed" or "web" key' }, 400)
      const raw = body[credType]
      const { client_id, client_secret } = raw ?? {}
      if (!client_id || !client_secret) return c.json({ error: 'Missing client_id or client_secret' }, 400)
      // Sanitize: only write known OAuth fields — never persist arbitrary keys
      const sanitized: Record<string, unknown> = { client_id, client_secret }
      for (const f of ['project_id','auth_uri','token_uri','auth_provider_x509_cert_url','client_x509_cert_url','redirect_uris','javascript_origins']) {
        if (raw[f] !== undefined) sanitized[f] = raw[f]
      }
      const dir = resolve(OAUTH_KEYS_PATH, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSyncRaw(OAUTH_KEYS_PATH, JSON.stringify({ [credType]: sanitized }, null, 2), { mode: 0o600 })
      return c.json({ ok: true })
    } catch (_e: any) {
      return c.json({ error: 'Failed to save OAuth keys — check file permissions' }, 500)
    }
  })

  // POST /api/setup/reset — Clear all config and cache for a clean setup
  // ?full=true also removes the OAuth keys file (simulate brand new user)
  app.post('/api/setup/reset', (c) => {
    console.warn('[reset] Factory reset triggered at', new Date().toISOString())
    if (c.req.query('confirm') !== 'true') {
      return c.json({ error: 'Destructive operation requires ?confirm=true' }, 400)
    }
    if (supportableScrapeRunning || ccspScrapeRunning || _rhScrapeRunning) {
      return c.json({ error: 'Cannot reset while scrape is in progress' }, 409)
    }
    const full = c.req.query('full') === 'true'
    const deleted: string[] = []
    const tryDelete = (p: string) => { try { if (existsSync(p)) { unlinkSync(p); deleted.push(p) } } catch {} }

    // Config files
    tryDelete(CUSTOMERS_PATH)
    tryDelete(SHEETS_SYNC_PATH)
    tryDelete(DATA_SOURCES_PATH)
    if (full) {
      tryDelete(GOOGLE_UNIFIED_TOKEN_PATH)
      tryDelete(OAUTH_KEYS_PATH)
    }

    // All cache files
    try {
      readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).forEach(f => tryDelete(resolve(CACHE_DIR, f)))
    } catch {}

    // Reset in-memory state
    customers.splice(0, customers.length)
    aes.splice(0, aes.length)
    saveAes([])
    pendingOAuthStates.clear()
    if (process.env.AE_PARENT_FOLDER_ID) delete process.env.AE_PARENT_FOLDER_ID
    if (process.env.AE_PARENT_FOLDER_IDS) delete process.env.AE_PARENT_FOLDER_IDS

    return c.json({ ok: true, deleted: deleted.length })
  })

  // POST /api/setup/infer-domains — infer customer domains from Gmail + Calendar signal
  app.post('/api/setup/infer-domains', async (c) => {
    if (customers.length === 0) return c.json({ error: 'No customers configured' }, 400)
    try {
      // Process in batches of 3 to avoid overwhelming Google API rate limits
      // (naive Promise.all on 19 customers fires ~950 concurrent Gmail calls)
      const results = []
      for (let i = 0; i < customers.length; i += 3) {
        const batch = customers.slice(i, i + 3)
        const batchResults = await Promise.all(
          batch.map((cu) =>
            inferCustomerDomain(cu, GOOGLE_UNIFIED_TOKEN_PATH).catch((e) => ({
              customerName: cu.name,
              candidates: [],
              currentDomain: cu.domain,
              error: sanitizeErr(e),
            }))
          )
        )
        results.push(...batchResults)
      }
      return c.json({ results })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/setup/save-domains — persist inferred/edited domains to customers.json
  // Accepts optional domainOverride per customer (bypasses BLOCKLIST for that domain)
  app.post('/api/setup/save-domains', async (c) => {
    const body = await c.req.json<{ domains: { name: string; domain: string; domainOverride?: string }[] }>()
    if (!body.domains?.length) return c.json({ error: 'No domains provided' }, 400)

    for (const d of body.domains) {
      if (!isValidDomain(d.domain)) return c.json({ error: `Invalid domain: ${d.domain}` }, 400)
      if (d.domainOverride !== undefined && d.domainOverride !== '' && !isValidDomain(d.domainOverride)) {
        return c.json({ error: `Invalid domainOverride: ${d.domainOverride}` }, 400)
      }
    }

    const domainMap = new Map(body.domains.map((d) => [d.name, d]))
    const updated = customers.map((cu) => {
      const entry = domainMap.get(cu.name)
      if (entry === undefined) return cu
      const patch: Record<string, unknown> = { domain: entry.domain }
      if (entry.domainOverride !== undefined) patch.domainOverride = entry.domainOverride || undefined
      return { ...cu, ...patch }
    })

    try {
      writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2), { mode: 0o600 })
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      customers.splice(0, customers.length, ...updated)
      return c.json({ ok: true, updated: body.domains.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/setup/save-customers — replace entire customer list from Setup UI
  app.post('/api/setup/save-customers', async (c) => {
    try {
      const body = await c.req.json<{ customers: Customer[] }>()
      if (!Array.isArray(body.customers)) return c.json({ error: 'customers must be an array' }, 400)
      if (body.customers.length === 0) return c.json({ error: 'Refusing to overwrite customer list with empty array — this would wipe all customers' }, 400)
      if (body.customers.length > 200) return c.json({ error: 'customers array exceeds maximum of 200 entries' }, 400)

      // Validate each customer
      for (let i = 0; i < body.customers.length; i++) {
        const cx = body.customers[i]
        const name = sanitizeText(cx.name)
        if (!name) return c.json({ error: `customers[${i}].name is invalid or contains disallowed characters` }, 400)
        if (cx.domain !== undefined && !isValidDomain(cx.domain)) return c.json({ error: `customers[${i}].domain is not a valid domain` }, 400)
        // Write whitelisted fields only — drop anything not in the Customer schema
        const cleaned: Record<string, unknown> = { name }
        if (cx.domain          != null) cleaned.domain          = cx.domain
        if (cx.accountNumbers  != null) {
          if (!Array.isArray(cx.accountNumbers) || cx.accountNumbers.some((n: unknown) => typeof n !== 'string' || !/^\d{4,12}$/.test(n))) {
            return c.json({ error: `customers[${i}].accountNumbers must be an array of 4-12 digit strings` }, 400)
          }
          cleaned.accountNumbers  = cx.accountNumbers
        }
        if (cx.ae              != null) cleaned.ae              = cx.ae
        if (cx.segment         != null) cleaned.segment         = cx.segment
        if (cx.region          != null) cleaned.region          = cx.region
        if (cx.sheetTab        != null) cleaned.sheetTab        = cx.sheetTab
        if (cx.supportableName != null) cleaned.supportableName = cx.supportableName
        if (cx.aliases         != null) cleaned.aliases         = (Array.isArray(cx.aliases) ? cx.aliases : []).filter((a: unknown): a is string => typeof a === 'string').map(a => sanitizeText(a, 100)).filter(Boolean)
        if (cx.aliasDomains    != null) cleaned.aliasDomains    = (Array.isArray(cx.aliasDomains) ? cx.aliasDomains : []).filter((d: unknown): d is string => typeof d === 'string' && isValidDomain(d))
        if (cx.skipAccountDiscovery != null) cleaned.skipAccountDiscovery = cx.skipAccountDiscovery
        body.customers[i] = cleaned as Customer
      }

      writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: body.customers }, null, 2), { mode: 0o600 })
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      customers.splice(0, customers.length, ...body.customers)
      return c.json({ ok: true, count: body.customers.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Test isolation endpoints — snapshot/restore full config state ─────────
  // These endpoints let integration tests save and restore the full server state
  // (AEs + customers) so tests are non-destructive even if afterAll fails.
  // In-memory snapshot — single-process Bun server, no persistence needed.

  let _testSnapshot: { aes: string; customers: string } | null = null

  app.post('/api/__test/snapshot', (c) => {
    try {
      // BKL-TEST-03: Serialize in-memory state, not disk state.
      // Disk can be stale when AEs are added via bootstrap without a restart.
      // Reading disk caused a 2026-04-08 incident where 9 AEs were wiped on restore.
      _testSnapshot = {
        aes:       JSON.stringify({ aes }),
        customers: JSON.stringify({ customers }),
      }
      return c.json({ ok: true, aes: aes.length, customers: customers.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  app.post('/api/__test/restore', (c) => {
    if (!_testSnapshot) return c.json({ error: 'No snapshot to restore — call /api/__test/snapshot first' }, 409)
    try {
      const snap = _testSnapshot
      // Restore AEs
      writeFileSyncRaw(AES_PATH + '.tmp', snap.aes, { mode: 0o600 })
      renameSync(AES_PATH + '.tmp', AES_PATH)
      const restoredAes = JSON.parse(snap.aes).aes ?? []
      setAes(restoredAes)
      aes.splice(0, aes.length, ...restoredAes)
      // Restore customers
      writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', snap.customers, { mode: 0o600 })
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      const restoredCustomers = JSON.parse(snap.customers).customers ?? []
      setCustomers(restoredCustomers)
      customers.splice(0, customers.length, ...restoredCustomers)
      _testSnapshot = null  // consume snapshot
      return c.json({ ok: true, aes: restoredAes.length, customers: restoredCustomers.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })
}
