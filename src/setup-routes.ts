import { readFileSync, writeFileSync, writeFileSync as writeFileSyncRaw, mkdirSync, readdirSync, existsSync, unlinkSync, statSync } from 'fs'
import { writeJsonAtomic, writeFileAtomic } from './lib/atomic-write.ts'
import { resolve, dirname } from 'path'
import { google } from 'googleapis'
import { Hono } from 'hono'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, OAUTH_KEYS_PATH } from './google.ts'
import { normalizeSettings } from './region-config.ts'
import { customers, aes, saveAes, CUSTOMERS_PATH, AES_PATH, setAes, setCustomers } from './server-state.ts'
import type { Customer } from './types.ts'
import { NORMAL_SCOPES, BOOTSTRAP_SCOPES, getScopeLevel, type StoredToken } from './oauth-scopes.ts'
import { inferCustomerDomain } from './domains.ts'
import { sanitizeErr, sanitizeText } from './utils.ts'
// BKL-ARCH-L4-SPLIT: supportable-scraper and ccsp-scraper are L4-only modules.
// The scrape guard below uses static false stubs so reset is always unblocked in the hero install.
// L4 daemon (primary node) never calls /api/setup/reset.
const supportableScrapeRunning = false
const ccspScrapeRunning = false
import { _rhScrapeRunning, clearSessionFiles } from './scraper-manager.ts'
import { resetBootstrapStates, resetTableauStatusCache } from './bootstrap-orchestrator.ts'

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

/**
 * Drive config merge — fetch Config/settings.json from Drive at startup
 * if parentFolderId is set for any region. Merges Drive regions[] into
 * local settings.json (Drive wins on regions[], local wins on everything else).
 * Best-effort: errors are logged but never crash the server.
 */
export async function runStartupDriveMerge(): Promise<void> {
  const SETTINGS_PATH_SRV = resolve(SRV_CONFIG_DIR, 'settings.json')
  try {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(SETTINGS_PATH_SRV, 'utf-8')) as Record<string, unknown>
    } catch {
      return // No settings.json yet — skip
    }
    const settings = normalizeSettings(raw)
    const regionsWithParent = settings.regions.filter(r => r.parentFolderId)
    if (regionsWithParent.length === 0) return
    const region = regionsWithParent[0]
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const listRes = await drive.files.list({
      q: `'${region.parentFolderId}' in parents and name='Config' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    const configFolderId = listRes.data.files?.[0]?.id
    if (!configFolderId) return
    const fileList = await drive.files.list({
      q: `'${configFolderId}' in parents and name='settings.json' and trashed=false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    const fileId = fileList.data.files?.[0]?.id
    if (!fileId) return
    const content = await drive.files.get({ fileId, alt: 'media' } as any)
    const driveSettings = content.data as Record<string, unknown>
    // Deep-merge: Drive wins on regions[], local wins on everything else
    if (Array.isArray(driveSettings.regions)) {
      raw.regions = driveSettings.regions
      writeJsonAtomic(SETTINGS_PATH_SRV, raw)
      console.log('[startup] Merged regions from Drive Config/settings.json')
    }
  } catch (e) {
    console.warn('[startup] Drive config merge skipped:', (e as Error).message)
  }
}

// ── Domain waterfall helpers (BKL-DOM-01) ────────────────────────────────────
// Extracted to src/domain-waterfall.ts (BKL-BOOT-05) — imported from there.
import { waterfallInferDomain } from './domain-waterfall.ts'
export type { WaterfallResult } from './domain-waterfall.ts'

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

export function createSetupRouter(): Hono {
  const router = new Hono()

  // ── Google OAuth browser flow ─────────────────────────────────────────────

  // GET /oauth/start — Redirect browser to Google consent screen
  router.get('/oauth/start', (c) => {
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
    const redirectUri = process.env.OAUTH_BASE_URL
      ? `${process.env.OAUTH_BASE_URL}/oauth/callback`
      : `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`

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
  router.get('/oauth/callback', async (c) => {
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
      const redirectUri = process.env.OAUTH_BASE_URL
        ? `${process.env.OAUTH_BASE_URL}/oauth/callback`
        : `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`
      const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

      const { tokens } = await oauth2Client.getToken(code)
      const tokenData = { ...tokens, configuredAt: new Date().toISOString(), scopeLevel: scopeMode }

      // Save to config dir (works both locally and in container via volume mount)
      const tokenPath = GOOGLE_UNIFIED_TOKEN_PATH
      mkdirSync(dirname(tokenPath), { recursive: true })
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
  router.get('/api/oauth/status', async (c) => {
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
      // BKL-UX-OAUTH-SCOPE-01: surface whether the stored token includes
      // https://www.googleapis.com/auth/cloud-platform so the setup page can
      // show a banner prompting re-auth (Gemini falls back to SA key without it).
      const hasCloudPlatformScope = typeof (token as StoredToken).scope === 'string'
        && (token as StoredToken).scope!.includes('cloud-platform')
      return c.json({ authorized: !expired, expired, email, configuredAt: token.configuredAt ?? null, scopeLevel, hasCloudPlatformScope })
    } catch {
      return c.json({ authorized: false })
    }
  })

  // ── Setup wizard routes ───────────────────────────────────────────────────

  // GET /api/setup/check-auth — Check Google OAuth token availability
  router.get('/api/setup/check-auth', async (c) => {
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
  router.get('/api/setup/oauth-keys-status', (c) => {
    return c.json({ exists: existsSync(OAUTH_KEYS_PATH) })
  })

  // GET /api/setup/preflight — Return onboarding readiness checks
  router.get('/api/setup/preflight', (c) => {
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
  router.post('/api/setup/upload-oauth-keys', async (c) => {
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
  // Production guard (BKL-TEST-11): blocks reset when real data is loaded
  router.post('/api/setup/reset', (c) => {
    console.warn('[reset] Factory reset triggered at', new Date().toISOString())
    if (c.req.query('confirm') !== 'true') {
      return c.json({ error: 'Destructive operation requires ?confirm=true' }, 400)
    }
    // ── Production guard: refuse reset when real data is loaded ──────────
    // If more than 5 customers are loaded, this is almost certainly production data.
    // Require ALLOW_RESET=true in env to override (set explicitly for test environments).
    if (customers.length > 5 && process.env.ALLOW_RESET !== 'true') {
      console.error(`[reset] BLOCKED: ${customers.length} customers loaded — production guard triggered`)
      return c.json({
        error: `BLOCKED: ${customers.length} customers loaded — this endpoint requires fewer than 5 customers (production guard). Set ALLOW_RESET=true in env to override.`,
      }, 403)
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
    resetBootstrapStates()
    clearSessionFiles()       // BKL-UX-WIPE-CONN-RESET-01/02: reset all session files
    resetTableauStatusCache() // BKL-UX-WIPE-CONN-RESET-02: force fresh probe on next status check
    if (process.env.AE_PARENT_FOLDER_ID) delete process.env.AE_PARENT_FOLDER_ID
    if (process.env.AE_PARENT_FOLDER_IDS) delete process.env.AE_PARENT_FOLDER_IDS

    return c.json({ ok: true, deleted: deleted.length })
  })

  // POST /api/setup/infer-domains — waterfall domain inference (BKL-DOM-01)
  // Tier 1: Clearbit autocomplete (free) → Tier 2: LLM fallback → Tier 3: validation
  // Falls back to existing Gmail/Calendar/Supportable signal inference if waterfall finds nothing
  router.post('/api/setup/infer-domains', async (c) => {
    if (customers.length === 0) return c.json({ error: 'No customers configured' }, 400)
    try {
      const results = []
      // Process sequentially with 100ms delay to avoid hammering Clearbit
      for (let i = 0; i < customers.length; i++) {
        const cu = customers[i]
        if (i > 0) await new Promise(r => setTimeout(r, 100))

        try {
          // Skip waterfall if customer already has a domain
          if (cu.domain) {
            console.log(`[infer-domains] ${cu.name} → already has domain: ${cu.domain}, skipping waterfall`)
            // Still run existing inference for candidates/confirmation
            const existing = await inferCustomerDomain(cu, GOOGLE_UNIFIED_TOKEN_PATH).catch((e) => ({
              customerName: cu.name,
              candidates: [],
              currentDomain: cu.domain,
              error: sanitizeErr(e),
            }))
            results.push(existing)
            continue
          }

          // Run waterfall: Clearbit → LLM → validate
          const wf = await waterfallInferDomain(cu.name)

          // Also run existing signal-based inference (Gmail/Calendar/Supportable)
          const existing = await inferCustomerDomain(cu, GOOGLE_UNIFIED_TOKEN_PATH).catch((e) => ({
            customerName: cu.name,
            candidates: [] as any[],
            currentDomain: cu.domain,
            error: sanitizeErr(e),
          }))

          // If waterfall found a domain, inject it as top candidate with 'web' source
          if (wf.domain) {
            const waterfallCandidate = {
              domain: wf.domain,
              count: 0,
              sources: ['web' as const],
              tier: wf.tier,
              verified: wf.verified,
            }
            // Check if domain already in candidates
            const existingIdx = existing.candidates.findIndex(
              (c: any) => c.domain === wf.domain
            )
            if (existingIdx >= 0) {
              // Merge: add tier/verified metadata to existing candidate
              const ec = existing.candidates[existingIdx] as any
              ec.tier = wf.tier
              ec.verified = wf.verified
              if (!ec.sources.includes('web')) ec.sources.unshift('web')
              // Move to top if not already
              if (existingIdx > 0) {
                existing.candidates.splice(existingIdx, 1)
                existing.candidates.unshift(ec)
              }
            } else {
              // Insert waterfall result as top candidate
              existing.candidates.unshift(waterfallCandidate)
            }
          }

          results.push(existing)
        } catch (e: any) {
          results.push({
            customerName: cu.name,
            candidates: [],
            currentDomain: cu.domain,
            error: sanitizeErr(e),
          })
        }
      }
      return c.json({ results })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/setup/save-domains — persist inferred/edited domains to customers.json
  // Accepts optional domainOverride per customer (bypasses BLOCKLIST for that domain)
  router.post('/api/setup/save-domains', async (c) => {
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
      writeJsonAtomic(CUSTOMERS_PATH, { customers: updated })
      customers.splice(0, customers.length, ...updated)
      return c.json({ ok: true, updated: body.domains.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/setup/save-customers — replace entire customer list from Setup UI
  router.post('/api/setup/save-customers', async (c) => {
    try {
      const body = await c.req.json<{ customers: Customer[] }>()
      if (!Array.isArray(body.customers)) return c.json({ error: 'customers must be an array' }, 400)
      if (body.customers.length === 0) return c.json({ error: 'Refusing to overwrite customer list with empty array — this would wipe all customers' }, 400)
      if (body.customers.length > 200) return c.json({ error: 'customers array exceeds maximum of 200 entries' }, 400)

      // Production guard: refuse to overwrite if >5 customers are already loaded
      // and ALLOW_RESET is not set (test containers set ALLOW_RESET=true)
      if (customers.length > 5 && process.env.ALLOW_RESET !== 'true') {
        console.error(`[save-customers] BLOCKED: ${customers.length} customers loaded — production guard triggered`)
        return c.json({
          error: `BLOCKED: ${customers.length} customers loaded — production guard active. save-customers would overwrite ${customers.length} existing records. Set ALLOW_RESET=true in env to override (test containers only).`,
        }, 403)
      }

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
        body.customers[i] = cleaned as unknown as Customer
      }

      writeJsonAtomic(CUSTOMERS_PATH, { customers: body.customers })
      customers.splice(0, customers.length, ...body.customers)
      return c.json({ ok: true, count: body.customers.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Test isolation endpoints — snapshot/restore full config state ─────────
  // These endpoints let integration tests save and restore the full server state
  // (AEs + customers) so tests are non-destructive even if afterAll fails.
  // Disk-persisted snapshot with staleness guard (BKL-TEST-03).

  // BKL-TEST-03: Disk-persisted snapshot with staleness guard.
  // The 2026-04-10 incident: Quinn called restore without snapshot, wiping 105 customers.
  // Guard: snapshot must exist on disk AND be < 24h old before restore is allowed.
  const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000  // 24 hours
  const SNAPSHOT_PATH = resolve(dirname(AES_PATH), '__test_snapshot.json')

  router.post('/api/__test/snapshot', (c) => {
    try {
      // BKL-TEST-03: Serialize in-memory state, not disk state.
      // Disk can be stale when AEs are added via bootstrap without a restart.
      // Reading disk caused a 2026-04-08 incident where 9 AEs were wiped on restore.
      const snapshot = {
        createdAt: Date.now(),
        aes:       JSON.stringify({ aes }),
        customers: JSON.stringify({ customers }),
      }
      // Persist to disk so the guard survives server restarts
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
      writeFileSyncRaw(SNAPSHOT_PATH, JSON.stringify(snapshot), { mode: 0o600 })
      return c.json({ ok: true, aes: aes.length, customers: customers.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.post('/api/__test/restore', async (c) => {
    // ── Guard -1: ALLOW_RESET gate ───────────────────────────────────────────
    // This is the live handler (setup-routes wins Hono first-match over server.ts).
    // Gate must live here — the server.ts handler is dead code for this path.
    if (process.env.ALLOW_RESET !== 'true') {
      return c.json({ error: 'Not available — ALLOW_RESET is not set' }, 404)
    }
    // ── Guard 0: production guard (BKL-TEST-11) ─────────────────────────────
    // If no snapshot exists AND real data is loaded, refuse outright.
    // This catches the scenario where an agent calls restore without ever snapshotting.
    if (!existsSync(SNAPSHOT_PATH) && customers.length > 5 && process.env.ALLOW_RESET !== 'true') {
      console.error(`[restore] BLOCKED: no snapshot + ${customers.length} customers loaded — production guard`)
      return c.json({
        error: `BLOCKED: No snapshot exists and ${customers.length} customers are loaded. `
             + 'Restoring without a prior snapshot would destroy production data. '
             + 'Call POST /api/__test/snapshot first, or set ALLOW_RESET=true to override.',
      }, 403)
    }
    // ── Guard 1: snapshot must exist on disk ────────────────────────────────
    if (!existsSync(SNAPSHOT_PATH)) {
      return c.json({
        error: 'No snapshot exists — call POST /api/__test/snapshot first. '
             + 'Restore without a prior snapshot is blocked to prevent production data loss (BKL-TEST-03).',
      }, 409)
    }

    // ── Guard 2: snapshot must not be stale (max 24h) ───────────────────────
    let snapshot: { createdAt: number; aes: string; customers: string }
    try {
      snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'))
    } catch {
      // Corrupt snapshot file — refuse to restore
      try { unlinkSync(SNAPSHOT_PATH) } catch { /* ignore cleanup errors */ }
      return c.json({
        error: 'Snapshot file is corrupt and has been removed. Take a new snapshot before restoring.',
      }, 409)
    }

    const ageMs = Date.now() - (snapshot.createdAt ?? 0)
    if (ageMs > SNAPSHOT_MAX_AGE_MS) {
      const ageHours = Math.round(ageMs / (60 * 60 * 1000))
      try { unlinkSync(SNAPSHOT_PATH) } catch { /* ignore cleanup errors */ }
      return c.json({
        error: `Snapshot is ${ageHours}h old (max 24h). Stale snapshots are rejected to prevent `
             + 'restoring outdated state over current production data. Take a fresh snapshot.',
      }, 409)
    }

    // ── Guard 3: delta guard — reject restores that diverge >50% from current data (BKL-TEST-18) ──
    // Prevents a 2-customer test snapshot from overwriting 105-customer production data.
    // Pass force: true in request body to override (e.g. intentional wipe-to-empty in tests).
    try {
      const body = await c.req.json().catch(() => ({}))
      const forceRestore = body?.force === true
      const snapshotCustomerCount = JSON.parse(snapshot.customers).customers?.length ?? 0
      const currentCustomerCount = customers.length
      const delta = Math.abs(snapshotCustomerCount - currentCustomerCount) / Math.max(currentCustomerCount, 1)
      if (delta > 0.5 && !forceRestore) {
        return c.json({
          error: `Delta guard: snapshot has ${snapshotCustomerCount} customers but current data has ${currentCustomerCount}. `
               + 'Refusing restore to prevent accidental data loss (>50% divergence). '
               + 'Pass { force: true } in request body to override.',
        }, 400)
      }
    } catch { /* if body parse fails, allow restore to proceed */ }

    try {
      const snap = snapshot
      // Restore AEs
      writeFileAtomic(AES_PATH, snap.aes)
      const restoredAes = JSON.parse(snap.aes).aes ?? []
      setAes(restoredAes)
      aes.splice(0, aes.length, ...restoredAes)
      // Restore customers
      writeFileAtomic(CUSTOMERS_PATH, snap.customers)
      const restoredCustomers = JSON.parse(snap.customers).customers ?? []
      setCustomers(restoredCustomers)
      customers.splice(0, customers.length, ...restoredCustomers)
      // Consume snapshot — one-time use only
      try { unlinkSync(SNAPSHOT_PATH) } catch { /* ignore cleanup errors */ }
      return c.json({ ok: true, aes: restoredAes.length, customers: restoredCustomers.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
