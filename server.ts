import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'fs'
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { fetchEmail, fetchDrive, fetchCalendar, makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, OAUTH_KEYS_PATH } from './src/google.ts'
import { fetchCases, fetchCustomerCases, fetchCustomerSubscriptions, fetchCaseLatestComment } from './src/redhat.ts'
import { fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief, getBriefProvider, isBriefConfigured } from './src/customer.ts'
import { fetchCustomerSheetData, fetchCustomerSheetRaw, fetchCCSPData, fetchCustomerAccountNumbers } from './src/sheets.ts'
import type { CCSPRecord } from './src/sheets.ts'
import { fetchPipelineData, buildPipelineSummary } from './src/pipeline.ts'
import type { PipelineRecord } from './src/pipeline.ts'
import type { Customer, AE, ProductSubscription } from './src/types.ts'
import { inferCustomerDomain } from './src/domains.ts'
import { initDriveWatcher, checkDriveChanges, rebuildFolderMap, getWatcherState, checkFilesModified } from './src/drive-watcher.ts'
import { startLoginBrowser, cancelLoginBrowser, getRhStatus, recordScrapeSuccess, recordScrapeExpired, lastScraped } from './src/rh-auth.ts'
import { runRhScrape, SessionExpiredError, initScrapeContext, closeScrapeContext, getScrapeContext, getLivePage, setSessionExpiredCallback } from './src/rh-scraper.ts'
import { discoverAccountNumbers } from './src/rh-account-discovery.ts'
import { runSfPipelineSync, createPipelineSheet, SfSessionExpiredError, setSfSessionExpiredCallback, adoptSfContext, lastSfSync, lastSfRowCount, sfSyncError } from './src/sf-scraper.ts'
import { startSfLoginBrowser, cancelSfLoginBrowser, getSfAuthStatus } from './src/sf-auth.ts'
import { runSupportableScrape, runSupportableDiscoverAndScrape, writeSupportableSheet, adoptSupportableContext, lastSupportableScrape, lastSupportableError, supportableScrapeRunning } from './src/supportable-scraper.ts'
import type { SupportableCustomer } from './src/supportable-scraper.ts'
import { adoptCcspContext, runCcspScrape, writeCcspSheet, ccspScrapeRunning, lastCcspScrape, lastCcspError } from './src/ccsp-scraper.ts'
import { NORMAL_SCOPES, BOOTSTRAP_SCOPES, hasBootstrapScopes, getScopeLevel, type StoredToken } from './src/oauth-scopes.ts'

// Load customer config
const CUSTOMERS_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'customers.json')
  : resolve(import.meta.dir, 'config/customers.json')
let customers: Customer[] = []
try {
  customers = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8')).customers ?? []
} catch {
  console.warn('[warn] config/customers.json not found — customer filtering disabled')
}

// Load AE config
const AES_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'aes.json')
  : resolve(import.meta.dir, 'config/aes.json')
let aes: AE[] = []
try {
  aes = JSON.parse(readFileSync(AES_PATH, 'utf-8')).aes ?? []
  console.log(`[config] loaded ${aes.length} AEs from aes.json`)
} catch {
  console.warn('[warn] config/aes.json not found — AE config unavailable')
}

/** Persist aes[] back to aes.json atomically. */
function saveAes(updated: AE[]): void {
  const tmp = AES_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify({ aes: updated }, null, 2))
  renameSync(tmp, AES_PATH)
  aes = updated
}

/** Extract Tableau territory segment from a full Tableau dashboard URL. */
function extractTableauTerritory(url: string): string | null {
  // URL form: .../CloudConsumption/{guid}/{territory}?...
  const match = url.match(/\/CloudConsumption\/[^/]+\/([^?#]+)/)
  return match?.[1] ?? null
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, 'cache')
mkdirSync(CACHE_DIR, { recursive: true })

const SHEETS_SYNC_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'sheets-sync.json')
  : resolve(import.meta.dir, 'config/sheets-sync.json')

const DATA_SOURCES_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'data-sources.json')
  : resolve(import.meta.dir, 'config/data-sources.json')

// Load data-sources config (sets AE_PARENT_FOLDER_IDS from saved setup)
try {
  const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
  // Support both new array format and old single-folder format
  const folders: { folderId: string }[] = ds.aeFolders ?? (ds.aeFolderID ? [{ folderId: ds.aeFolderID }] : [])
  const ids = folders.map((f: { folderId: string }) => f.folderId).filter(Boolean)
  if (ids.length) {
    if (!process.env.AE_PARENT_FOLDER_IDS) process.env.AE_PARENT_FOLDER_IDS = ids.join(',')
    if (!process.env.AE_PARENT_FOLDER_ID) process.env.AE_PARENT_FOLDER_ID = ids[0]
  }
} catch {}

const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, 'config')
const SHEETS_TOKEN_PATH_SRV = process.env.SHEETS_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.sheets-token.json')
const GDRIVE_TOKEN_PATH_SRV = process.env.GDRIVE_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.gdrive-server-credentials.json')

const GOOGLE_OAUTH_KEYS_PATH = process.env.GOOGLE_OAUTH_KEYS
  ?? resolve(SRV_CONFIG_DIR, 'gcp-oauth.keys.json')

const OAUTH_STATE_PATH = resolve(SRV_CONFIG_DIR, 'oauth-state.json')

const RH_SESSION_PATH = process.env.RH_SESSION
  ?? resolve(SRV_CONFIG_DIR, '.rh-session.json')
const RH_PROFILE_DIR = process.env.RH_PROFILE_DIR
  ?? resolve(SRV_CONFIG_DIR, '.rh-chrome-profile')
const RH_CASES_CACHE_PATH = resolve(CACHE_DIR, 'cases.json')
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'your-admin@example.com'
const SF_REPORT_ID   = process.env.SF_REPORT_ID ?? ''
const SF_SESSION_PATH = process.env.SF_SESSION
  ?? resolve(SRV_CONFIG_DIR, '.sf-session.json')

let oauthState = '' // CSRF state token for browser OAuth flow

const toSlug = (name: string) => name.toLowerCase().replace(/\s+/g, '-')

function briefCachePath(customerName: string): string {
  const today = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD local time
  return `${CACHE_DIR}/${toSlug(customerName)}-${today}.json`
}

function readBriefCache(customerName: string): { text: string; cachedAt: string } | null {
  try {
    return JSON.parse(readFileSync(briefCachePath(customerName), 'utf-8'))
  } catch {
    return null
  }
}

function writeBriefCache(customerName: string, text: string): void {
  try {
    const path = briefCachePath(customerName)
    writeFileSync(path, JSON.stringify({ text, cachedAt: new Date().toISOString() }))
  } catch {
    // Cache write failure is non-fatal
  }
}

// ── Sheet data cache — permanent (no date), stays until force-refreshed ────────
function sheetCachePath(customerName: string): string {
  return `${CACHE_DIR}/${toSlug(customerName)}-sheets.json`
}

function readSheetCache(customerName: string): { rows: ProductSubscription[]; cachedAt: string } | null {
  try {
    return JSON.parse(readFileSync(sheetCachePath(customerName), 'utf-8'))
  } catch {
    return null
  }
}

function writeSheetCache(customerName: string, rows: ProductSubscription[]): void {
  try {
    writeFileSync(sheetCachePath(customerName), JSON.stringify({ rows, cachedAt: new Date().toISOString() }))
  } catch {}
}

const app = new Hono()

// ── Security helpers ──────────────────────────────────────────────────────────

/** Strip HTML tags, trim, and enforce max length. Returns sanitized string or null if invalid. */
function sanitizeText(value: unknown, maxLen = 200): string | null {
  if (typeof value !== 'string') return null
  const stripped = value.replace(/<[^>]*>/g, '').trim()
  if (stripped.length === 0 || stripped.length > maxLen) return null
  return stripped
}

/**
 * Normalize a customer name for use as a Drive folder name and search key.
 * Strips state suffixes, legal entity suffixes, and parentheticals; applies title case.
 * Input:  "DROPBOX, INC. - CA"  →  Output: "Dropbox"
 * Input:  "FRED HUTCHINSON CANCER CENTER"  →  Output: "Fred Hutchinson Cancer Center"
 * Input:  "A10 NETWORKS, INC."  →  Output: "A10 Networks"
 */
function normalizeCustomerName(raw: string): string {
  let name = raw.trim()
  // Strip state suffix " - XX" or " - XX/XX"
  name = name.replace(/\s+-\s+[A-Z]{2}(\/[A-Z]{2})?$/, '')
  // Strip parentheticals like "(REI)" or "(HostGator)"
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  // Strip legal entity suffixes (with or without leading comma)
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i,
    /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,
    /,?\s+INC\.?$/i,
    /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,
    /,?\s+CORP\.?$/i,
    /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  // Title case: preserve words with digits (A10, H2O) or internal dots (U.S.) or already mixed case
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

/** Loose domain validation — allows subdomains, TLDs, IP-like strings, localhost. Rejects HTML. */
function isValidDomain(value: unknown): boolean {
  if (typeof value !== 'string') return true // optional field — absent is OK
  if (value === '') return true
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-._]{0,251}[a-zA-Z0-9])?$/.test(value)
}

/** Salesforce report/object ID — alphanumeric only, 15–18 chars. */
function isValidSfId(value: unknown): boolean {
  if (typeof value !== 'string') return true
  if (value === '') return true
  return /^[A-Za-z0-9]{15,18}$/.test(value)
}

// ── Security headers middleware ───────────────────────────────────────────────

app.use('*', async (c, next) => {
  await next()
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
})

// Health check — used by container health probes and smoke tests
app.get('/health', (c) => c.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  aes: aes.length,
  customers: customers.length,
  session: !!getScrapeContext(),
}))

// Redirect root to command center
app.get('/', (c) => c.redirect('/dashboard'))

// Customer list for landing page
app.get('/customers', (c) => c.json(customers))

// ── Google OAuth browser flow ─────────────────────────────────────────────────

// GET /oauth/start — Redirect browser to Google consent screen
app.get('/oauth/start', (c) => {
  if (!existsSync(GOOGLE_OAUTH_KEYS_PATH)) {
    return c.html(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9">
      <h2 style="color:#f1f5f9">OAuth Keys Not Found</h2>
      <p style="color:#94a3b8">Place your GCP OAuth credentials file at:</p>
      <code style="background:#1e293b;padding:.5rem 1rem;border-radius:.5rem;display:block;margin:1rem 0;color:#e2e8f0">${GOOGLE_OAUTH_KEYS_PATH}</code>
      <p style="color:#94a3b8">Or set the <code>GOOGLE_OAUTH_KEYS</code> environment variable.</p>
      <p><a href="/dashboard/setup" style="color:#818cf8">← Back to Setup</a></p>
    </body></html>`, 400)
  }

  const mode = c.req.query('mode') === 'bootstrap' ? 'bootstrap' : 'normal'
  const scopes = mode === 'bootstrap' ? BOOTSTRAP_SCOPES : NORMAL_SCOPES

  const keys = JSON.parse(readFileSync(GOOGLE_OAUTH_KEYS_PATH, 'utf-8'))
  const { client_id, client_secret } = keys.installed ?? keys.web
  const redirectUri = `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

  // Encode mode into state so callback knows which scopeLevel to write
  const csrfToken = Math.random().toString(36).slice(2) + Date.now().toString(36)
  oauthState = `${csrfToken}:${mode}`

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state: oauthState,
    scope: [...scopes],
  })

  return c.redirect(authUrl)
})

// GET /oauth/callback — Handle Google redirect, exchange code for tokens
app.get('/oauth/callback', async (c) => {
  const code  = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  const errorPage = (msg: string, detail?: string) => c.html(`
    <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9">
      <h2 style="color:#f87171">Authentication Failed</h2>
      <p style="color:#94a3b8">${msg}</p>
      ${detail ? `<code style="background:#1e293b;padding:.5rem 1rem;border-radius:.5rem;display:block;margin:1rem 0;color:#fca5a5">${detail}</code>` : ''}
      <p><a href="/dashboard/setup" style="color:#818cf8">← Back to Setup</a></p>
    </body></html>`, 400)

  if (error) {
    if (error === 'access_denied') {
      return c.html(`
        <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9;max-width:600px;margin:0 auto">
          <h2 style="color:#fbbf24">Access Denied</h2>
          <p style="color:#94a3b8">Your Google account hasn't been added as a test user yet.</p>
          <p style="color:#94a3b8">Email <strong style="color:#f1f5f9">${ADMIN_EMAIL}</strong> and ask to be added, then try again.</p>
          <p style="margin-top:1.5rem">
            <a href="mailto:${ADMIN_EMAIL}?subject=Dashboard%20Access%20Request&body=Please%20add%20my%20Google%20account%20as%20a%20test%20user.%0A%0AMy%20email%3A%20%5Byour%40email.com%5D"
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
  if (state !== oauthState) return errorPage('Invalid state parameter — please try again')

  try {
    const keys = JSON.parse(readFileSync(GOOGLE_OAUTH_KEYS_PATH, 'utf-8'))
    const { client_id, client_secret } = keys.installed ?? keys.web
    const redirectUri = `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

    const { tokens } = await oauth2Client.getToken(code)
    // Parse mode from state param (format: "csrfToken:mode")
    const scopeMode = state?.split(':')[1] === 'bootstrap' ? 'bootstrap' : 'normal'
    const tokenData = { ...tokens, configuredAt: new Date().toISOString(), scopeLevel: scopeMode }

    // Save to config dir (works both locally and in container via volume mount)
    const tokenPath = GOOGLE_UNIFIED_TOKEN_PATH
    writeFileSyncRaw(tokenPath, JSON.stringify(tokenData, null, 2))
    oauthState = '' // consume state

    return c.html(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9;max-width:600px;margin:0 auto">
        <h2 style="color:#34d399">✓ Google Workspace Connected</h2>
        <p style="color:#94a3b8">Calendar, Gmail, Drive, and Sheets access authorized.</p>
        <p style="color:#94a3b8">Redirecting to setup wizard…</p>
        <script>setTimeout(() => window.location.href = '/dashboard/setup?step=2', 1500)</script>
        <p><a href="/dashboard/setup?step=2" style="color:#818cf8">Continue →</a></p>
      </body></html>`)
  } catch (e: any) {
    return errorPage('Token exchange failed', e.message)
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
    const pendingDowngrade = (() => {
      try { return JSON.parse(readFileSync(OAUTH_STATE_PATH, 'utf-8')).pendingDowngrade ?? false } catch { return false }
    })()
    return c.json({ authorized: !expired, expired, email, configuredAt: token.configuredAt ?? null, scopeLevel, pendingDowngrade })
  } catch {
    return c.json({ authorized: false })
  }
})

// ── Red Hat Portal auth endpoints ────────────────────────────────────────────

// GET /api/auth/redhat/status — Session health, scrape timestamps, login state
app.get('/api/auth/redhat/status', (c) => {
  const status = getRhStatus(RH_SESSION_PATH)
  // hasSession requires both a session file AND a live browser context —
  // the file persists across restarts but the context must be active to scrape
  return c.json({ ...status, hasSession: status.hasSession && getScrapeContext() !== null })
})

// POST /api/auth/redhat/start — Launch headed browser for RH portal login
app.post('/api/auth/redhat/start', async (c) => {
  try {
    await startLoginBrowser(RH_SESSION_PATH, RH_PROFILE_DIR, () => {
      // Pre-warm Supportable session in background immediately after RH login.
      // The auth.redhat.com SSO session is fresh — navigating to Supportable now
      // auto-completes SSO and saves the Supportable session cookie to the profile,
      // so subsequent headless bootstrap runs can access Supportable without re-auth.
      const ctx = getScrapeContext()
      if (ctx) {
        const SUPPORTABLE_PREWARM_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
        ;(async () => {
          const p = await ctx.newPage()
          try {
            await p.goto(SUPPORTABLE_PREWARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
            if (!p.url().includes('supportable.corp.redhat.com')) {
              await p.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 120_000 }).catch(() => {})
            }
            console.log(`[supportable] pre-warm complete — session established (${p.url().includes('supportable') ? 'ok' : 'may need manual login'})`)
          } catch (e: any) {
            console.warn('[supportable] pre-warm failed:', e.message)
          } finally {
            await p.close().catch(() => {})
            // Navigate the live portal page to blank — hides the VNC window after login
            getLivePage()?.goto('about:blank').catch(() => {})
          }
        })().catch(() => {})
      } else {
        // No Supportable pre-warm needed — still hide the VNC window
        getLivePage()?.goto('about:blank').catch(() => {})
      }
      runPortalAccountDiscovery().catch(() => {}).finally(() => runRhScrapeWithState().catch(() => {}))
    })
    return c.json({ started: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 409)
  }
})

// DELETE /api/auth/redhat/session — Cancel in-progress login
app.delete('/api/auth/redhat/session', async (c) => {
  await cancelLoginBrowser()
  return c.json({ cancelled: true })
})

// POST /api/auth/redhat/sync — Trigger immediate scrape
app.post('/api/auth/redhat/sync', async (c) => {
  runRhScrapeWithState().catch(() => {})
  return c.json({ started: true })
})

// POST /api/auth/redhat/discover — Trigger account number portal discovery
app.post('/api/auth/redhat/discover', async (c) => {
  runPortalAccountDiscovery().catch(() => {})
  return c.json({ started: true })
})

// POST /api/test/accountname-search — Call search/v2/cases API directly with accountName SOLR query
// Body: { customers: string[] }
app.post('/api/test/accountname-search', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const customers: string[] = body.customers ?? ['A10 Networks', 'Dropbox', 'Crowdstrike']
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No active RH session' }, 409)
  const page = getLivePage() ?? await ctx.newPage()

  // Ensure we're on the portal so cookies are active
  if (!page.url().includes('access.redhat.com')) {
    await page.goto('https://access.redhat.com/support/cases/#/case/list', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    }).catch(() => {})
    await page.waitForTimeout(3_000)
  }

  const results: Record<string, any> = {}

  // Use the exact expression captured from portal network traffic
  const EXPRESSION = 'sort=case_lastModifiedDate%20desc&facet=true&facet.mincount=0&facet.pivot.mincount=0&facet.sort=index&f.case_product.facet.limit=-1&f.case_version.facet.pivot.limit=-1&f.case_version.facet.pivot.mincount=1&fl=case_createdByName%2Ccase_createdDate%2Ccase_lastModifiedDate%2Ccase_lastModifiedByName%2Cid%2Curi%2Ccase_summary%2Ccase_status%2Ccase_product%2Ccase_version%2Ccase_accountNumber%2Ccase_number%2Ccase_contactName%2Ccase_owner%2Ccase_severity%2Ccase_last_public_update_date%2Ccase_last_public_update_by%2Ccase_customer_escalation%2Ccase_folderName%2Ccase_alternate_id%2Ccase_type%2Ccase_closedDate&facet.field=%7B!ex%3Dc_product%7Dcase_product&facet.field=%7B!ex%3Dc_severity%7Dcase_severity&facet.field=%7B!ex%3Dc_status%7Dcase_status&facet.field=%7B!ex%3Dc_type%7Dcase_type&facet.pivot=%7B!ex%3Dc_product%7Dcase_product%2Ccase_version&fq=%7B!tag%3Dc_product%7D*%3A*'

  // Test queries: get all fields to discover the account name field name, then try variants
  const testQueries = customers.flatMap(name => [
    { label: `${name} [all-fields sample]`, q: '*:*', fl: '*' },
    { label: `${name} [accountName]`, q: `accountName: "${name}"`, fl: null },
    { label: `${name} [case_accountName]`, q: `case_accountName: "${name}"`, fl: null },
    { label: `${name} [account_name]`, q: `account_name: "${name}"`, fl: null },
    { label: `${name} [contactName]`, q: `contactName: "${name}"`, fl: null },
  ])

  for (const { label, q, fl } of testQueries) {
    const apiResult = await page.evaluate(async ({ q, fl, expression }: { q: string; fl: string | null; expression: string }) => {
      try {
        // Build expression: if fl override provided, replace the fl= portion
        let expr = expression
        if (fl) {
          expr = expr.replace(/fl=[^&]+/, `fl=${encodeURIComponent(fl)}`)
        }
        const res = await fetch(
          `https://access.redhat.com/hydra/rest/search/v2/cases?redhat_client=Portal%20Case%20Management%202.44.57&account_number=901532`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q, start: 0, rows: 2, partnerSearch: false, expression: expr }),
          }
        )
        const text = await res.text()
        if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
        return { data: JSON.parse(text) }
      } catch (e: any) {
        return { error: e.message }
      }
    }, { q, fl: fl ?? null, expression: EXPRESSION })

    if (apiResult.error) { results[label] = { error: apiResult.error }; continue }

    const data = apiResult.data
    const docs: any[] = data?.response?.docs ?? []
    const numFound: number = data?.response?.numFound ?? 0
    const accountNumbers = [...new Set(docs.map((d: any) => d.case_accountNumber).filter(Boolean))]

    results[label] = {
      numFound,
      docCount: docs.length,
      accountNumbers,
      // For wildcard/all-fields queries: show sorted field names for discovery
      allFieldNames: fl ? docs.flatMap((d: any) => Object.keys(d)).filter((v, i, a) => a.indexOf(v) === i).sort() : undefined,
      sampleDoc: fl ? docs[0] ?? null : undefined,
    }

    // Skip wildcard for remaining customers (only needed once to confirm API works)
    if (q === '*:*' && Object.keys(results).length >= 1) {
      // Continue testing accountName/case_accountName queries for all customers
    }
  }

  return c.json(results)
})

// POST /api/test/supportable-customer-search — Search Supportable by customer name, return account numbers
// Body: { customerName: string }  e.g. { customerName: "Dropbox" }
app.post('/api/test/supportable-customer-search', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const customerName: string = body.customerName ?? 'Dropbox'
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No active RH session' }, 409)

  const SUPPORTABLE_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
  let page = await ctx.newPage()

  try {
    // Mirror the existing Supportable scraper's navigation + SSO handling exactly
    await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)

    if (!page.url().includes('supportable.corp.redhat.com')) {
      // SSO redirect — page will navigate back or close
      let pageClosedByApex = false
      const closePromise = new Promise<void>(resolve => { page.once('close', () => { pageClosedByApex = true; resolve() }) })
      await Promise.race([
        page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 120_000 }).catch(() => {}),
        closePromise,
      ])
      if (pageClosedByApex) page = await ctx.newPage()
      // Fresh navigation after SSO
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
    }

    if (!page.url().includes('supportable.corp.redhat.com')) {
      await page.close()
      return c.json({ error: 'Supportable SSO failed', url: page.url() }, 409)
    }

    // Fill Customer Name field — APEX naming convention: P0_CUSTOMER_NAME
    // Wildcard % matches any suffix (standard Oracle LIKE syntax)
    let fieldId = 'P0_CUSTOMER_NAME'
    let filled = false
    for (const candidate of ['P0_CUSTOMER_NAME', 'P0_CUST_NAME', 'P0_CUSTOMER']) {
      const el = await page.$(`input#${candidate}`).catch(() => null)
      if (el) { fieldId = candidate; filled = true; break }
    }
    if (!filled) {
      // Dump visible inputs to help identify the right field
      const inputDump = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map(el => ({
          id: el.id, name: (el as HTMLInputElement).name,
          label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ?? '',
        })).filter(f => f.id || f.name)
      ).catch(() => [])
      await page.close()
      return c.json({ error: 'Customer Name input not found — try one of these IDs', inputDump })
    }

    await page.fill(`input#${fieldId}`, `${customerName}%`)
    console.log(`[test/supportable] Filled #${fieldId} with "${customerName}%"`)
    await page.click('button.button-alt1')
    // APEX does a server-side POST + redirect chain — wait for full settle
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(5_000)

    // Scrape the results table — retry if APEX is still navigating
    let tableData: any = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        tableData = await page.evaluate(() => { return 'PROBE_OK' })
        break
      } catch {
        console.log(`[test/supportable] results page still navigating (attempt ${attempt + 1}) — waiting…`)
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
        await page.waitForTimeout(3_000)
      }
    }
    if (!tableData) { await page.close(); return c.json({ error: 'Results page never settled after 4 attempts' }) }

    tableData = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'))
      // APEX IR result tables use <th> headers — search for party/customer/entl headers
      for (const t of tables) {
        const ths = Array.from(t.querySelectorAll('th'))
          .map(el => el.textContent?.trim().replace(/\s+/g, ' ') ?? '')
        if (ths.some(h => /party.?number|customer.?number|entl/i.test(h))) {
          const rownumIdx = ths.indexOf('Rownum')
          const rows = Array.from(t.querySelectorAll('tr')).slice(1).flatMap(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim().replace(/\s+/g, ' ') ?? '')
            // Skip APEX count rows and empty rows — data rows have a numeric Rownum cell
            if (!cells.some(c => c)) return []
            if (rownumIdx >= 0 && !/^\d+$/.test(cells[rownumIdx] ?? '')) return []
            if (cells.length < ths.length - 2) return []  // too few cells
            const obj: Record<string, string> = {}
            ths.forEach((h, i) => { obj[h] = cells[i] ?? '' })
            return [obj]
          })
          return { headers: ths, rows }
        }
      }
      // Debug: show what tables exist and their header structures
      return {
        error: `No results table found (${tables.length} tables)`,
        tableCount: tables.length,
        tableDebug: tables.slice(0, 8).map(t => ({
          cls: t.className.slice(0, 60),
          ths: Array.from(t.querySelectorAll('th')).slice(0, 6).map(th => th.textContent?.trim().slice(0, 30) ?? ''),
        })),
      }
    })

    await page.close()

    if ('error' in tableData) return c.json({ customerName, fieldId, inputFields, tableData })

    // Filter: Country = Web or USA, Entl Active Cnt > 0
    const filtered = (tableData.rows as Record<string, string>[]).filter(row => {
      const country = (row['Country'] ?? '').trim()
      const entlActive = parseInt(row['Entl Active Cnt'] ?? row['Entl\nActive\nCnt'] ?? '0', 10)
      return (country === 'Web' || country === 'USA') && entlActive > 0
    })

    const accountNumbers = [...new Set(
      filtered.map(r => r['Customer Number'] ?? r['CustomerNumber'] ?? '').filter(Boolean)
    )]

    return c.json({
      customerName,
      fieldId,
      totalRows: (tableData.rows as any[]).length,
      filteredRows: filtered.length,
      accountNumbers,
      headers: tableData.headers,
      allRows: (tableData.rows as any[]).slice(0, 10),
    })
  } catch (e: any) {
    await page.close().catch(() => {})
    return c.json({ error: e.message }, 500)
  }
})

// ── Salesforce pipeline sync endpoints ───────────────────────────────────────

// GET /api/auth/salesforce/status — session + last sync info
app.get('/api/auth/salesforce/status', (c) => {
  return c.json({
    ...getSfAuthStatus(SF_SESSION_PATH),
    lastSync: lastSfSync,
    rowCount: lastSfRowCount,
    syncError: sfSyncError,
    reportConfigured: !!SF_REPORT_ID,
    sheetConfigured: !!process.env.PIPELINE_FILE_ID,
  })
})

// POST /api/auth/salesforce/start — launch headed browser for SF login
// The SSO button auto-clicks; the SAML flow completes without user interaction
// as long as the RH SSO session is active in the profile.
app.post('/api/auth/salesforce/start', async (c) => {
  try {
    await startSfLoginBrowser(SF_SESSION_PATH, RH_PROFILE_DIR, () => {
      // Auto-trigger a pipeline sync for each configured AE after login
      const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
      if (aesWithSf.length) {
        ;(async () => {
          for (const ae of aesWithSf) {
            try {
              let sheetId = ae.pipelineSheetId
              if (!sheetId) {
                sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
                saveAes(aes.map(a => a.name === ae.name ? { ...a, pipelineSheetId: sheetId } : a))
              }
              await runSfPipelineSync(ae.sfReportId!, RH_PROFILE_DIR, sheetId)
            } catch (e: any) {
              console.warn(`[server] SF sync failed for ${ae.name}:`, e?.message)
            }
          }
        })().catch(() => {})
      } else if (SF_REPORT_ID && process.env.PIPELINE_FILE_ID) {
        // Fallback to env vars for backwards compatibility
        runSfPipelineSync(SF_REPORT_ID, RH_PROFILE_DIR, process.env.PIPELINE_FILE_ID).catch(() => {})
      }
    })
    return c.json({ started: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 409)
  }
})

// DELETE /api/auth/salesforce/session — cancel in-progress login
app.delete('/api/auth/salesforce/session', async (c) => {
  await cancelSfLoginBrowser()
  return c.json({ cancelled: true })
})

// POST /api/auth/salesforce/sync — trigger pipeline sync for all configured AEs
app.post('/api/auth/salesforce/sync', async (c) => {
  const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
  if (!aesWithSf.length && !SF_REPORT_ID) return c.json({ error: 'No AEs with sfReportId configured' }, 400)
  ;(async () => {
    for (const ae of aesWithSf) {
      try {
        let sheetId = ae.pipelineSheetId
        if (!sheetId) {
          sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
          saveAes(aes.map(a => a.name === ae.name ? { ...a, pipelineSheetId: sheetId } : a))
        }
        await runSfPipelineSync(ae.sfReportId!, RH_PROFILE_DIR, sheetId)
      } catch (e: any) {
        if (e instanceof SfSessionExpiredError) {
          console.warn('[server] SF session expired during sync')
        } else {
          console.error(`[server] SF sync error for ${ae.name}:`, e?.message ?? e)
        }
      }
    }
    // Fallback: env vars for backwards compatibility
    if (!aesWithSf.length && SF_REPORT_ID && process.env.PIPELINE_FILE_ID) {
      runSfPipelineSync(SF_REPORT_ID, RH_PROFILE_DIR, process.env.PIPELINE_FILE_ID).catch(() => {})
    }
  })().catch(() => {})
  return c.json({ started: true, aes: aesWithSf.map(a => a.name) })
})

// ── Supportable bootstrap endpoints ──────────────────────────────────────────

// GET /api/bootstrap/supportable/status
app.get('/api/bootstrap/supportable/status', (c) => {
  return c.json({
    running:   supportableScrapeRunning,
    lastScrape: lastSupportableScrape,
    lastError:  lastSupportableError,
  })
})

// POST /api/bootstrap/supportable — scrape Supportable for given customers and
// write results to a new Google Sheet. Body:
//   { aeName: string, customers: [{ name, accountNumbers }] }
// On success, stores the sheet ID in each customer's supportableFileId in customers.json.
app.post('/api/bootstrap/supportable', async (c) => {
  if (supportableScrapeRunning) return c.json({ error: 'Scrape already in progress' }, 409)

  const body = await c.req.json<{ aeName?: string; customers?: SupportableCustomer[] }>().catch(() => ({}))
  const aeName = (body.aeName ?? '').trim()
  const scrapeCustomers = body.customers ?? []

  if (!aeName)              return c.json({ error: 'aeName is required' }, 400)
  if (!scrapeCustomers.length) return c.json({ error: 'customers array is required' }, 400)

  // Validate each entry has at least one account number
  for (const c of scrapeCustomers) {
    if (!c.name?.trim())          return c.json({ error: `customer name missing` }, 400)
    if (!c.accountNumbers?.length) return c.json({ error: `no accountNumbers for "${c.name}"` }, 400)
  }

  // Look up AE config for driveFolderId and existing sheet ID
  const aeConfig = aes.find(a => a.name === aeName)

  // Run async — client polls /status
  ;(async () => {
    try {
      const results = await runSupportableScrape(scrapeCustomers)
      const spreadsheetId = await writeSupportableSheet(
        results,
        aeName,
        aeConfig?.driveFolderId || undefined,
        aeConfig?.supportableSheetId || undefined,
      )

      // Write supportableSheetId back to aes.json
      if (aeConfig) {
        const updatedAes = aes.map(a => a.name === aeName ? { ...a, supportableSheetId: spreadsheetId } : a)
        saveAes(updatedAes)
      }

      console.log(`[bootstrap] Supportable sheet ready: ${spreadsheetId}`)
    } catch (e: any) {
      console.error('[bootstrap] Supportable scrape failed:', e.message)
    }
  })()

  return c.json({ started: true })
})

// ── CCSP bootstrap endpoints ──────────────────────────────────────────────────

// GET /api/bootstrap/ccsp/status
app.get('/api/bootstrap/ccsp/status', (c) => {
  return c.json({
    running:    ccspScrapeRunning,
    lastScrape: lastCcspScrape,
    lastError:  lastCcspError,
  })
})

// POST /api/bootstrap/ccsp — scrape CCSP Tableau dashboards for each AE that
// has tableauTerritories and driveFolderId configured, then write results to
// Google Sheets. Body: {} (uses aes.json; no body params required)
// On success, writes ccspSheetId back to aes.json for each AE processed.
app.post('/api/bootstrap/ccsp', async (c) => {
  if (ccspScrapeRunning) return c.json({ error: 'CCSP scrape already in progress' }, 409)

  // Verify bootstrap-level Google permissions
  try {
    const token = JSON.parse(readFileSync(GOOGLE_UNIFIED_TOKEN_PATH, 'utf-8')) as StoredToken
    if (!hasBootstrapScopes(token)) {
      return c.json({ error: 'Bootstrap requires elevated Google Drive permissions', action: 'redirect', url: '/oauth/start?mode=bootstrap' }, 403)
    }
  } catch {
    return c.json({ error: 'Google not connected — authorize via Setup first' }, 401)
  }

  const eligibleAes = aes.filter(a => a.tableauTerritories?.length && a.driveFolderId)
  if (!eligibleAes.length) return c.json({ error: 'No AEs with tableauTerritories and driveFolderId configured' }, 400)

  // Run async — client polls /status
  ;(async () => {
    try {
      const results = await runCcspScrape(eligibleAes)
      for (const ae of eligibleAes) {
        const aeResults = results.filter(r => r.aeName === ae.name)
        const spreadsheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
        const updatedAes = aes.map(a => a.name === ae.name ? { ...a, ccspSheetId: spreadsheetId } : a)
        saveAes(updatedAes)
        console.log(`[bootstrap] CCSP sheet ready for ${ae.name}: ${spreadsheetId}`)
      }
    } catch (e: any) {
      console.error('[bootstrap] CCSP scrape failed:', e.message)
    }
  })()

  return c.json({ started: true, aeCount: eligibleAes.length })
})

// ── Auto-bootstrap endpoints ─────────────────────────────────────────────────

interface AutoBootstrapStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
}

interface AutoBootstrapState {
  running: boolean
  aeName: string | null
  steps: AutoBootstrapStep[]
  error: string | null
  completedAt: string | null
}

let autoBootstrapState: AutoBootstrapState = {
  running: false, aeName: null, steps: [], error: null, completedAt: null
}

app.get('/api/bootstrap/auto/status', (c) => {
  return c.json(autoBootstrapState)
})

// POST /api/bootstrap/auto/reset — clear a stuck bootstrap state
app.post('/api/bootstrap/auto/reset', (c) => {
  autoBootstrapState = { running: false, steps: [], aeName: '', completedAt: null, error: null }
  console.log('[auto-bootstrap] State reset by user request')
  return c.json({ ok: true })
})

// POST /api/oauth/dismiss-downgrade — user has seen the reduce-permissions banner
app.post('/api/oauth/dismiss-downgrade', (c) => {
  try {
    writeFileSyncRaw(OAUTH_STATE_PATH, JSON.stringify({ pendingDowngrade: false, dismissedAt: new Date().toISOString() }, null, 2))
  } catch {}
  return c.json({ ok: true })
})

app.post('/api/bootstrap/auto', async (c) => {
  if (autoBootstrapState.running) return c.json({ error: 'Auto-bootstrap already in progress' }, 409)

  // Verify bootstrap-level Google permissions
  try {
    const token = JSON.parse(readFileSync(GOOGLE_UNIFIED_TOKEN_PATH, 'utf-8')) as StoredToken
    if (!hasBootstrapScopes(token)) {
      return c.json({ error: 'Bootstrap requires elevated Google Drive permissions', action: 'redirect', url: '/oauth/start?mode=bootstrap' }, 403)
    }
  } catch {
    return c.json({ error: 'Google not connected — authorize via Setup first' }, 401)
  }

  const body = await c.req.json<{
    aeName?: string
    sfReportId?: string
    tableauTerritories?: string[]
    customerNames?: string[]
    parentFolderId?: string
  }>().catch(() => ({}))

  const aeName = (body.aeName ?? '').trim()
  const sfReportId = (body.sfReportId ?? '').trim()
  const tableauTerritories = body.tableauTerritories ?? []
  const customerNames = (body.customerNames ?? []).map(n => normalizeCustomerName(n)).filter(Boolean)
  // Accept full Drive URL or bare folder ID — extract ID from URL if needed
  const rawParent = (body.parentFolderId ?? '').trim()
  const parentFolderId = rawParent
    ? (rawParent.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? rawParent)
    : undefined

  if (!aeName) return c.json({ error: 'aeName is required' }, 400)
  if (aeName.length > 200) return c.json({ error: 'aeName exceeds 200 characters' }, 400)
  if (/<[^>]*>/.test(aeName)) return c.json({ error: 'aeName contains invalid characters' }, 400)
  if (!sfReportId) return c.json({ error: 'sfReportId is required' }, 400)
  if (!tableauTerritories.length) return c.json({ error: 'tableauTerritories is required' }, 400)
  if (!customerNames.length) return c.json({ error: 'customerNames is required' }, 400)

  // Upsert AE into aes.json immediately with basic fields
  let aeConfig = aes.find(a => a.name === aeName)
  if (!aeConfig) {
    aeConfig = { name: aeName, driveFolderId: '', sfReportId, tableauTerritories }
    saveAes([...aes, aeConfig])
  } else {
    const updated = aes.map(a => a.name === aeName ? { ...a, sfReportId, tableauTerritories } : a)
    saveAes(updated)
    aeConfig = aes.find(a => a.name === aeName)!
  }

  autoBootstrapState = {
    running: true,
    aeName,
    steps: [
      { name: 'Create Drive Folder', status: 'pending' },
      { name: 'Discover Account Numbers', status: 'pending' },
      { name: 'Create Supportable Sheet', status: 'pending' },
      { name: 'Create CCSP Sheet', status: 'pending' },
      { name: 'Sync Pipeline Sheet', status: 'pending' },
    ],
    error: null,
    completedAt: null,
  }

  const setStep = (idx: number, status: AutoBootstrapStep['status'], detail?: string) => {
    autoBootstrapState.steps[idx] = { ...autoBootstrapState.steps[idx], status, detail }
  }

  // Hard timeout: if bootstrap is still running after 60 minutes, unstick it
  const bootstrapTimeoutId = setTimeout(() => {
    if (autoBootstrapState.running) {
      autoBootstrapState.running = false
      autoBootstrapState.completedAt = new Date().toISOString()
      autoBootstrapState.error = 'Bootstrap timed out after 60 minutes'
      const stuck = autoBootstrapState.steps.findIndex(s => s.status === 'running')
      if (stuck >= 0) autoBootstrapState.steps[stuck] = { ...autoBootstrapState.steps[stuck], status: 'error', detail: 'Timed out' }
      console.error('[auto-bootstrap] Hard timeout reached — unsticking')
    }
  }, 60 * 60 * 1_000)

  // Run async — client polls /api/bootstrap/auto/status
  ;(async () => {
    // Check if AE already has a Drive folder from a previous run — skip creation if so
    const existingAe = aes.find(a => a.name === aeName)
    let driveFolderId = existingAe?.driveFolderId ?? ''

    // Step 1 — Create Drive Folder (skip if already exists)
    try {
      setStep(0, 'running')
      if (driveFolderId) {
        setStep(0, 'done', `Folder: ${driveFolderId}`)
        console.log(`[auto-bootstrap] Drive folder already exists, reusing: ${driveFolderId}`)
      } else {
        const drive = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
        const folder = await drive.files.create({
          requestBody: {
            name: aeName,
            mimeType: 'application/vnd.google-apps.folder',
            ...(parentFolderId ? { parents: [parentFolderId] } : {}),
          },
          supportsAllDrives: true,
          fields: 'id,webViewLink',
        })
        driveFolderId = folder.data.id!
        const updated = aes.map(a => a.name === aeName ? { ...a, driveFolderId } : a)
        saveAes(updated)
        setStep(0, 'done', `Folder: ${driveFolderId}`)
        console.log(`[auto-bootstrap] Drive folder created: ${driveFolderId}`)
      }
    } catch (e: any) {
      setStep(0, 'error', e.message)
      autoBootstrapState.error = `Drive folder creation failed: ${e.message}`
      console.error('[auto-bootstrap] Drive folder creation failed:', e.message)
    }

    // Steps 2 + 3 — Discover Account Numbers via Supportable name search, then
    // immediately scrape subscriptions for each account in the same session.
    // Account numbers are saved to customers.json after each customer completes.
    // Scraped subscription data is held in memory and written to sheet in Step 3.
    let supportableScrapeResults: Awaited<ReturnType<typeof runSupportableDiscoverAndScrape>> = []
    try {
      setStep(1, 'running', `0/${customerNames.length} — starting Supportable…`)
      setStep(2, 'running', 'waiting for discovery…')

      // Build customer objects — include supportableName override from customers.json if present
      const discoverCustomers = customerNames.map(name => {
        const existing = customers.find(cx => cx.name === name)
        return { name, supportableName: existing?.supportableName }
      })
      supportableScrapeResults = await runSupportableDiscoverAndScrape(
        discoverCustomers,
        (done, total, name, accountNumbers, rowCount) => {
          // Save account numbers to customers array immediately after each customer
          const existing = customers.find(cx => cx.name === name)
          if (existing) {
            const merged = new Set([...(existing.accountNumbers ?? []), ...accountNumbers])
            existing.accountNumbers = [...merged]
          } else {
            customers.push({ name, ae: aeName, accountNumbers })
          }
          // Persist to disk after each customer so progress survives a hard timeout
          try {
            const tmpPath = CUSTOMERS_PATH + '.tmp'
            writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2))
            renameSync(tmpPath, CUSTOMERS_PATH)
          } catch {}
          const acctCount = accountNumbers.length
          const summary = acctCount > 0
            ? `✓ ${acctCount} acct${acctCount !== 1 ? 's' : ''}, ${rowCount} rows`
            : 'no match'
          setStep(1, 'running', `${done}/${total} — ${name}: ${summary}`)
          setStep(2, 'running', `${done}/${total} — ${name}: ${summary}`)
          console.log(`[auto-bootstrap] ${done}/${total} ${name}: ${acctCount} accounts, ${rowCount} rows`)
        },
      )

      // Sync any remaining customers to customers.json (handles customers with 0 accounts)
      for (const r of supportableScrapeResults) {
        if (!customers.find(cx => cx.name === r.customerName)) {
          customers.push({ name: r.customerName, ae: aeName, accountNumbers: r.accountNumbers })
        }
      }
      const tmpPath = CUSTOMERS_PATH + '.tmp'
      writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2))
      renameSync(tmpPath, CUSTOMERS_PATH)

      const withAccounts = supportableScrapeResults.filter(r => r.accountNumbers.length > 0).length
      setStep(1, 'done', `${withAccounts}/${customerNames.length} customers matched`)
      console.log(`[auto-bootstrap] Supportable discovery complete: ${withAccounts}/${customerNames.length} matched`)
    } catch (e: any) {
      // Non-fatal: partial results may have been saved to customers.json via the progress callback.
      // Rebuild supportableScrapeResults from whatever customers were persisted so Step 3 can still write them.
      const partialCustomers = customers.filter(cx => cx.ae === aeName && (cx.accountNumbers?.length ?? 0) > 0)
      if (partialCustomers.length > 0) {
        setStep(1, 'error', `${e.message} (${partialCustomers.length} partial results saved)`)
        console.error(`[auto-bootstrap] Supportable discovery+scrape failed midway: ${e.message} — ${partialCustomers.length} customers already saved`)
      } else {
        setStep(1, 'error', e.message)
        setStep(2, 'error', 'discovery failed — no results to write')
        console.error('[auto-bootstrap] Supportable discovery+scrape failed:', e.message)
      }
      autoBootstrapState.error = `Supportable discovery failed: ${e.message}`
    }

    // Step 3 — Write Supportable Sheet (data already scraped in Step 2)
    if (!driveFolderId) {
      setStep(2, 'skipped', 'Skipped: Drive folder creation failed')
      console.log('[auto-bootstrap] Skipping Supportable sheet — no Drive folder')
    } else if (supportableScrapeResults.length > 0 && supportableScrapeResults.some(r => r.accountNumbers.length > 0)) {
      try {
        setStep(2, 'running', 'writing to Google Sheet…')
        const sheetId = await writeSupportableSheet(supportableScrapeResults, aeName, driveFolderId || undefined)
        const updated = aes.map(a => a.name === aeName ? { ...a, supportableSheetId: sheetId } : a)
        saveAes(updated)
        setStep(2, 'done', `Sheet: ${sheetId}`)
        console.log(`[auto-bootstrap] Supportable sheet created: ${sheetId}`)
      } catch (e: any) {
        setStep(2, 'error', e.message)
        autoBootstrapState.error = `Supportable sheet failed: ${e.message}`
        console.error('[auto-bootstrap] Supportable sheet write failed:', e.message)
      }
    }

    // Step 4 — Create CCSP Sheet
    if (!driveFolderId) {
      setStep(3, 'skipped', 'Skipped: Drive folder creation failed')
      console.log('[auto-bootstrap] Skipping CCSP sheet — no Drive folder')
    } else {
      try {
        setStep(3, 'running')
        const currentAe = aes.find(a => a.name === aeName)!
        const ccspAe = { ...currentAe, tableauTerritories, driveFolderId: driveFolderId || currentAe.driveFolderId } as AE
        const ccspResults = await runCcspScrape([ccspAe])
        const sheetId = await writeCcspSheet(ccspResults, aeName, ccspAe.driveFolderId)
        const updated = aes.map(a => a.name === aeName ? { ...a, ccspSheetId: sheetId } : a)
        saveAes(updated)
        setStep(3, 'done', `Sheet: ${sheetId}`)
        console.log(`[auto-bootstrap] CCSP sheet created: ${sheetId}`)
      } catch (e: any) {
        setStep(3, 'error', e.message)
        autoBootstrapState.error = `CCSP sheet failed: ${e.message}`
        console.error('[auto-bootstrap] CCSP sheet failed:', e.message)
      }
    }

    // Step 5 — Sync Pipeline Sheet
    if (!driveFolderId) {
      setStep(4, 'skipped', 'Skipped: Drive folder creation failed')
      console.log('[auto-bootstrap] Skipping Pipeline sheet — no Drive folder')
    } else {
      try {
        setStep(4, 'running')
        const pipelineSheetId = await createPipelineSheet(aeName, driveFolderId || aes.find(a => a.name === aeName)?.driveFolderId || '')
        await runSfPipelineSync(sfReportId, RH_PROFILE_DIR, pipelineSheetId)
        const updated = aes.map(a => a.name === aeName ? { ...a, pipelineSheetId } : a)
        saveAes(updated)
        setStep(4, 'done', `Sheet: ${pipelineSheetId}`)
        console.log(`[auto-bootstrap] Pipeline sheet synced: ${pipelineSheetId}`)
      } catch (e: any) {
        setStep(4, 'error', e.message)
        autoBootstrapState.error = `Pipeline sync failed: ${e.message}`
        console.error('[auto-bootstrap] Pipeline sync failed:', e.message)
      }
    }

    autoBootstrapState.running = false
    autoBootstrapState.completedAt = new Date().toISOString()
    clearTimeout(bootstrapTimeoutId)
    console.log(`[auto-bootstrap] All steps complete for ${aeName}`)

    // Signal that bootstrap is done — prompt user to downgrade Drive permissions
    try {
      writeFileSyncRaw(OAUTH_STATE_PATH, JSON.stringify({ pendingDowngrade: true, bootstrapCompletedAt: new Date().toISOString() }, null, 2))
    } catch {}
  })()

  return c.json({ started: true })
})

// ── Tableau login helper ──────────────────────────────────────────────────────

const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumptionSummary'

// GET /api/bootstrap/tableau/session-status — probe Tableau reachability + session validity
// Returns { reachable: boolean, sessionValid: boolean }
// reachable=false → not on VPN or Tableau is down — don't show login prompt
// reachable=true, sessionValid=false → on VPN but needs login — show prompt
// reachable=true, sessionValid=true → already logged in — no action needed
app.get('/api/bootstrap/tableau/session-status', async (c) => {
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ reachable: false, sessionValid: false })
  let page: Awaited<ReturnType<typeof ctx.newPage>> | null = null
  try {
    page = await ctx.newPage()
    await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.waitForTimeout(2_000)
    const url = page.url()
    const onLoginPage = !url.includes('10ay.online.tableau.com') ||
      url.includes('/auth') || url.includes('/login') ||
      !!(await page.$('input[type="password"], #username, [data-testid="login"]').catch(() => null))
    return c.json({ reachable: true, sessionValid: !onLoginPage })
  } catch {
    return c.json({ reachable: false, sessionValid: false })
  } finally {
    await page?.close().catch(() => {})
  }
})

// POST /api/bootstrap/tableau/open-login — opens a Playwright browser page to
// Tableau Cloud so the user can log in via the VNC viewer at localhost:6080
app.post('/api/bootstrap/tableau/open-login', async (c) => {
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No RH session — connect Red Hat Portal first' }, 400)
  try {
    // Navigate the live VNC-visible page so the user can actually see Tableau in the VNC window
    const livePage = getLivePage()
    const page = livePage ?? await ctx.newPage()
    await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    console.log('[tableau] opened Tableau in live VNC page — visible at localhost:6080')
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── Tableau territory discovery ──────────────────────────────────────────────

app.get('/api/bootstrap/tableau/territories', async (c) => {
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No RH session — connect Red Hat Portal first' }, 400)

  let page: Awaited<ReturnType<typeof ctx.newPage>> | null = null
  try {
    page = await ctx.newPage()
    const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumptionSummary'
    await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
      console.warn('[territories] networkidle timed out — continuing anyway')
    })

    // Inline applyFilter helper for territory discovery
    const applyFilterLocal = async (label: string, values: string[]) => {
      const trigger = await page!.$(`[aria-label="${label}"], select[title*="${label}"]`)
      if (!trigger) {
        const byText = await page!.$(`text="${label}"`)
        if (!byText) { console.warn(`[territories] filter "${label}" not found`); return }
        const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
        if (!parent) { console.warn(`[territories] filter "${label}" parent not found`); return }
        await parent.click()
      } else {
        await trigger.click()
      }
      await page!.waitForTimeout(800)

      const allOption = await page!.$('text="(All)"')
      if (allOption) {
        const checkbox = await allOption.$('xpath=preceding-sibling::input[@type="checkbox"] | ancestor::label/input')
        const checked = await checkbox?.isChecked()
        if (checked) await allOption.click()
        await page!.waitForTimeout(300)
      }

      for (const val of values) {
        const opt = await page!.$(`text="${val}"`)
        if (opt) { await opt.click(); await page!.waitForTimeout(300) }
      }

      const applyBtn = await page!.$('button:has-text("Apply"), input[value="Apply"]')
      if (applyBtn) await applyBtn.click()
      await page!.waitForTimeout(1_500)
    }

    // Apply prerequisite filters
    await applyFilterLocal('Super Geo', ['AMERICAS'])
    await applyFilterLocal('Geo', ['NA_COMM'])
    await applyFilterLocal('Region', ['NA_COMM_COMMERCIAL'])
    await applyFilterLocal('Segment', ['Commercial'])

    // Open the Account Territory filter dropdown
    const trigger = await page.$(`[aria-label="Account Territory"], select[title*="Account Territory"]`)
    if (!trigger) {
      const byText = await page.$('text="Account Territory"')
      if (byText) {
        const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
        if (parent) await parent.click()
      }
    } else {
      await trigger.click()
    }
    await page.waitForTimeout(800)

    // Scrape all option text values
    const options = await page.$$eval(
      '[role="option"], [role="listbox"] label, .FICheckRadio label, [class*="filter"] label',
      (els: Element[]) => els.map(el => el.textContent?.trim() ?? '').filter(t => t && t !== '(All)')
    )

    // Dedupe and sort
    const territories = [...new Set(options)].sort()

    return c.json({ territories })
  } catch (e: any) {
    console.error('[territories] Discovery failed:', e.message)
    return c.json({ error: `Territory discovery failed: ${e.message}` }, 500)
  } finally {
    if (page) await page.close().catch(() => {})
  }
})

// GET /api/data-sources/status — List connected AE folders
app.get('/api/data-sources/status', (c) => {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    // Migrate old single-folder format
    const folders = ds.aeFolders ?? (ds.aeFolderID ? [{ folderId: ds.aeFolderID, folderName: ds.folderName ?? null, connectedAt: ds.connectedAt ?? null }] : [])
    return c.json({ folders })
  } catch {
    return c.json({ folders: [] })
  }
})

// POST /api/data-sources/check-files — Check each connected AE folder for required files
// Returns per-folder presence of [AE Name] Supportable, CCSP, and Pipeline files.
app.post('/api/data-sources/check-files', async (c) => {
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
  if (!parentIds.length) return c.json({ error: 'No AE folders connected.' }, 400)

  try {
    const auth  = makeAuth(GDRIVE_TOKEN_PATH_SRV)
    const drive = google.drive({ version: 'v3', auth })

    const results: {
      aeName: string
      folderId: string
      supportable: { found: boolean; fileName?: string }
      ccsp:        { found: boolean; fileName?: string }
      pipeline:    { found: boolean; fileName?: string }
    }[] = []

    for (const parentId of parentIds) {
      // Get the connected folder's own name so we can check direct children first
      const selfMeta = await drive.files.get({ fileId: parentId, fields: 'id,name' }).catch(() => ({ data: { name: '' } }))
      const selfName = ((selfMeta.data as any).name ?? '').trim()
      const selfNameLower = selfName.toLowerCase()

      // Check direct spreadsheet children (native sheets + shortcuts to sheets)
      const [selfSheetsRes, selfShortcutsRes] = await Promise.all([
        drive.files.list({
          q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
          fields: 'files(id,name)', pageSize: 50,
        }).catch(() => ({ data: { files: [] as any[] } })),
        drive.files.list({
          q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
          fields: 'files(id,name,shortcutDetails)', pageSize: 50,
        }).catch(() => ({ data: { files: [] as any[] } })),
      ])

      const selfFiles: { name: string }[] = [
        ...((selfSheetsRes.data as any).files ?? []),
        ...((selfShortcutsRes.data as any).files ?? []).filter((f: any) =>
          (f.shortcutDetails?.targetMimeType ?? '').includes('spreadsheet')
        ),
      ]
      const selfNameOf = (suffix: string) =>
        selfFiles.find(f => f.name.toLowerCase().startsWith(selfNameLower) && f.name.toLowerCase().includes(suffix.toLowerCase()))

      // If the connected folder itself contains the required files, treat it as the AE folder
      if (selfFiles.some(f => f.name.toLowerCase().startsWith(selfNameLower))) {
        const supportableFile = selfNameOf('supportable')
        const ccspFile        = selfNameOf('ccsp')
        const pipelineFile    = selfNameOf('pipeline')
        results.push({
          aeName: selfName,
          folderId: parentId,
          supportable: { found: !!supportableFile, fileName: supportableFile?.name },
          ccsp:        { found: !!ccspFile,        fileName: ccspFile?.name },
          pipeline:    { found: !!pipelineFile,    fileName: pipelineFile?.name },
        })
        continue
      }

      // Otherwise scan subfolders (for a root folder containing multiple AE folders)
      const foldersRes = await drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 50,
      }).catch(() => ({ data: { files: [] as any[] } }))

      for (const aeFolder of ((foldersRes.data as any).files ?? [])) {
        if (!aeFolder.id) continue
        const aeName = (aeFolder.name ?? '').trim()
        const aeNameLower = aeName.toLowerCase()

        const [sheetsRes, shortcutsRes] = await Promise.all([
          drive.files.list({
            q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
            fields: 'files(id,name)', pageSize: 50,
          }).catch(() => ({ data: { files: [] as any[] } })),
          drive.files.list({
            q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
            fields: 'files(id,name,shortcutDetails)', pageSize: 50,
          }).catch(() => ({ data: { files: [] as any[] } })),
        ])

        const files: { name: string }[] = [
          ...((sheetsRes.data as any).files ?? []),
          ...((shortcutsRes.data as any).files ?? []).filter((f: any) =>
            (f.shortcutDetails?.targetMimeType ?? '').includes('spreadsheet')
          ),
        ]
        const nameOf = (suffix: string) =>
          files.find(f => f.name.toLowerCase().startsWith(aeNameLower) && f.name.toLowerCase().includes(suffix.toLowerCase()))

        const supportableFile = nameOf('supportable')
        const ccspFile        = nameOf('ccsp')
        const pipelineFile    = nameOf('pipeline')

        results.push({
          aeName,
          folderId: aeFolder.id,
          supportable: { found: !!supportableFile, fileName: supportableFile?.name },
          ccsp:        { found: !!ccspFile,        fileName: ccspFile?.name },
          pipeline:    { found: !!pipelineFile,    fileName: pipelineFile?.name },
        })
      }
    }

    return c.json({ results })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'File check failed' }, 500)
  }
})

// POST /api/data-sources/add-folder — Connect an AE Drive folder
app.post('/api/data-sources/add-folder', async (c) => {
  const { folderUrl } = await c.req.json<{ folderUrl: string }>()
  if (!folderUrl) return c.json({ error: 'folderUrl required' }, 400)

  const m = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)
  const folderId = m ? m[1] : folderUrl.trim()
  if (!folderId) return c.json({ error: 'Could not extract folder ID from URL' }, 400)

  try {
    const auth = makeAuth(GDRIVE_TOKEN_PATH_SRV)
    const drive = google.drive({ version: 'v3', auth })
    const meta = await drive.files.get({ fileId: folderId, fields: 'name' })
    const folderName = meta.data.name ?? ''

    const [foldersRes, sheetsRes] = await Promise.all([
      drive.files.list({ q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: 'files(id)', pageSize: 50 }),
      drive.files.list({ q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`, fields: 'files(id)', pageSize: 50 }),
    ])

    // Load + migrate existing config
    let existing: { aeFolders: { folderId: string; folderName: string; connectedAt: string }[] } = { aeFolders: [] }
    try {
      const raw = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
      existing.aeFolders = raw.aeFolders ?? (raw.aeFolderID ? [{ folderId: raw.aeFolderID, folderName: raw.folderName ?? '', connectedAt: raw.connectedAt ?? '' }] : [])
    } catch {}

    const connectedAt = new Date().toISOString()
    existing.aeFolders = existing.aeFolders.filter(f => f.folderId !== folderId)
    existing.aeFolders.push({ folderId, folderName, connectedAt })

    writeFileSyncRaw(DATA_SOURCES_PATH, JSON.stringify(existing, null, 2))

    const allIds = existing.aeFolders.map(f => f.folderId)
    process.env.AE_PARENT_FOLDER_IDS = allIds.join(',')
    process.env.AE_PARENT_FOLDER_ID = allIds[0]

    return c.json({ ok: true, folderId, folderName, subfolderCount: (foldersRes.data.files ?? []).length, spreadsheetCount: (sheetsRes.data.files ?? []).length, connectedAt, totalFolders: existing.aeFolders.length })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Failed to connect folder' }, 500)
  }
})

// DELETE /api/data-sources/remove-folder — Remove a connected AE folder
app.delete('/api/data-sources/remove-folder', async (c) => {
  const { folderId } = await c.req.json<{ folderId: string }>()
  if (!folderId) return c.json({ error: 'folderId required' }, 400)

  let existing: { aeFolders: { folderId: string; folderName: string; connectedAt: string }[] } = { aeFolders: [] }
  try {
    const raw = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    existing.aeFolders = raw.aeFolders ?? []
  } catch {}

  existing.aeFolders = existing.aeFolders.filter(f => f.folderId !== folderId)
  writeFileSyncRaw(DATA_SOURCES_PATH, JSON.stringify(existing, null, 2))

  const allIds = existing.aeFolders.map(f => f.folderId)
  process.env.AE_PARENT_FOLDER_IDS = allIds.join(',')
  process.env.AE_PARENT_FOLDER_ID = allIds[0] ?? ''

  return c.json({ ok: true, remaining: existing.aeFolders.length })
})

// ── Dashboard API endpoints ──────────────────────────────────────────────────

// GET /api/config — Dashboard configuration and provider status
// ── Territory live lookup ──────────────────────────────────────────────────────
// GET /api/territory-lookup?territory=WEST_COMM_CORP_NORTHWEST_TERR01
// Reads the territory Google Sheet live and returns { aeName, accounts } for
// the requested territory. Does not require aes.json to be populated.

const TERRITORY_SHEET_ID = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'

function normalizeTerritoryCustomerName(raw: string): string {
  let name = raw.trim()
  if (!name) return ''
  name = name.replace(/\s*-\s*[A-Z]{2}(\/[A-Z]{2})?$/, '')
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i, /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,     /,?\s+INC\.?$/i, /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,       /,?\s+CORP\.?$/i, /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

function podPrefixFromTabTitle(tabTitle: string): string {
  const t = tabTitle.toLowerCase()
  if (t.includes('northwest') || t.includes('nw')) return 'WEST_COMM_CORP_NORTHWEST'
  if (t.includes('southwest') || t.includes('sw')) return 'WEST_COMM_CORP_SOUTHWEST'
  if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTHCENTRAL'
  if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTHCENTRAL'
  return ''
}

// GET /api/territory-names?pod=WEST_COMM_CORP_NORTHWEST
// Returns all territories for a POD with AE names — used to populate the territory dropdown.
app.get('/api/territory-names', async (c) => {
  const pod = c.req.query('pod')?.trim()
  if (!pod) return c.json({ error: 'pod query param required' }, 400)

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) return c.json({ error: 'Google auth not configured' }, 401)

  try {
    const sheetsClient = google.sheets({ version: 'v4', auth })
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: TERRITORY_SHEET_ID })
    const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
    const corpTabs = tabNames.filter(t => {
      const lower = t.toLowerCase()
      return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
             !lower.includes('accounts a')
    })

    const territories: { num: string; aeName: string }[] = []

    for (const tabTitle of corpTabs) {
      const podPrefix = podPrefixFromTabTitle(tabTitle)
      if (podPrefix !== pod) continue

      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: TERRITORY_SHEET_ID,
        range: `'${tabTitle}'!A1:Z60`,
      })
      const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
        r.map((c: any) => String(c ?? '').trim())
      )

      let headerRowIdx = -1
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].some(cell => cell === 'Account Executive')) { headerRowIdx = r; break }
      }
      if (headerRowIdx === -1) continue

      const aeNameRowIdx = headerRowIdx + 1
      const headerRow = rows[headerRowIdx] ?? []
      const aeNameRow = rows[aeNameRowIdx] ?? []
      const aeCols = headerRow.map((cell, idx) => ({ cell, idx }))
        .filter(({ cell }) => cell === 'Account Executive').map(({ idx }) => idx)

      for (const col of aeCols) {
        const aeCell = aeNameRow[col] ?? ''
        if (!aeCell) continue
        let aeName = aeCell; let terrCode = ''
        if (aeCell.includes('\n')) {
          const parts = aeCell.split('\n'); aeName = parts[0].trim(); terrCode = parts[1].trim()
        } else {
          const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
          if (terrMatch) { aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim(); terrCode = terrMatch[0] }
        }
        if (!aeName || /^TBH$/i.test(aeName.trim())) continue
        const terrNumMatch = terrCode.match(/(\d+)/)
        if (!terrNumMatch) continue
        const num = terrNumMatch[1].padStart(2, '0')
        territories.push({ num, aeName })
      }
      break  // Found the matching tab, no need to check others
    }

    territories.sort((a, b) => a.num.localeCompare(b.num))
    console.log(`[territory-names] ${pod}: ${territories.length} territories`)
    return c.json({ territories })
  } catch (e: any) {
    console.error('[territory-names] error:', e.message)
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/territory-lookup', async (c) => {
  const requestedTerritory = c.req.query('territory')?.trim()
  if (!requestedTerritory) return c.json({ error: 'territory query param required' }, 400)

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) return c.json({ error: 'Google auth not configured' }, 401)

  try {
    const sheetsClient = google.sheets({ version: 'v4', auth })

    // Get all tab names
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: TERRITORY_SHEET_ID })
    const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
    const corpTabs = tabNames.filter(t => {
      const lower = t.toLowerCase()
      return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
             !lower.includes('accounts a')
    })

    for (const tabTitle of corpTabs) {
      const podPrefix = podPrefixFromTabTitle(tabTitle)
      if (!podPrefix) continue
      // Quick skip: if requested territory doesn't start with this pod prefix, skip tab
      if (!requestedTerritory.startsWith(podPrefix)) continue

      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: TERRITORY_SHEET_ID,
        range: `'${tabTitle}'!A1:Z60`,
      })
      const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
        r.map((c: any) => String(c ?? '').trim())
      )

      // Find "Account Executive" header row
      let headerRowIdx = -1
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].some(cell => cell === 'Account Executive')) { headerRowIdx = r; break }
      }
      if (headerRowIdx === -1) continue

      const aeNameRowIdx = headerRowIdx + 1
      const accountsStartIdx = aeNameRowIdx + 1
      const headerRow = rows[headerRowIdx] ?? []
      const aeNameRow = rows[aeNameRowIdx] ?? []

      const aeCols = headerRow
        .map((cell, idx) => ({ cell, idx }))
        .filter(({ cell }) => cell === 'Account Executive')
        .map(({ idx }) => idx)

      for (const col of aeCols) {
        const aeCell = aeNameRow[col] ?? ''
        if (!aeCell) continue

        let aeName = aeCell
        let terrCode = ''
        if (aeCell.includes('\n')) {
          const parts = aeCell.split('\n')
          aeName = parts[0].trim()
          terrCode = parts[1].trim()
        } else {
          const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
          if (terrMatch) {
            aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim()
            terrCode = terrMatch[0]
          }
        }

        if (!aeName || /^TBH$/i.test(aeName.trim())) continue

        const terrNumMatch = terrCode.match(/(\d+)/)
        if (!terrNumMatch) continue
        const terrNum = terrNumMatch[1].padStart(2, '0')
        const tableauTerritory = `${podPrefix}_TERR${terrNum}`

        if (tableauTerritory !== requestedTerritory) continue

        // Found the matching AE — extract accounts
        const accounts: string[] = []
        for (let r = accountsStartIdx; r < rows.length; r++) {
          const cell = rows[r][col] ?? ''
          if (!cell) continue
          if (/^\d{1,3}$/.test(cell)) break
          if (/^Account\s+S[Aa]/i.test(cell)) break
          if (/^(Support|Partner Sales|\d+ of \d+)$/i.test(cell)) break
          if (/^(Openshift|Ansible|Rhel|Ai)\s+(SSP|SSA)/i.test(cell)) break
          const normalized = normalizeTerritoryCustomerName(cell)
          if (normalized) accounts.push(normalized)
        }

        console.log(`[territory-lookup] ${requestedTerritory}: ${aeName}, ${accounts.length} accounts`)
        return c.json({ aeName, accounts, tableauTerritory })
      }
    }

    return c.json({ error: `Territory ${requestedTerritory} not found in sheet` }, 404)
  } catch (e: any) {
    console.error('[territory-lookup] error:', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── AE Config API ─────────────────────────────────────────────────────────────

app.get('/api/aes', (c) => c.json({ aes }))

app.post('/api/aes', async (c) => {
  try {
    const body = await c.req.json() as { aes: AE[] }
    if (!Array.isArray(body.aes)) return c.json({ error: 'aes must be an array' }, 400)
    if (body.aes.length > 50) return c.json({ error: 'aes array exceeds maximum of 50 entries' }, 400)

    // Validate each AE entry
    for (let i = 0; i < body.aes.length; i++) {
      const ae = body.aes[i]
      const name = sanitizeText(ae.name)
      if (!name) return c.json({ error: `aes[${i}].name is invalid or contains disallowed characters` }, 400)
      if (ae.sfReportId && !isValidSfId(ae.sfReportId)) return c.json({ error: `aes[${i}].sfReportId must be 15-18 alphanumeric characters` }, 400)
      if (Array.isArray(ae.tableauTerritories)) {
        for (const t of ae.tableauTerritories) {
          if (typeof t !== 'string' || t.length > 100) return c.json({ error: `aes[${i}].tableauTerritories entry exceeds 100 characters` }, 400)
        }
      }
      // Write sanitized name back
      body.aes[i] = { ...ae, name }
    }

    saveAes(body.aes)
    // Rebuild flat customer list with denormalized ae names
    try {
      const raw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
      customers = raw.customers ?? []
    } catch {}
    return c.json({ ok: true, count: aes.length })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/aes/validate-folder', async (c) => {
  try {
    const { folderUrl } = await c.req.json() as { folderUrl: string }
    const match = folderUrl?.match(/\/folders\/([\w-]+)/)
    if (!match) return c.json({ error: 'Could not extract folder ID from URL' }, 400)
    const folderId = match[1]
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const res = await drive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: 'id,name,mimeType',
    })
    if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
      return c.json({ error: 'URL does not point to a folder' }, 400)
    }
    return c.json({ folderId, folderName: res.data.name ?? folderId })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

app.get('/api/config', (c) => {
  return c.json({
    briefProvider: getBriefProvider(),
    briefConfigured: isBriefConfigured(),
  })
})

app.get('/api/config/test', async (c) => {
  if (!isBriefConfigured()) {
    return c.json({ ok: false, error: `LLM_PROVIDER=${getBriefProvider()} is not configured. Check your .env file.` })
  }
  try {
    const result = await generateBrief(
      { name: 'Test Account', ae: 'Test', domain: '', accountNumbers: [], segment: '', region: '' } as any,
      [], [], [], [], [], []
    )
    return c.json({ ok: true, provider: getBriefProvider(), preview: result.slice(0, 120) })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message })
  }
})

// GET /api/accounts — All customers with cached sheet data merged
app.get('/api/accounts', (c) => {
  const result = customers.map((customer) => {
    const cached = readSheetCache(customer.name)
    const products = cached?.rows ?? []
    const distinctProducts = new Set(products.map((p) => p.productDescription)).size
    const totalLicenses = products.reduce((sum, p) => sum + p.quantity, 0)

    return {
      name: customer.name,
      domain: customer.domain ?? '',
      accountNumbers: customer.accountNumbers ?? [],
      ae: customer.ae ?? '',
      segment: customer.segment ?? '',
      products,
      productCount: distinctProducts,
      totalLicenses,
      cachedAt: cached?.cachedAt ?? null,
    }
  })
  return c.json({ customers: result })
})

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
  return c.json({ exists: existsSync(GOOGLE_OAUTH_KEYS_PATH) })
})

// POST /api/setup/upload-oauth-keys — Save uploaded GCP OAuth keys JSON
app.post('/api/setup/upload-oauth-keys', async (c) => {
  try {
    const body = await c.req.json()
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON' }, 400)
    const { client_id, client_secret } = (body.installed ?? body.web ?? {})
    if (!client_id || !client_secret) return c.json({ error: 'Missing client_id or client_secret' }, 400)
    const dir = resolve(GOOGLE_OAUTH_KEYS_PATH, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSyncRaw(GOOGLE_OAUTH_KEYS_PATH, JSON.stringify(body, null, 2))
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/setup/reset — Clear all config and cache for a clean setup
// ?full=true also removes the OAuth keys file (simulate brand new user)
app.post('/api/setup/reset', (c) => {
  const full = c.req.query('full') === 'true'
  const deleted: string[] = []
  const tryDelete = (p: string) => { try { if (existsSync(p)) { unlinkSync(p); deleted.push(p) } } catch {} }

  // Config files
  tryDelete(CUSTOMERS_PATH)
  tryDelete(SHEETS_SYNC_PATH)
  tryDelete(DATA_SOURCES_PATH)
  tryDelete(GOOGLE_UNIFIED_TOKEN_PATH)
  if (full) tryDelete(GOOGLE_OAUTH_KEYS_PATH)

  // All cache files
  try {
    readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).forEach(f => tryDelete(resolve(CACHE_DIR, f)))
  } catch {}

  // Reset in-memory state
  customers.splice(0, customers.length)
  oauthState = ''
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
            error: e.message,
          }))
        )
      )
      results.push(...batchResults)
    }
    return c.json({ results })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/setup/save-domains — persist inferred/edited domains to customers.json
app.post('/api/setup/save-domains', async (c) => {
  const body = await c.req.json<{ domains: { name: string; domain: string }[] }>()
  if (!body.domains?.length) return c.json({ error: 'No domains provided' }, 400)

  const domainMap = new Map(body.domains.map((d) => [d.name, d.domain]))
  const updated = customers.map((cu) => {
    const inferred = domainMap.get(cu.name)
    if (inferred !== undefined) return { ...cu, domain: inferred }
    return cu
  })

  try {
    writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2))
    renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
    customers.splice(0, customers.length, ...updated)
    return c.json({ ok: true, updated: body.domains.length })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/setup/save-customers — replace entire customer list from Setup UI
app.post('/api/setup/save-customers', async (c) => {
  try {
    const body = await c.req.json<{ customers: Customer[] }>()
    if (!Array.isArray(body.customers)) return c.json({ error: 'customers must be an array' }, 400)
    if (body.customers.length > 200) return c.json({ error: 'customers array exceeds maximum of 200 entries' }, 400)

    // Validate each customer
    for (let i = 0; i < body.customers.length; i++) {
      const cx = body.customers[i]
      const name = sanitizeText(cx.name)
      if (!name) return c.json({ error: `customers[${i}].name is invalid or contains disallowed characters` }, 400)
      if (cx.domain !== undefined && !isValidDomain(cx.domain)) return c.json({ error: `customers[${i}].domain is not a valid domain` }, 400)
      body.customers[i] = { ...cx, name }
    }

    writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: body.customers }, null, 2))
    renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
    customers.splice(0, customers.length, ...body.customers)
    return c.json({ ok: true, count: body.customers.length })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// GET /api/cases/all — Support cases across ALL accounts
// ?includeAll=true returns closed/resolved cases too (default: open only)
// ?account=NNNN filters to a specific account number
app.get('/api/cases/all', async (c) => {
  try {
    const includeAll = c.req.query('includeAll') === 'true'
    const accountFilter = c.req.query('account')

    let allCases = await fetchCases({ includeAll }).catch(() => [])

    if (accountFilter) {
      allCases = allCases.filter((sc) => String(sc.accountNumber) === accountFilter)
    }

    // Enrich with customer name by matching accountNumber
    const enriched = allCases.map((sc) => {
      const matched = customers.find((cu) =>
        (cu.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
      )
      return { ...sc, customerName: matched?.name ?? 'Unknown' }
    })

    return c.json({ cases: enriched, totalCount: enriched.length })
  } catch (e: any) {
    return c.json({ cases: [], totalCount: 0, error: e.message }, 500)
  }
})

// GET /api/cases/:caseNumber/latest-comment — most recent comment for a case
app.get('/api/cases/:caseNumber/latest-comment', async (c) => {
  const caseNumber = c.req.param('caseNumber')
  const comment = await fetchCaseLatestComment(caseNumber).catch(() => null)
  return c.json({ comment })
})

// ── Brief helpers ────────────────────────────────────────────────────────────
function extractBriefSummary(text: string): { overview: string; talkingPoints: string[]; openCasesNote: string } {
  // Account Overview section
  const overviewMatch = text.match(/## Account Overview\n([\s\S]*?)(?=\n##)/)
  const overview = overviewMatch ? overviewMatch[1].trim().slice(0, 400) : ''

  // Talking Points bullets — header varies e.g. "## Talking Points & Prep (Mar 24 ...)"
  const talkingMatch = text.match(/## Talking Points[^\n]*\n([\s\S]*?)(?=\n##|$)/)
  const talkingPoints = talkingMatch
    ? talkingMatch[1].split('\n').filter((l) => /^[-*]|\d+\./.test(l.trim())).map((l) => l.replace(/^[-*\d.]+\s*\*{0,2}/, '').replace(/\*{0,2}$/, '').trim().slice(0, 120)).filter(Boolean).slice(0, 4)
    : []

  // Open cases note
  const casesMatch = text.match(/## Open Support Cases\n([\s\S]*?)(?=\n##)/)
  const openCasesNote = casesMatch ? casesMatch[1].trim().slice(0, 200) : ''

  return { overview, talkingPoints, openCasesNote }
}

function readLatestBriefCache(customerName: string): { text: string; cachedAt: string; date: string } | null {
  try {
    const slug = toSlug(customerName)
    const files = readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith(slug + '-') && !f.endsWith('-sheets.json') && f.endsWith('.json'))
      .sort()
      .reverse()
    if (!files.length) return null
    const data = JSON.parse(readFileSync(resolve(CACHE_DIR, files[0]), 'utf-8'))
    const date = files[0].replace(`${slug}-`, '').replace('.json', '')
    return { ...data, date }
  } catch {
    return null
  }
}

// GET /api/briefs — Brief summaries for all customers (from cache)
app.get('/api/briefs', (c) => {
  const result: Record<string, { overview: string; talkingPoints: string[]; openCasesNote: string; cachedAt: string; date: string }> = {}
  for (const customer of customers) {
    const cached = readLatestBriefCache(customer.name)
    if (cached?.text) {
      result[customer.name] = { ...extractBriefSummary(cached.text), cachedAt: cached.cachedAt, date: cached.date }
    }
  }
  return c.json(result)
})

// ── CCSP Cloud Spend cache ────────────────────────────────────────────────────
const CCSP_CACHE_PATH = `${CACHE_DIR}/ccsp-data.json`

function readCCSPCache(): { records: CCSPRecord[]; cachedAt: string; fileIds?: string[] } | null {
  try {
    return JSON.parse(readFileSync(CCSP_CACHE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function writeCCSPCache(records: CCSPRecord[], fileIds: string[] = []): void {
  try {
    writeFileSync(CCSP_CACHE_PATH, JSON.stringify({ records, cachedAt: new Date().toISOString(), fileIds }))
  } catch {}
}

// GET /api/ccsp — Cloud spend data aggregated from CCSP Raw Data tabs
app.get('/api/ccsp', async (c) => {
  const force = c.req.query('force') === 'true'
  const cached = readCCSPCache()
  // Use cache if available and not forced (data doesn't change hourly)
  if (cached && !force) {
    return c.json(buildCCSPSummary(cached.records, cached.cachedAt))
  }
  try {
    const { records, fileIds } = await fetchCCSPData()
    writeCCSPCache(records, fileIds)
    return c.json(buildCCSPSummary(records, new Date().toISOString()))
  } catch (e: any) {
    if (cached) return c.json(buildCCSPSummary(cached.records, cached.cachedAt))
    return c.json({ error: e.message, byCustomer: [], byQuarter: [], byPartner: [], totalAcv: 0, cachedAt: null }, 500)
  }
})

function buildCCSPSummary(records: CCSPRecord[], cachedAt: string) {
  const byCustomer    = new Map<string, number>()
  const byQuarter     = new Map<string, number>()
  const byPartner     = new Map<string, number>()
  const custPartner   = new Map<string, Map<string, number>>()
  let totalAcv = 0

  for (const r of records) {
    byCustomer.set(r.accountName, (byCustomer.get(r.accountName) ?? 0) + r.acvPlus)
    if (r.quarter) byQuarter.set(r.quarter, (byQuarter.get(r.quarter) ?? 0) + r.acvPlus)
    byPartner.set(r.cloudPartner, (byPartner.get(r.cloudPartner) ?? 0) + r.acvPlus)
    totalAcv += r.acvPlus
    // Per-account partner breakdown
    if (!custPartner.has(r.accountName)) custPartner.set(r.accountName, new Map())
    const pm = custPartner.get(r.accountName)!
    pm.set(r.cloudPartner, (pm.get(r.cloudPartner) ?? 0) + r.acvPlus)
  }

  const sortedCustomers = [...byCustomer.entries()].sort((a, b) => b[1] - a[1])

  return {
    totalAcv,
    cachedAt,
    byCustomer: sortedCustomers.map(([name, acv]) => ({
      name,
      acv,
      partners: [...(custPartner.get(name)?.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .map(([partner, acv]) => ({ partner, acv })),
    })),
    byQuarter: [...byQuarter.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([quarter, acv]) => ({ quarter, acv })),
    byPartner: [...byPartner.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([partner, acv]) => ({ partner, acv })),
  }
}

// GET /customer/:name/ccsp — CCSP cloud spend for a single customer (from cache)
app.get('/customer/:name/ccsp', (c) => {
  const rawName = decodeURIComponent(c.req.param('name')).toLowerCase()
  const cached = readCCSPCache()
  if (!cached) return c.json({ totalAcv: 0, byQuarter: [], byPartner: [] })

  // Fuzzy match: strip legal suffixes, check substring overlap
  function normalize(s: string) {
    return s.toLowerCase()
      .replace(/,?\s*(inc\.|llc|inc|corp|ltd|lp|co\.|u\.s\..*|life and safety.*|life & safety.*|digital media.*)$/i, '')
      .replace(/[,\.]/g, '').trim()
  }
  const needle = normalize(rawName)

  const byQuarter  = new Map<string, number>()
  const byPartner  = new Map<string, number>()
  let totalAcv = 0

  for (const r of cached.records) {
    const hay = normalize(r.accountName)
    if (!hay.includes(needle) && !needle.includes(hay)) continue
    totalAcv += r.acvPlus
    if (r.quarter) byQuarter.set(r.quarter, (byQuarter.get(r.quarter) ?? 0) + r.acvPlus)
    byPartner.set(r.cloudPartner, (byPartner.get(r.cloudPartner) ?? 0) + r.acvPlus)
  }

  return c.json({
    totalAcv,
    cachedAt: cached.cachedAt,
    byQuarter: [...byQuarter.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([quarter, acv]) => ({ quarter, acv })),
    byPartner: [...byPartner.entries()].sort((a, b) => b[1] - a[1]).map(([partner, acv]) => ({ partner, acv })),
  })
})

// ── Pipeline cache ────────────────────────────────────────────────────────────
const PIPELINE_CACHE_PATH = `${CACHE_DIR}/pipeline-data.json`

function readPipelineCache(): { records: PipelineRecord[]; cachedAt: string; fileIds?: string[] } | null {
  try {
    return JSON.parse(readFileSync(PIPELINE_CACHE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function writePipelineCache(records: PipelineRecord[], fileIds: string[] = []): void {
  try {
    writeFileSync(PIPELINE_CACHE_PATH, JSON.stringify({ records, cachedAt: new Date().toISOString(), fileIds }))
  } catch {}
}

// GET /api/pipeline — Open opportunity pipeline from Drive XLS
const aeNames = [...new Set(customers.map(c => c.ae).filter(Boolean))] as string[]

function filterToAEs(records: PipelineRecord[]): PipelineRecord[] {
  if (!aeNames.length) return records
  return records.filter(r => aeNames.some(ae => ae.toLowerCase() === r.owner.toLowerCase()))
}

app.get('/api/pipeline', async (c) => {
  const force = c.req.query('force') === 'true'
  const cached = readPipelineCache()
  // Serve from cache if available and not forced — no env var needed for cache hits
  if (cached && !force) {
    return c.json(buildPipelineSummary(filterToAEs(cached.records), cached.cachedAt))
  }
  if (!process.env.PIPELINE_FILE_ID) {
    return c.json({ totalAcv: 0, openCount: 0, renewalAcv: 0, newAcv: 0, byStage: [], byOwner: [], topOpps: [], cachedAt: null })
  }
  try {
    const { records, fileIds } = await fetchPipelineData()
    writePipelineCache(records, fileIds)
    return c.json(buildPipelineSummary(filterToAEs(records), new Date().toISOString()))
  } catch (e: any) {
    if (cached) return c.json(buildPipelineSummary(filterToAEs(cached.records), cached.cachedAt))
    return c.json({ error: e.message, totalAcv: 0, openCount: 0, renewalAcv: 0, newAcv: 0, byStage: [], byOwner: [], topOpps: [], cachedAt: null }, 500)
  }
})

// GET /api/calendar — Calendar events with range filter; ?all=true returns every event
app.get('/api/calendar', async (c) => {
  const range = (c.req.query('range') ?? 'week') as 'today' | 'week'
  const includeAll = c.req.query('all') === 'true'
  try {
    const events = await fetchCalendar(customers, includeAll)
    return c.json({ events, range })
  } catch (e: any) {
    return c.json({ events: [], range, error: e.message }, 500)
  }
})

// GET /api/kpis — Aggregated KPIs for the dashboard
app.get('/api/kpis', async (c) => {
  try {
    // Fetch cases and calendar in parallel
    const [allCases, calendarEvents] = await Promise.all([
      fetchCases().catch(() => []),
      fetchCalendar(customers).catch(() => []),
    ])

    const sev1Count = allCases.filter((ca) => ca.severity === '1').length

    // Count meetings
    const today = new Date().toDateString()
    const now = new Date()
    const dayOfWeek = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
    monday.setHours(0, 0, 0, 0)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 7)

    const meetingsToday = calendarEvents.filter(
      (ev) => new Date(ev.start).toDateString() === today
    ).length
    const meetingsThisWeek = calendarEvents.filter((ev) => {
      const d = new Date(ev.start)
      return d >= monday && d < sunday
    }).length

    // Aggregate products from cached sheet data
    const allProductDescriptions = new Set<string>()
    let totalLicenses = 0
    let renewalsWithin90Days = 0
    const nowMs = Date.now()
    for (const customer of customers) {
      const cached = readSheetCache(customer.name)
      if (cached) {
        for (const p of cached.rows) {
          allProductDescriptions.add(p.productDescription)
          totalLicenses += p.quantity
          if (p.endDate) {
            const daysLeft = Math.ceil((new Date(p.endDate).getTime() - nowMs) / 86_400_000)
            if (daysLeft <= 90) renewalsWithin90Days++
          }
        }
      }
    }

    return c.json({
      openCasesTotal: allCases.length,
      sev1Count,
      meetingsToday,
      meetingsThisWeek,
      renewalsWithin90Days,
      totalAccounts: customers.length,
      totalProducts: allProductDescriptions.size,
      totalLicenses,
    })
  } catch (e: any) {
    return c.json({
      openCasesTotal: 0,
      sev1Count: 0,
      meetingsToday: 0,
      meetingsThisWeek: 0,
      renewalsWithin90Days: 0,
      totalAccounts: customers.length,
      totalProducts: 0,
      totalLicenses: 0,
    }, 500)
  }
})

// ── Serve React dashboard SPA ────────────────────────────────────────────────
const DASHBOARD_DIST = resolve(import.meta.dir, 'dashboard/dist')

// Serve static assets from dashboard build
app.get('/dashboard', async (c) => {
  const indexPath = resolve(DASHBOARD_DIST, 'index.html')
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), {
      headers: { 'Content-Type': 'text/html' },
    })
  }
  return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
})

app.get('/dashboard/*', async (c) => {
  let path = c.req.path.replace('/dashboard', '')
  if (!path || path === '/') path = '/index.html'
  const filePath = resolve(DASHBOARD_DIST, path.startsWith('/') ? path.slice(1) : path)

  // Try to serve the file, fall back to index.html for SPA routing
  try {
    if (existsSync(filePath) && !filePath.endsWith('/') && Bun.file(filePath).size > 0) {
      const file = Bun.file(filePath)
      const ext = filePath.split('.').pop() ?? ''
      const mimeTypes: Record<string, string> = {
        html: 'text/html',
        js: 'application/javascript',
        css: 'text/css',
        json: 'application/json',
        svg: 'image/svg+xml',
        png: 'image/png',
        ico: 'image/x-icon',
      }
      return new Response(file, {
        headers: { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' },
      })
    }
    // SPA fallback — serve index.html for any unmatched path under /dashboard
    const indexPath = resolve(DASHBOARD_DIST, 'index.html')
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { 'Content-Type': 'text/html' },
      })
    }
    return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
  } catch {
    return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
  }
})

// ── Account discovery helpers ─────────────────────────────────────────────────

// Tab names that are structural (not customer names) in territory spreadsheets
const SKIP_TABS = new Set([
  'account list', 'supportable logins', 'account grouping', 'accounts',
  'summary', 'dashboard', 'instructions', 'readme', 'notes', 'overview',
  'template', 'totals', 'totals by ae', 'pivot', 'raw data', 'all accounts',
  'login', 'logins', 'data', 'index',
  // Pricing/model/lookup tabs common in Red Hat sales spreadsheets
  'deal details', 'initiatives', 'policies', 'synopsis', 'affiliates',
  'annual sub counts', 'bom', 'business justification', 'cloud spend',
  'monthlymodel', 'yearlymodel', 'tabindex', 'tableau', 'rde', 'support',
  'upgrademodel', 'raw data table',
])

function isCustomerTab(tab: string): boolean {
  const lower = tab.toLowerCase().trim()
  if (lower.length < 3) return false
  if (lower.includes('ccsp')) return false
  if (SKIP_TABS.has(lower)) return false
  // Generic sheet names
  if (/^sheet\d+$/i.test(tab)) return false
  // Month patterns: M1-M12
  if (/^m\d{1,2}$/i.test(tab)) return false
  // Internal code-prefixed tabs: DS_, DV_, CSV_, DD_, OVE_, CD_, etc.
  if (/^[a-z]{1,4}_/i.test(tab)) return false
  // Summary/model/data tabs ending in common suffixes
  if (/\b(model|summary|geo|revenue|tax|partner|count|report|raw)\b/i.test(tab)) return false
  return true
}

type DiscoveredAccount = { name: string; ae: string; segment?: string; aliases?: string[]; supportableFileId?: string }

// Normalize a name for dedup: lowercase, strip legal suffixes + punctuation, collapse spaces.
// "A10 Networks, Inc." and "A10 NETWORKS" both become "a10 networks".
function normalizeForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|corp|ltd|co|corporation|incorporated|limited|company|lp|llp|plc)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Returns true if two normalized names likely refer to the same company.
// Uses word-level prefix overlap: "fred hutch" matches "fred hutchinson cancer center"
// because "hutch" is a prefix of "hutchinson". Threshold: all words in the shorter
// name must prefix-match a word in the longer name.
function namesLikelySame(a: string, b: string): boolean {
  if (a === b) return true
  const wa = a.split(' ').filter(Boolean)
  const wb = b.split(' ').filter(Boolean)
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  if (shorter.length === 0) return false
  const matches = shorter.filter(sw => longer.some(lw => lw.startsWith(sw) || sw.startsWith(lw)))
  return matches.length / shorter.length >= 0.8
}

// BFS within a single folder — returns all spreadsheets at any depth with their file names.
async function getSpreadsheetsUnderFolder(
  drive: ReturnType<typeof google.drive>,
  rootFolderId: string,
): Promise<{ id: string; name: string }[]> {
  const results: { id: string; name: string }[] = []
  const queue = [rootFolderId]
  const visited = new Set([rootFolderId])

  while (queue.length > 0) {
    const folderId = queue.shift()!

    const sheetsRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id,name)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as any[] } }))
    for (const f of (sheetsRes.data.files ?? [])) {
      if (f.id) results.push({ id: f.id, name: f.name ?? '' })
    }

    // Also pick up shortcuts pointing to spreadsheets
    const shortcutRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
      fields: 'files(id,name,shortcutDetails)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as any[] } }))
    for (const f of (shortcutRes.data.files ?? [])) {
      const targetMime = (f as any).shortcutDetails?.targetMimeType ?? ''
      const targetId   = (f as any).shortcutDetails?.targetId ?? ''
      if (targetMime === 'application/vnd.google-apps.spreadsheet' && targetId) {
        results.push({ id: targetId, name: f.name ?? '' })
      }
    }

    const subRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as any[] } }))
    for (const f of (subRes.data.files ?? [])) {
      if (f.id && !visited.has(f.id)) { visited.add(f.id); queue.push(f.id) }
    }
  }
  return results
}

// Discovers accounts from connected AE folders.
//
// Strategy:
//   PRIMARY  — Supportable/territory spreadsheet tabs (one tab per account).
//              These represent ALL accounts the AE manages, not just ones with open pipeline.
//              AE name comes from the folder the spreadsheet lives in.
//   SUPPLEMENT — Pipeline file (auto-discovered or explicit URL) adds any accounts
//              not already in the territory list. Keeps pipeline AE assignment for
//              accounts that don't appear in any Supportable file.
//
// Folder depth: BFS within each AE subfolder, so AE/Accounts/*.xlsx is found automatically.
async function discoverAccountsFromFolders(
  drive: ReturnType<typeof google.drive>,
  sheets: ReturnType<typeof google.sheets>,
  parentIds: string[],
  explicitFileId?: string,
): Promise<{ accounts: DiscoveredAccount[]; source: 'territory+pipeline' | 'territory' | 'pipeline' | 'manual' }> {

  // Collect all spreadsheets grouped by AE folder name
  const byAe: { aeName: string; fileId: string; fileName: string }[] = []
  const autoDiscoveredPipelineIds: string[] = []

  for (const parentId of parentIds) {
    // Get the connected folder's own name to check if it IS the AE folder
    const selfMeta = await drive.files.get({ fileId: parentId, fields: 'id,name' }).catch(() => ({ data: { name: '' } }))
    const selfName = ((selfMeta.data as any).name ?? '').trim()
    const selfNameLower = selfName.toLowerCase()

    // Check direct children (sheets + shortcuts) of the connected folder
    const [selfSheetsRes, selfShortcutsRes] = await Promise.all([
      drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'files(id,name)', pageSize: 50,
      }).catch(() => ({ data: { files: [] as any[] } })),
      drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
        fields: 'files(id,name,shortcutDetails)', pageSize: 50,
      }).catch(() => ({ data: { files: [] as any[] } })),
    ])

    const selfFiles: { id: string; name: string }[] = [
      ...((selfSheetsRes.data as any).files ?? []).map((f: any) => ({ id: f.id, name: f.name ?? '' })),
      ...((selfShortcutsRes.data as any).files ?? [])
        .filter((f: any) => (f.shortcutDetails?.targetMimeType ?? '').includes('spreadsheet'))
        .map((f: any) => ({ id: f.shortcutDetails.targetId, name: f.name ?? '' })),
    ]

    // If this folder contains files named with the folder's own name, it IS the AE folder
    const isAeFolder = selfFiles.some(f => f.name.toLowerCase().startsWith(selfNameLower))

    if (isAeFolder) {
      for (const s of selfFiles) {
        console.log(`[discovery] AE="${selfName}" file="${s.name}"`)
        byAe.push({ aeName: selfName, fileId: s.id, fileName: s.name })
        if (s.name.toLowerCase().includes('pipeline')) autoDiscoveredPipelineIds.push(s.id)
      }
      continue
    }

    // Otherwise treat as a parent folder containing AE subfolders
    const foldersRes = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 50,
    }).catch(() => ({ data: { files: [] as any[] } }))

    for (const aeFolder of ((foldersRes.data as any).files ?? [])) {
      if (!aeFolder.id) continue
      const aeName = aeFolder.name ?? ''
      const spreadsheets = await getSpreadsheetsUnderFolder(drive, aeFolder.id)
      for (const s of spreadsheets) {
        console.log(`[discovery] AE="${aeName}" file="${s.name}"`)
        byAe.push({ aeName, fileId: s.id, fileName: s.name })
        if (s.name.toLowerCase().includes('pipeline')) autoDiscoveredPipelineIds.push(s.id)
      }
    }
  }

  // ── Primary: territory spreadsheet tabs ──────────────────────────────────────
  // If an AE has a file explicitly named "supportable", use only that file.
  // Otherwise fall back to: file with a Supportable/CCSP tab, or any file with 3+ customer tabs.
  // This prevents old multi-purpose territory spreadsheets from polluting the account list
  // once a properly named Supportable file is in place.
  const aesWithSupportableFile = new Set(
    byAe
      .filter(s => !s.fileName.toLowerCase().includes('pipeline') && s.fileName.toLowerCase().includes('supportable'))
      .map(s => s.aeName)
  )

  const territoryAccounts: DiscoveredAccount[] = []
  const seenNorm = new Set<string>()

  for (const { aeName, fileId, fileName } of byAe) {
    if (fileName.toLowerCase().includes('pipeline')) continue
    const fileNameLower = fileName.toLowerCase()
    if (fileNameLower.includes('ccsp')) continue  // skip CCSP files for account list

    const hasSupportableName = fileNameLower.includes('supportable')

    // If this AE already has a named Supportable file, skip all other files
    if (aesWithSupportableFile.has(aeName) && !hasSupportableName) continue

    const meta = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'sheets.properties.title' }).catch(() => null)
    const tabs = (meta?.data.sheets ?? []).map((s: any) => (s.properties?.title ?? '') as string)

    const hasSupportableTab = tabs.some(t => t.toLowerCase().includes('supportable'))
    const customerTabCount  = tabs.filter(t => isCustomerTab(t)).length
    const isTerritoryFile   = hasSupportableName || hasSupportableTab || customerTabCount >= 3
    if (!isTerritoryFile) continue

    // Prefer an explicit "Account List" / "Accounts" tab as source of truth.
    // Falls back to scanning all customer-looking tabs if no account tab found.
    const accountTab = tabs.find(t => /\baccount/i.test(t))
    if (accountTab) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: fileId, range: accountTab,
      }).catch(() => null)
      const rows = (res?.data.values ?? []) as string[][]
      if (rows.length >= 2) {
        const headers  = rows[0].map((h: string) => h.toLowerCase().trim())
        const nameIdx  = headers.findIndex(h => h.includes('account') && !h.includes('number') && !h.includes('no') && !h.includes('#'))
        const segIdx   = headers.findIndex(h => h.includes('segment'))
        const aliasIdx = headers.findIndex(h => h.includes('alias'))
        if (nameIdx >= 0) {
          for (const row of rows.slice(1)) {
            const name = String(row[nameIdx] ?? '').trim()
            if (!name) continue
            const norm = normalizeForDedup(name)
            if (seenNorm.has(norm)) continue
            seenNorm.add(norm)
            // Parse aliases (comma-separated) and add their norms to dedup set
            const aliasRaw = aliasIdx >= 0 ? String(row[aliasIdx] ?? '').trim() : ''
            const aliases  = aliasRaw ? aliasRaw.split(/[\n,]/).map(a => a.trim()).filter(Boolean) : undefined
            if (aliases) {
              for (const alias of aliases) seenNorm.add(normalizeForDedup(alias))
            }
            const segment = segIdx >= 0 ? String(row[segIdx] ?? '').trim() : undefined
            territoryAccounts.push({ name, ae: aeName, segment: segment || undefined, aliases, supportableFileId: fileId })
          }
          continue  // done with this file — account tab was authoritative
        }
      }
    }

    // Fallback: scan tabs for customer-looking names
    for (const tab of tabs) {
      if (!isCustomerTab(tab)) continue
      const norm = normalizeForDedup(tab)
      if (seenNorm.has(norm)) continue
      seenNorm.add(norm)
      territoryAccounts.push({ name: tab, ae: aeName })
    }
  }

  // ── Supplement: pipeline accounts not already in territory ────────────────────
  const pipelineFileIds = explicitFileId ? [explicitFileId] : autoDiscoveredPipelineIds
  const pipelineAccounts = await readPipelineAccounts(sheets, pipelineFileIds)

  const seenNormList = [...seenNorm]  // snapshot of territory norms for fuzzy check
  const supplementAccounts: DiscoveredAccount[] = []
  for (const pa of pipelineAccounts) {
    const norm = normalizeForDedup(pa.name)
    if (seenNorm.has(norm)) continue
    if (seenNormList.some(t => namesLikelySame(norm, t))) continue
    seenNorm.add(norm)
    supplementAccounts.push(pa)
  }

  const allAccounts = [...territoryAccounts, ...supplementAccounts]
  if (!allAccounts.length) return { accounts: [], source: 'territory' }

  const source = territoryAccounts.length > 0 && supplementAccounts.length > 0 ? 'territory+pipeline'
    : territoryAccounts.length > 0 ? 'territory'
    : explicitFileId ? 'manual'
    : 'pipeline'

  return { accounts: allAccounts, source }
}

async function readPipelineAccounts(
  sheets: ReturnType<typeof google.sheets>,
  fileIds: string[],
): Promise<DiscoveredAccount[]> {
  const seen = new Set<string>()
  const accounts: DiscoveredAccount[] = []
  for (const fileId of fileIds) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'properties.title' }).catch(() => null)
    const fileName = meta?.data.properties?.title ?? fileId
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: 'A1:Z5000' }).catch(() => null)
    const rows = (res?.data.values ?? []) as string[][]
    if (rows.length < 2) continue
    const headers  = rows[0].map(String)
    const nameIdx  = headers.indexOf('Account Name')
    const ownerIdx = headers.indexOf('Opportunity Owner')
    if (nameIdx < 0) continue
    for (const row of rows.slice(1)) {
      const name = String(row[nameIdx] ?? '').trim()
      const ae   = ownerIdx >= 0 ? String(row[ownerIdx] ?? '').trim() : ''
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      accounts.push({ name, ae })
    }
  }
  return accounts
}

// ── Pipeline bootstrap ────────────────────────────────────────────────────────

// POST /api/sheets/bootstrap-preview — Preview accounts discovered from AE folders or explicit URL.
// Discovery order: (1) pipeline file by name, (2) explicit fileId, (3) territory spreadsheet tabs.
app.post('/api/sheets/bootstrap-preview', async (c) => {
  const body = await c.req.json<{ fileId?: string }>().catch(() => ({}))
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)

  if (!parentIds.length && !body.fileId) {
    return c.json({ error: 'Connect AE folders in Step 1 or paste a pipeline sheet URL.' }, 400)
  }

  try {
    const auth   = makeAuth(GDRIVE_TOKEN_PATH_SRV)
    const drive  = google.drive({ version: 'v3', auth })
    const sheets = google.sheets({ version: 'v4', auth })

    const { accounts, source } = await discoverAccountsFromFolders(drive, sheets, parentIds, body.fileId)
    if (!accounts.length) return c.json({ error: 'No accounts found. Check your folder connection or paste a pipeline URL.' }, 400)

    accounts.sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ accounts, source })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Discovery failed' }, 500)
  }
})

// POST /api/sheets/bootstrap — Import discovered accounts into customers.json.
app.post('/api/sheets/bootstrap', async (c) => {
  const body = await c.req.json<{ fileId?: string }>().catch(() => ({}))
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)

  if (!parentIds.length && !body.fileId) {
    return c.json({ error: 'Connect AE folders in Step 1 or paste a pipeline sheet URL.' }, 400)
  }

  try {
    const auth   = makeAuth(GDRIVE_TOKEN_PATH_SRV)
    const drive  = google.drive({ version: 'v3', auth })
    const sheets = google.sheets({ version: 'v4', auth })

    const { accounts, source } = await discoverAccountsFromFolders(drive, sheets, parentIds, body.fileId)
    if (!accounts.length) return c.json({ error: 'No accounts found. Check your folder connection or paste a pipeline URL.' }, 400)

    accounts.sort((a, b) => a.name.localeCompare(b.name))
    const imported = accounts.map(a => ({ name: a.name, ae: a.ae, domain: '', segment: a.segment ?? '', region: '', accountNumbers: [], ...(a.aliases?.length ? { aliases: a.aliases } : {}), ...(a.supportableFileId ? { supportableFileId: a.supportableFileId } : {}) }))
    const tmpPath = CUSTOMERS_PATH + '.tmp'
    writeFileSyncRaw(tmpPath, JSON.stringify({ customers: imported }, null, 2))
    renameSync(tmpPath, CUSTOMERS_PATH)
    customers.splice(0, customers.length, ...imported)
    return c.json({ imported: imported.length, source })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Import failed' }, 500)
  }
})

// GET /api/data-sources/preview — Scan connected AE folders, report what was found
app.get('/api/data-sources/preview', async (c) => {
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
  if (!parentIds.length) return c.json({ aeFolders: [] })

  try {
    const auth   = makeAuth(GDRIVE_TOKEN_PATH_SRV)
    const drive  = google.drive({ version: 'v3', auth })
    const sheets = google.sheets({ version: 'v4', auth })

    const result: {
      aeFolderName: string
      pipelineSheets: { name: string; rowCount: number }[]
      ccspFound: boolean
      customerTabs: string[]
    }[] = []

    for (const parentId of parentIds) {
      const foldersRes = await drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 50,
      }).catch(() => ({ data: { files: [] as any[] } }))

      for (const aeFolder of (foldersRes.data.files ?? [])) {
        if (!aeFolder.id) continue

        const sheetsRes = await drive.files.list({
          q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
          fields: 'files(id,name)', pageSize: 20,
        }).catch(() => ({ data: { files: [] as any[] } }))

        const pipelineSheets: { name: string; rowCount: number }[] = []
        let ccspFound = false
        const customerTabs: string[] = []

        for (const f of (sheetsRes.data.files ?? [])) {
          if (!f.id) continue
          const isPipeline = f.name?.toLowerCase().includes('pipeline') ?? false

          const meta = await sheets.spreadsheets.get({ spreadsheetId: f.id, fields: 'sheets.properties.title' })
            .catch(() => null)
          const tabs = (meta?.data.sheets ?? []).map((s: any) => s.properties?.title ?? '')

          if (isPipeline) {
            const valRes = await sheets.spreadsheets.values.get({ spreadsheetId: f.id, range: 'A1:A5000' }).catch(() => null)
            pipelineSheets.push({ name: f.name ?? '', rowCount: Math.max(0, (valRes?.data.values?.length ?? 1) - 1) })
          }

          for (const tab of tabs) {
            if (tab.toLowerCase().includes('ccsp')) ccspFound = true
            else if (!isPipeline) customerTabs.push(tab)
          }
        }

        result.push({ aeFolderName: aeFolder.name ?? '', pipelineSheets, ccspFound, customerTabs })
      }
    }

    return c.json({ aeFolders: result })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Preview failed' }, 500)
  }
})

// ── Google Sheets API endpoints ───────────────────────────────────────────────

// GET /api/sheets/status — Check if a sheet is connected
app.get('/api/sheets/status', (c) => {
  try {
    const sync = JSON.parse(readFileSync(SHEETS_SYNC_PATH, 'utf-8'))
    return c.json({ connected: true, fileId: sync.fileId, fileName: sync.fileName, syncedAt: sync.syncedAt })
  } catch {
    return c.json({ connected: false })
  }
})

// Shared helper: read rows from a sheet and build the customers array
async function importSheetRows(
  fileId: string,
  fileName: string,
  columnMap: Record<string, number | string | null>,
): Promise<{ customers: ReturnType<typeof buildCustomer>[]; syncedAt: string }> {
  const auth = makeAuth(SHEETS_TOKEN_PATH_SRV)
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: 'A2:Z5000' })
  const rows = res.data.values ?? []
  const customers = rows
    .filter((row: any[]) => row.some((cell: string) => cell?.trim()))
    .map((row: string[]) => buildCustomer(row, columnMap))
    .filter((r) => r.name)
  const tmpPath = CUSTOMERS_PATH + '.tmp'
  writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2))
  renameSync(tmpPath, CUSTOMERS_PATH)
  const syncedAt = new Date().toISOString()
  writeFileSyncRaw(SHEETS_SYNC_PATH, JSON.stringify({ fileId, fileName, columnMap, syncedAt }, null, 2))
  return { customers, syncedAt }
}

function buildCustomer(row: string[], columnMap: Record<string, number | string | null>) {
  const get = (field: string) => {
    const val = columnMap[field]
    if (val == null) return ''
    if (typeof val === 'string') return val.trim()
    return (row[val] ?? '').trim()
  }
  const accountNumbersRaw = get('accountNumbers')
  return {
    name: get('name'),
    domain: get('domain'),
    ae: get('ae'),
    segment: get('segment'),
    region: get('region'),
    accountNumbers: accountNumbersRaw
      ? accountNumbersRaw.split(/[,;]+/).map((s: string) => s.trim()).filter(Boolean)
      : [],
  }
}

// GET /api/sheets/list — List available Google Sheets from Drive
app.get('/api/sheets/list', async (c) => {
  try {
    const auth = makeAuth(GDRIVE_TOKEN_PATH_SRV)
    const drive = google.drive({ version: 'v3', auth })
    const res = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      fields: 'files(id,name,webViewLink,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 20,
    })
    return c.json({ files: res.data.files ?? [] })
  } catch (e: any) {
    return c.json({ files: [], error: e.message }, 500)
  }
})

// GET /api/sheets/headers — Read header row from a specific sheet
app.get('/api/sheets/headers', async (c) => {
  const fileId = c.req.query('fileId')
  if (!fileId) return c.json({ error: 'fileId required' }, 400)
  try {
    const auth = makeAuth(SHEETS_TOKEN_PATH_SRV)
    const sheets = google.sheets({ version: 'v4', auth })
    const [meta, res] = await Promise.all([
      sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'properties.title' }),
      sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: 'A1:Z1' }),
    ])
    const headers = (res.data.values?.[0] ?? []) as string[]
    return c.json({ headers, fileName: meta.data.properties?.title ?? '' })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/sheets/import — Import customers from a Google Sheet
app.post('/api/sheets/import', async (c) => {
  const body = await c.req.json() as { fileId: string; fileName: string; columnMap: Record<string, number | string | null> }
  const { fileId, fileName, columnMap } = body
  if (!fileId || !columnMap) return c.json({ error: 'fileId and columnMap required' }, 400)
  try {
    const { customers: imported, syncedAt } = await importSheetRows(fileId, fileName, columnMap)
    customers.splice(0, customers.length, ...imported)
    return c.json({ imported: imported.length, syncedAt })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/sheets/sync — Re-sync from the previously connected sheet
app.post('/api/sheets/sync', async (c) => {
  let syncConfig: { fileId: string; fileName: string; columnMap: Record<string, number | string | null> }
  try {
    syncConfig = JSON.parse(readFileSync(SHEETS_SYNC_PATH, 'utf-8'))
  } catch {
    return c.json({ error: 'No sheet connected. Use /api/sheets/import first.' }, 400)
  }
  try {
    const { customers: synced, syncedAt } = await importSheetRows(syncConfig.fileId, syncConfig.fileName, syncConfig.columnMap)
    customers.splice(0, customers.length, ...synced)
    return c.json({ synced: synced.length, syncedAt })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// GET /customer/:name/pipeline — Pipeline opps for a single customer (from cache)
app.get('/customer/:name/pipeline', (c) => {
  const rawName = decodeURIComponent(c.req.param('name')).toLowerCase()
  const cached = readPipelineCache()
  if (!cached) return c.json({ totalAcv: 0, openCount: 0, opps: [], closedOpps: [], cachedAt: null })

  function normalize(s: string) {
    return s.toLowerCase()
      .replace(/,?\s*(inc\.|llc|inc|corp|ltd|lp|co\.|u\.s\..*|life and safety.*|life & safety.*|digital media.*)$/i, '')
      .replace(/[,\.]/g, '').trim()
  }
  const needle = normalize(rawName)

  const open: typeof cached.records = []
  const closed: typeof cached.records = []

  for (const r of cached.records) {
    const hay = normalize(r.accountName)
    if (!hay.includes(needle) && !needle.includes(hay)) continue
    if (r.forecastCategory.toLowerCase() === 'closed') closed.push(r)
    else open.push(r)
  }

  const totalAcv = open.reduce((s, r) => s + r.acv, 0)

  return c.json({
    totalAcv,
    openCount: open.length,
    opps: open.sort((a, b) => b.acv - a.acv),
    closedOpps: closed.sort((a, b) => b.closeDate.localeCompare(a.closeDate)),
    cachedAt: cached.cachedAt,
  })
})

// ── Customer intelligence pages ───────────────────────────────────────────────
app.get('/customer/:name/events', (c) => {
  const rawName = decodeURIComponent(c.req.param('name'))
  const customer = customers.find(
    (cu) => cu.name.toLowerCase() === rawName.toLowerCase()
  )
  if (!customer) return c.text('Customer not found', 404)

  return streamSSE(c, async (stream) => {
    // Ensure account numbers are populated before fetching cases/subscriptions
    if (!customer.accountNumbers?.length) {
      const discovered = await fetchCustomerAccountNumbers(customer).catch(() => [] as string[])
      if (discovered.length) {
        customer.accountNumbers = discovered
        // Persist back to customers.json so future loads don't need to re-fetch
        try {
          const updated = customers.map((cu) =>
            cu.name === customer.name ? { ...cu, accountNumbers: discovered } : cu
          )
          writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2))
          renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
          customers.splice(0, customers.length, ...updated)
        } catch {}
      }
    }

    // Meta (send after account numbers are resolved so client gets the latest)
    await stream.writeSSE({ event: 'meta', data: JSON.stringify(customer) })

    // Fetch all sections in parallel
    const [meetings, emails, docs, cases, subscriptions] = await Promise.all([
      fetchCustomerMeetings(customer).catch((e) => ({ error: e.message })),
      fetchCustomerEmails(customer).catch((e) => ({ error: e.message })),
      fetchCustomerDocs(customer).catch((e) => ({ error: e.message })),
      fetchCustomerCases(customer).catch(() => []),
      fetchCustomerSubscriptions(customer).catch(() => []),
    ])

    await stream.writeSSE({ event: 'meetings',      data: JSON.stringify(meetings) })
    await stream.writeSSE({ event: 'emails',        data: JSON.stringify(emails) })
    await stream.writeSSE({ event: 'drive',         data: JSON.stringify(docs) })
    await stream.writeSSE({ event: 'cases',         data: JSON.stringify(cases) })
    await stream.writeSSE({ event: 'subscriptions', data: JSON.stringify(subscriptions) })

    await stream.writeSSE({ event: 'complete', data: JSON.stringify({ timestamp: new Date().toISOString() }) })
  })
})

// ── Customer brief — cached, separate endpoint so subprocess doesn't block SSE ──
app.get('/customer/:name/brief', async (c) => {
  const rawName = decodeURIComponent(c.req.param('name'))
  const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
  if (!customer) return c.json({ error: 'Customer not found' }, 404)

  const force = c.req.query('force') === 'true'

  // Check cache unless force refresh
  if (!force) {
    const cached = readBriefCache(customer.name)
    if (cached) return c.json({ text: cached.text, cachedAt: cached.cachedAt, fromCache: true })
  }

  try {
    const cachedSheet = readSheetCache(customer.name)
    const [meetings, emails, docs, cases, subscriptions, products] = await Promise.all([
      fetchCustomerMeetings(customer).catch(() => []),
      fetchCustomerEmails(customer).catch(() => []),
      fetchCustomerDocs(customer).catch(() => []),
      fetchCustomerCases(customer).catch(() => []),
      fetchCustomerSubscriptions(customer).catch(() => []),
      cachedSheet ? Promise.resolve(cachedSheet.rows) : fetchCustomerSheetData(customer).catch(() => []),
    ])
    const text = await generateBrief(customer, meetings, emails, docs, cases, subscriptions, products)
    writeBriefCache(customer.name, text)
    return c.json({ text, fromCache: false })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── Refresh settings ─────────────────────────────────────────────────────────

const DEFAULT_REFRESH_INTERVALS = {
  subscriptions: 4 * 60,   // minutes
  ccsp:          60 * 24,  // daily
  rhScrape:      4 * 60,   // RH portal support case scrape — every 4 hours
}

function getRefreshIntervals(): typeof DEFAULT_REFRESH_INTERVALS {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return { ...DEFAULT_REFRESH_INTERVALS, ...(ds.refreshIntervals ?? {}) }
  } catch { return DEFAULT_REFRESH_INTERVALS }
}

// GET /api/settings/refresh — current refresh intervals (in minutes)
app.get('/api/settings/refresh', (c) => {
  return c.json({ intervals: getRefreshIntervals(), defaults: DEFAULT_REFRESH_INTERVALS })
})

// POST /api/settings/refresh — update refresh intervals
app.post('/api/settings/refresh', async (c) => {
  const body = await c.req.json<Partial<typeof DEFAULT_REFRESH_INTERVALS>>().catch(() => ({}))
  const current = getRefreshIntervals()
  const updated = { ...current, ...body }
  // Validate: all values must be positive numbers
  for (const [k, v] of Object.entries(updated)) {
    if (typeof v !== 'number' || v < 1) return c.json({ error: `${k} must be a positive number of minutes` }, 400)
  }
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    const tmpPath = DATA_SOURCES_PATH + '.tmp'
    writeFileSyncRaw(tmpPath, JSON.stringify({ ...ds, refreshIntervals: updated }, null, 2))
    renameSync(tmpPath, DATA_SOURCES_PATH)
    rescheduleRefreshTimers(updated)
    return c.json({ intervals: updated })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── Weather settings + proxy ──────────────────────────────────────────────────

interface WeatherSettings { enabled: boolean; zipCode: string }

function getWeatherSettings(): WeatherSettings {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return { enabled: false, zipCode: '', ...(ds.weather ?? {}) }
  } catch { return { enabled: false, zipCode: '' } }
}

app.get('/api/settings/weather', (c) => c.json(getWeatherSettings()))

app.post('/api/settings/weather', async (c) => {
  const body = await c.req.json<Partial<WeatherSettings>>().catch(() => ({}))
  const current = getWeatherSettings()
  const updated: WeatherSettings = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    zipCode: typeof body.zipCode === 'string' ? body.zipCode.trim() : current.zipCode,
  }
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    const tmpPath = DATA_SOURCES_PATH + '.tmp'
    writeFileSyncRaw(tmpPath, JSON.stringify({ ...ds, weather: updated }, null, 2))
    renameSync(tmpPath, DATA_SOURCES_PATH)
    _weatherCache = null // invalidate cache on settings change
    return c.json(updated)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// 30-minute in-memory weather cache
let _weatherCache: { data: object; fetchedAt: number } | null = null
const WEATHER_CACHE_MS = 30 * 60 * 1000

app.get('/api/weather', async (c) => {
  const settings = getWeatherSettings()
  if (!settings.enabled || !settings.zipCode) return c.json({ enabled: false })

  if (_weatherCache && Date.now() - _weatherCache.fetchedAt < WEATHER_CACHE_MS) {
    return c.json({ enabled: true, ..._weatherCache.data })
  }

  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(settings.zipCode)}?format=j1`, {
      headers: { 'User-Agent': 'DailyBriefDashboard/1.0' },
    })
    if (!res.ok) throw new Error(`wttr.in ${res.status}`)
    const raw = await res.json() as any
    const cc = raw.current_condition?.[0] ?? {}
    const data = {
      tempF:     cc.temp_F ?? '',
      condition: cc.weatherDesc?.[0]?.value ?? '',
      humidity:  cc.humidity ?? '',
      feelsLikeF: cc.FeelsLikeF ?? '',
    }
    _weatherCache = { data, fetchedAt: Date.now() }
    return c.json({ enabled: true, ...data })
  } catch (e: any) {
    console.warn('[weather]', e.message)
    return c.json({ enabled: true, error: 'unavailable' })
  }
})

// ── Drive watcher endpoints ───────────────────────────────────────────────────

app.get('/api/drive-watcher/status', (c) => {
  const state = getWatcherState()
  if (!state) return c.json({ enabled: false, folderMap: [], lastChecked: null, builtAt: null })
  return c.json({
    enabled: state.enabled,
    folderMap: state.folderMap,
    lastChecked: state.lastChecked ?? null,
    builtAt: state.builtAt,
  })
})

app.post('/api/drive-watcher/rebuild', async (c) => {
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
  try {
    const folderMap = await rebuildFolderMap(customers, parentIds)
    return c.json({ rebuilt: true, folders: folderMap.length, map: folderMap })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── Full data refresh ─────────────────────────────────────────────────────────

async function refreshAll(): Promise<{ sheets: number; ccsp: boolean; errors: string[] }> {
  const errors: string[] = []
  let sheetsRefreshed = 0

  // 1. Subscription sheet data for every customer
  for (const customer of customers) {
    try {
      const rows = await fetchCustomerSheetData(customer)
      writeSheetCache(customer.name, rows)
      sheetsRefreshed++
    } catch (e: any) {
      errors.push(`${customer.name}: ${e.message}`)
    }
  }

  // 2. CCSP
  let ccspOk = false
  try {
    const { records, fileIds } = await fetchCCSPData()
    writeCCSPCache(records, fileIds)
    ccspOk = true
  } catch (e: any) { errors.push(`ccsp: ${e.message}`) }

  console.log(`[refresh] sheets=${sheetsRefreshed}/${customers.length} ccsp=${ccspOk} errors=${errors.length}`)
  return { sheets: sheetsRefreshed, ccsp: ccspOk, errors }
}

app.post('/api/refresh', async (c) => {
  const result = await refreshAll()
  return c.json({ ...result, refreshedAt: new Date().toISOString() })
})

// ── Sheet data — permanent cache, force-refresh via ?force=true ───────────────
app.get('/customer/:name/sheetdata', async (c) => {
  const rawName = decodeURIComponent(c.req.param('name'))
  const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
  if (!customer) return c.json({ error: 'Customer not found' }, 404)

  const force = c.req.query('force') === 'true'

  if (!force) {
    const cached = readSheetCache(customer.name)
    if (cached) return c.json({ rows: cached.rows, cachedAt: cached.cachedAt, fromCache: true })
  }

  try {
    const rows = await fetchCustomerSheetData(customer)
    writeSheetCache(customer.name, rows)
    return c.json({ rows, fromCache: false })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── Debug: raw sheet rows before normalization ────────────────────────────────
app.get('/customer/:name/sheetdebug', async (c) => {
  const rawName = decodeURIComponent(c.req.param('name'))
  const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
  if (!customer) return c.json({ error: 'Customer not found' }, 404)
  try {
    const result = await fetchCustomerSheetRaw(customer)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/debug/sheet-tabs/:fileId', async (c) => {
  const fileId = c.req.param('fileId')
  const { makeAuth } = await import('./src/google.ts')
  const { google } = await import('googleapis')
  const auth = makeAuth(SHEETS_TOKEN_PATH_SRV)
  const sheets = google.sheets({ version: 'v4', auth })
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'sheets.properties.title' })
    const tabs = (res.data.sheets ?? []).map(s => s.properties?.title ?? '')
    return c.json({ fileId, tabs })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// SSE data stream — each section fires as its promise resolves
app.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    const sections: Array<[string, () => Promise<any>]> = [
      ['calendar', () => fetchCalendar(customers)],
      ['email',    () => fetchEmail(customers)],
      ['cases',    fetchCases],
      ['drive',    () => fetchDrive(customers)],
    ]

    await Promise.all(
      sections.map(async ([name, fetcher]) => {
        try {
          const data = await fetcher()
          await stream.writeSSE({
            event: 'section',
            data: JSON.stringify({ section: name, data }),
          })
        } catch (err: any) {
          await stream.writeSSE({
            event: 'section',
            data: JSON.stringify({ section: name, error: err.message }),
          })
        }
      })
    )

    await stream.writeSSE({
      event: 'complete',
      data: JSON.stringify({ timestamp: new Date().toISOString() }),
    })
  })
})

// ── Per-source refresh functions ──────────────────────────────────────────────

async function refreshSubscriptions(): Promise<void> {
  // Check if Supportable source sheet has changed before re-fetching all customers
  try {
    const syncConfig = JSON.parse(readFileSync(SHEETS_SYNC_PATH, 'utf-8')) as { fileId?: string }
    if (syncConfig.fileId) {
      // Use oldest sheet cachedAt as the baseline — if the source file is newer, all customers refresh
      const timestamps = customers.map(cu => readSheetCache(cu.name)?.cachedAt).filter(Boolean) as string[]
      const oldestCachedAt = timestamps.length ? timestamps.reduce((a, b) => a < b ? a : b) : null
      if (oldestCachedAt) {
        const changed = await checkFilesModified([syncConfig.fileId], oldestCachedAt)
        if (!changed) { console.log(`[refresh:subscriptions] skipped — source file unchanged`); return }
      }
    }
  } catch {
    // If we can't check, proceed with refresh
  }
  for (const customer of customers) {
    try {
      const rows = await fetchCustomerSheetData(customer)
      writeSheetCache(customer.name, rows)
    } catch (e: any) {
      console.warn(`[refresh:subscriptions] ${customer.name}: ${e.message}`)
    }
  }
  console.log(`[refresh:subscriptions] done (${customers.length} customers)`)
}

async function refreshCCSP(): Promise<void> {
  try {
    const cached = readCCSPCache()
    if (cached?.fileIds?.length && cached.cachedAt) {
      const changed = await checkFilesModified(cached.fileIds, cached.cachedAt)
      if (!changed) { console.log(`[refresh:ccsp] skipped — source files unchanged`); return }
    }
    const { records, fileIds } = await fetchCCSPData()
    writeCCSPCache(records, fileIds)
    console.log(`[refresh:ccsp] done`)
  } catch (e: any) {
    console.warn(`[refresh:ccsp] ${e.message}`)
  }
}

async function refreshPipeline(): Promise<void> {
  try {
    const cached = readPipelineCache()
    if (cached?.fileIds?.length && cached.cachedAt) {
      const changed = await checkFilesModified(cached.fileIds, cached.cachedAt)
      if (!changed) { console.log(`[refresh:pipeline] skipped — source files unchanged`); return }
    }
    const { records, fileIds } = await fetchPipelineData()
    writePipelineCache(records, fileIds)
    console.log(`[refresh:pipeline] done`)
  } catch (e: any) {
    console.warn(`[refresh:pipeline] ${e.message}`)
  }
}

// ── Portal account number discovery ──────────────────────────────────────────
//
// Runs once after each successful login for customers with no account numbers.
// Uses a fresh page from the active context (shares cookies, not sessionStorage)
// so the live page's PKCE state is preserved.

let _discoveryRunning = false

async function runPortalAccountDiscovery(): Promise<void> {
  if (_discoveryRunning) return

  const missing = customers.filter((c) => !c.accountNumbers?.length && !c.skipAccountDiscovery)
  if (!missing.length) {
    console.log('[account-discovery] all customers have account numbers — skipping portal discovery')
    return
  }

  _discoveryRunning = true
  console.log(`[account-discovery] portal discovery starting for ${missing.length} customer(s)…`)

  let discoveredCount = 0
  // Prefer the live authenticated page; fall back to a new page from the
  // active context (stored cookies are sufficient for portal browsing).
  const livePage = getLivePage()
  const ctx = getScrapeContext()
  const page = livePage ?? (ctx ? await ctx.newPage() : null)
  const ownedPage = !livePage && !!page  // true if we opened it (must close after)
  if (!page) {
    console.warn('[account-discovery] no active context — skipping portal discovery')
    _discoveryRunning = false
    return
  }

  // First: dump filter DOM to diagnose selectors (only on first run)
  try {
    await page.goto('https://access.redhat.com/support/cases/#/case/list', {
      waitUntil: 'domcontentloaded', timeout: 30_000
    })
    await page.waitForTimeout(5_000)
    const domDump = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
        type: (el as HTMLInputElement).type,
        placeholder: (el as HTMLInputElement).placeholder,
        ariaLabel: el.getAttribute('aria-label'),
        id: el.id,
        className: el.className.slice(0, 60),
      }))
      const toolbarHtml = document.querySelector('[class*="toolbar"], [class*="filter-toolbar"], rh-filters')
        ?.outerHTML?.slice(0, 1500) ?? 'no toolbar found'
      return { inputs, toolbarHtml }
    })
    console.log('[account-discovery] DOM inputs:', JSON.stringify(domDump.inputs))
    console.log('[account-discovery] toolbar HTML:', domDump.toolbarHtml.slice(0, 500))
  } catch (e: any) {
    console.warn('[account-discovery] DOM dump failed:', e.message)
  }

  try {
    for (const customer of missing) {
      const result = await discoverAccountNumbers(page, customer.name, customer.aliases ?? [])

      if (result.accountNumbers.length === 0) continue

      // Merge into customers array and persist
      customer.accountNumbers = result.accountNumbers
      const updated = customers.map((c) =>
        c.name === customer.name ? { ...c, accountNumbers: result.accountNumbers } : c
      )
      writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2))
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      customers.splice(0, customers.length, ...updated)
      discoveredCount++
    }
  } catch (e: any) {
    console.warn('[account-discovery] portal discovery error:', e.message)
  } finally {
    if (ownedPage) await page.close().catch(() => {})
    _discoveryRunning = false
  }

  console.log(`[account-discovery] portal discovery done — ${discoveredCount} customer(s) updated`)
  if (discoveredCount > 0) runRhScrapeWithState().catch(() => {})
}

// Register keep-alive expiry → surface reconnect banner in dashboard
setSessionExpiredCallback(() => {
  recordScrapeExpired()
  closeScrapeContext().catch(() => {})
})

// ── Red Hat support case scraper ──────────────────────────────────────────────

let _rhScrapeRunning = false

async function runRhScrapeWithState(): Promise<void> {
  if (_rhScrapeRunning) { console.log('[rh-scraper] already running — skipping'); return }
  if (!existsSync(RH_SESSION_PATH)) return

  // Collect account numbers from customers config — check before setting flag to avoid leak
  const accountNumbers = customers
    .flatMap((c) => (c.accountNumbers ?? []).map(String))
    .filter(Boolean)

  if (accountNumbers.length === 0) {
    console.log('[rh-scraper] no account numbers configured — skipping')
    return
  }

  _rhScrapeRunning = true

  try {
    console.log(`[rh-scraper] scraping ${accountNumbers.length} accounts…`)
    const cases = await runRhScrape({
      accountNumbers,
      profileDir: RH_PROFILE_DIR,
      cachePath: RH_CASES_CACHE_PATH,
    })
    recordScrapeSuccess(cases.length)
    console.log(`[rh-scraper] done — ${cases.length} cases cached`)
  } catch (e: any) {
    if (e instanceof SessionExpiredError) {
      recordScrapeExpired()
      await closeScrapeContext() // discard expired context so next login gets a clean one
      console.warn('[rh-scraper] session expired — reconnect via dashboard')
    } else {
      console.warn('[rh-scraper]', e.message)
    }
  } finally {
    _rhScrapeRunning = false
  }
}

const RH_SCRAPE_TICK_MS = 15 * 60 * 1000  // tick interval — short intervals are reliable in Bun

// ── Configurable timer management ─────────────────────────────────────────────

let _subscriptionsTimer: ReturnType<typeof setInterval> | null = null
let _ccspTimer: ReturnType<typeof setInterval> | null = null

function rescheduleRefreshTimers(intervals: typeof DEFAULT_REFRESH_INTERVALS): void {
  if (_subscriptionsTimer) { clearInterval(_subscriptionsTimer); _subscriptionsTimer = null }
  if (_ccspTimer)          { clearInterval(_ccspTimer);          _ccspTimer = null }

  if (customers.length === 0) return

  _subscriptionsTimer = setInterval(() => refreshSubscriptions().catch(() => {}), intervals.subscriptions * 60 * 1000)
  _ccspTimer          = setInterval(() => refreshCCSP().catch(() => {}),          intervals.ccsp * 60 * 1000)

  console.log(`[timers] subscriptions=${intervals.subscriptions}m ccsp=${intervals.ccsp}m`)
}

// ── Pipeline daily sync at 2am ET ─────────────────────────────────────────────
// SF report is generated at 1am ET daily; we sync at 2am ET to ensure it's ready.
// Uses setTimeout + reschedule loop (container-safe — no system cron available).

function nextEt2amUtc(): Date {
  const now = new Date()
  // Derive ET UTC offset by comparing actual UTC ms with "ET time treated as UTC" ms.
  // This correctly handles EST vs EDT without hardcoding the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  // etOffsetMs = how many ms ahead UTC is vs ET local time
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const etOffsetMs  = now.getTime() - etAsIfUtcMs   // e.g. 4*3600*1000 during EDT

  // "Today at 2am ET" expressed as UTC
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, 2, 0, 0) + etOffsetMs)
  // If already past, roll to tomorrow
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

function schedulePipelineSync(): void {
  const next   = nextEt2amUtc()
  const now    = new Date()
  const msUntil = next.getTime() - now.getTime()
  const hUntil  = Math.round(msUntil / 1000 / 60 / 60 * 10) / 10
  console.log(`[pipeline-sync] next run at ${next.toISOString()} (${hUntil}h from now)`)

  setTimeout(async () => {
    try {
      console.log('[pipeline-sync] starting daily 2am ET sync')
      await refreshPipeline()
    } catch (e: any) {
      console.warn(`[pipeline-sync] error: ${e.message}`)
    }
    schedulePipelineSync()  // reschedule for next day
  }, msUntil)
}

const port = Number(process.env.PORT ?? 7777)
console.log(`\n🗂️  Daily Brief Dashboard`)
console.log(`   http://localhost:${port}`)
console.log(`   http://localhost:${port}/dashboard\n`)

// On startup: run a full refresh, then schedule per-source timers
if (customers.length > 0) {
  refreshAll().catch(() => {})
  rescheduleRefreshTimers(getRefreshIntervals())
}

// Pipeline syncs daily at 2am ET (SF report generated at 1am ET)
schedulePipelineSync()

// On startup: discover account numbers from Supportable sheets for any customer missing them
;(async () => {
  const missing = customers.filter((c) => !c.accountNumbers?.length && !c.skipAccountDiscovery)
  if (!missing.length) return

  console.log(`[account-discovery] discovering account numbers for ${missing.length} customers…`)
  let discovered = 0

  for (const customer of missing) {
    try {
      const nums = await fetchCustomerAccountNumbers(customer)
      if (!nums.length) continue
      customer.accountNumbers = nums
      const updated = customers.map((cu) =>
        cu.name === customer.name ? { ...cu, accountNumbers: nums } : cu
      )
      writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2))
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      customers.splice(0, customers.length, ...updated)
      console.log(`[account-discovery] ${customer.name}: ${nums.join(', ')}`)
      discovered++
    } catch (e: any) {
      console.warn(`[account-discovery] ${customer.name}: ${e.message}`)
    }
  }

  if (discovered > 0) {
    console.log(`[account-discovery] done — ${discovered} customers updated`)
    // Trigger a fresh scrape now that more account numbers are available
    runRhScrapeWithState().catch(() => {})
  } else {
    console.log('[account-discovery] no new account numbers found')
  }
})()

// On startup: open persistent scrape context and run initial scrape if session exists
if (existsSync(RH_SESSION_PATH)) {
  setTimeout(async () => {
    await initScrapeContext(RH_PROFILE_DIR)
    // Share the same browser context with SF and Supportable scrapers
    const ctx = getScrapeContext()
    if (ctx) { adoptSfContext(ctx, RH_PROFILE_DIR); adoptSupportableContext(ctx); adoptCcspContext(ctx) }
    runRhScrapeWithState().catch(() => {})
  }, 5_000)
}
// Use a short 15-min tick rather than a single 4-hour setInterval.
// Bun's runtime does not reliably fire setIntervals with intervals >~1h.
// Each tick checks elapsed time since last successful scrape and runs when due.
setInterval(() => {
  const intervalMs = getRefreshIntervals().rhScrape * 60 * 1000
  const lastMs = lastScraped ? new Date(lastScraped).getTime() : 0
  const elapsed = Date.now() - lastMs
  if (elapsed >= intervalMs) {
    console.log(`[rh-scraper] tick: ${Math.round(elapsed / 60_000)}m since last scrape — triggering`)
    runRhScrapeWithState().catch(() => {})
  } else {
    console.log(`[rh-scraper] tick: next scrape in ${Math.round((intervalMs - elapsed) / 60_000)}m`)
  }
}, RH_SCRAPE_TICK_MS)

// ── Drive watcher — init and background polling ────────────────────────────────

const DRIVE_WATCHER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

;(async () => {
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '')
    .split(',').filter(Boolean)
  if (!parentIds.length) return
  try {
    await initDriveWatcher(customers, parentIds)
  } catch (e: any) {
    console.warn('[drive-watcher] startup init failed:', e.message)
  }
})()

setInterval(async () => {
  try {
    const affected = await checkDriveChanges()
    for (const customerName of affected) {
      const cachePath = briefCachePath(customerName)
      try {
        unlinkSync(cachePath)
        console.log(`[drive-watcher] invalidated brief cache for ${customerName}`)
      } catch {
        // Cache file may not exist — that's fine
      }
    }
  } catch (e: any) {
    console.warn('[drive-watcher] interval check failed:', e.message)
  }
}, DRIVE_WATCHER_INTERVAL_MS)

// On startup: background pre-generation of today's briefs for customers missing cache
// Rate-limited to 1 customer per 10 seconds to avoid Drive API quota exhaustion
;(async () => {
  if (!customers.length || !isBriefConfigured()) return
  const missing = customers.filter((c) => !readBriefCache(c.name))
  if (!missing.length) return
  console.log(`[brief-pregen] starting background generation for ${missing.length} customers…`)
  for (const customer of missing) {
    // Re-check in case a user request already generated this brief while we were waiting
    if (readBriefCache(customer.name)) continue
    try {
      const cachedSheet = readSheetCache(customer.name)
      const [meetings, emails, docs, cases, subscriptions, products] = await Promise.all([
        fetchCustomerMeetings(customer).catch(() => []),
        fetchCustomerEmails(customer).catch(() => []),
        fetchCustomerDocs(customer).catch(() => []),
        fetchCustomerCases(customer).catch(() => []),
        fetchCustomerSubscriptions(customer).catch(() => []),
        cachedSheet ? Promise.resolve(cachedSheet.rows) : fetchCustomerSheetData(customer).catch(() => []),
      ])
      const text = await generateBrief(customer, meetings, emails, docs, cases, subscriptions, products)
      writeBriefCache(customer.name, text)
      console.log(`[brief-pregen] ${customer.name}: done`)
    } catch (e: any) {
      console.warn(`[brief-pregen] ${customer.name}: ${e.message}`)
    }
    // 10-second gap between customers to stay within Drive API quota
    await new Promise((r) => setTimeout(r, 10_000))
  }
  console.log('[brief-pregen] complete')
})()

// Graceful shutdown — close Chromium so it doesn't orphan in containers
async function shutdown() {
  console.log('[shutdown] closing browser context…')
  await closeScrapeContext().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

export default { port, fetch: app.fetch, idleTimeout: 120 }
