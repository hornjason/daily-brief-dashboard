import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'fs'
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { fetchEmail, fetchDrive, fetchCalendar, makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, OAUTH_KEYS_PATH } from './src/google.ts'
import { fetchCases, fetchCustomerCases, fetchCustomerSubscriptions } from './src/redhat.ts'
import { fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief, getBriefProvider, isBriefConfigured } from './src/customer.ts'
import { fetchCustomerSheetData, fetchCustomerSheetRaw, fetchCCSPData, fetchCustomerAccountNumbers } from './src/sheets.ts'
import type { CCSPRecord } from './src/sheets.ts'
import { fetchPipelineData, buildPipelineSummary } from './src/pipeline.ts'
import type { PipelineRecord } from './src/pipeline.ts'
import type { Customer, ProductSubscription } from './src/types.ts'

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

const SHEETS_TOKEN_PATH_SRV = process.env.SHEETS_TOKEN
  ?? resolve(import.meta.dir, '../CustomerIntelligence/config/.sheets-token.json')
const GDRIVE_TOKEN_PATH_SRV = process.env.GDRIVE_TOKEN
  ?? resolve(import.meta.dir, '../CustomerIntelligence/config/.gdrive-server-credentials.json')

const GOOGLE_OAUTH_KEYS_PATH = process.env.GOOGLE_OAUTH_KEYS
  ?? resolve(import.meta.dir, '../CustomerIntelligence/config/gcp-oauth.keys.json')

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

  const keys = JSON.parse(readFileSync(GOOGLE_OAUTH_KEYS_PATH, 'utf-8'))
  const { client_id, client_secret } = keys.installed ?? keys.web
  const redirectUri = `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

  oauthState = Math.random().toString(36).slice(2) + Date.now().toString(36)

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state: oauthState,
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
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
          <p style="color:#94a3b8">Email <strong style="color:#f1f5f9">jhorn@redhat.com</strong> and ask to be added, then try again.</p>
          <p style="margin-top:1.5rem">
            <a href="mailto:jhorn@redhat.com?subject=Dashboard%20Access%20Request&body=Hi%20Jason%2C%0A%0APlease%20add%20my%20Google%20account%20as%20a%20test%20user%20for%20the%20PAI%20Dashboard.%0A%0AMy%20email%3A%20%5Byour%40redhat.com%5D%0A%0AThanks"
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
    const tokenData = { ...tokens, configuredAt: new Date().toISOString() }

    // Save to config dir (works both locally and in container via volume mount)
    const tokenPath = GOOGLE_UNIFIED_TOKEN_PATH
    writeFileSyncRaw(tokenPath, JSON.stringify(tokenData, null, 2))
    oauthState = '' // consume state

    return c.html(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9;max-width:600px;margin:0 auto">
        <h2 style="color:#34d399">✓ Google Workspace Connected</h2>
        <p style="color:#94a3b8">Calendar, Gmail, Drive, and Sheets access authorized.</p>
        <p style="color:#94a3b8">Redirecting to setup wizard…</p>
        <script>setTimeout(() => window.location.href = '/dashboard/setup?step=1', 1500)</script>
        <p><a href="/dashboard/setup?step=1" style="color:#818cf8">Continue →</a></p>
      </body></html>`)
  } catch (e: any) {
    return errorPage('Token exchange failed', e.message)
  }
})

// GET /api/oauth/status — Check if unified Google token exists
app.get('/api/oauth/status', (c) => {
  if (!existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) return c.json({ authorized: false })
  try {
    const token = JSON.parse(readFileSync(GOOGLE_UNIFIED_TOKEN_PATH, 'utf-8'))
    return c.json({ authorized: true, configuredAt: token.configuredAt ?? null })
  } catch {
    return c.json({ authorized: false })
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
const PROVIDER_INSTRUCTIONS: Record<string, { vars: string[]; snippet: string; description: string }> = {
  pai:          { vars: ['LLM_PROVIDER=pai'],          snippet: 'LLM_PROVIDER=pai',                                   description: 'PAI Inference (default for PAI users)' },
  'claude-code':{ vars: ['LLM_PROVIDER=claude-code'], snippet: 'LLM_PROVIDER=claude-code',                           description: 'Claude Code CLI auth (no API key needed)' },
  gemini:       { vars: [],                           snippet: '',                                                    description: 'Manual prompt — copy and run in Gemini' },
  openai:       { vars: ['LLM_PROVIDER=openai', 'OPENAI_API_KEY=sk-...'],    snippet: 'LLM_PROVIDER=openai\nOPENAI_API_KEY=sk-your-key-here',    description: 'OpenAI GPT-4o' },
  anthropic:    { vars: ['LLM_PROVIDER=anthropic', 'ANTHROPIC_API_KEY=sk-ant-...'], snippet: 'LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-your-key', description: 'Anthropic Claude (direct)' },
  ollama:       { vars: ['LLM_PROVIDER=ollama'],       snippet: 'LLM_PROVIDER=ollama\n# Optional: OLLAMA_MODEL=llama3\n# Optional: OLLAMA_URL=http://localhost:11434', description: 'Ollama (local, no API key needed)' },
}

app.get('/api/config', (c) => {
  const provider = getBriefProvider()
  const configured = isBriefConfigured()
  return c.json({
    briefProvider: provider,
    briefConfigured: configured,
    providers: PROVIDER_INSTRUCTIONS,
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
app.get('/api/setup/check-auth', (c) => {
  const CI_CONFIG = resolve(import.meta.dir, '../CustomerIntelligence/config')
  const configDir = process.env.CONFIG_DIR
  const check = (filename: string) => {
    if (configDir && existsSync(resolve(configDir, filename))) return true
    return existsSync(resolve(CI_CONFIG, filename))
  }
  // Unified browser-OAuth token covers all three services
  const unified = check('.google-token.json')
  const tokens = {
    gmail:    unified || check('.gmail-token.json'),
    drive:    unified || check('.gdrive-server-credentials.json'),
    calendar: unified || check('.calendar-token.json'),
  }
  return c.json({ tokens, allConfigured: Object.values(tokens).every(Boolean) })
})

// POST /api/setup/reset — Clear all config and cache for a clean setup
app.post('/api/setup/reset', (c) => {
  const deleted: string[] = []
  const tryDelete = (p: string) => { try { if (existsSync(p)) { unlinkSync(p); deleted.push(p) } } catch {} }

  // Config files
  tryDelete(CUSTOMERS_PATH)
  tryDelete(SHEETS_SYNC_PATH)
  tryDelete(DATA_SOURCES_PATH)
  tryDelete(GOOGLE_UNIFIED_TOKEN_PATH)

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

// GET /api/cases/all — Non-closed support cases across ALL accounts
app.get('/api/cases/all', async (c) => {
  try {
    const allCases = await fetchCases().catch(() => [])

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

function readCCSPCache(): { records: CCSPRecord[]; cachedAt: string } | null {
  try {
    return JSON.parse(readFileSync(CCSP_CACHE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function writeCCSPCache(records: CCSPRecord[]): void {
  try {
    writeFileSync(CCSP_CACHE_PATH, JSON.stringify({ records, cachedAt: new Date().toISOString() }))
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
    const records = await fetchCCSPData()
    writeCCSPCache(records)
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

function readPipelineCache(): { records: PipelineRecord[]; cachedAt: string } | null {
  try {
    return JSON.parse(readFileSync(PIPELINE_CACHE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function writePipelineCache(records: PipelineRecord[]): void {
  try {
    writeFileSync(PIPELINE_CACHE_PATH, JSON.stringify({ records, cachedAt: new Date().toISOString() }))
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
    const records = await fetchPipelineData()
    writePipelineCache(records)
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
    const foldersRes = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 50,
    }).catch(() => ({ data: { files: [] as any[] } }))

    for (const aeFolder of (foldersRes.data.files ?? [])) {
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
  pipeline:      60 * 2,   // every 2 hours
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

// ── Full data refresh ─────────────────────────────────────────────────────────

async function refreshAll(): Promise<{ sheets: number; ccsp: boolean; pipeline: boolean; errors: string[] }> {
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
    const records = await fetchCCSPData()
    writeCCSPCache(records)
    ccspOk = true
  } catch (e: any) { errors.push(`ccsp: ${e.message}`) }

  // 3. Pipeline
  let pipelineOk = false
  try {
    const records = await fetchPipelineData()
    writePipelineCache(records)
    pipelineOk = true
  } catch (e: any) { errors.push(`pipeline: ${e.message}`) }

  console.log(`[refresh] sheets=${sheetsRefreshed}/${customers.length} ccsp=${ccspOk} pipeline=${pipelineOk} errors=${errors.length}`)
  return { sheets: sheetsRefreshed, ccsp: ccspOk, pipeline: pipelineOk, errors }
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
    const records = await fetchCCSPData()
    writeCCSPCache(records)
    console.log(`[refresh:ccsp] done`)
  } catch (e: any) {
    console.warn(`[refresh:ccsp] ${e.message}`)
  }
}

async function refreshPipeline(): Promise<void> {
  try {
    const records = await fetchPipelineData()
    writePipelineCache(records)
    console.log(`[refresh:pipeline] done`)
  } catch (e: any) {
    console.warn(`[refresh:pipeline] ${e.message}`)
  }
}

// ── Configurable timer management ─────────────────────────────────────────────

let _subscriptionsTimer: ReturnType<typeof setInterval> | null = null
let _ccspTimer: ReturnType<typeof setInterval> | null = null
let _pipelineTimer: ReturnType<typeof setInterval> | null = null

function rescheduleRefreshTimers(intervals: typeof DEFAULT_REFRESH_INTERVALS): void {
  if (_subscriptionsTimer) { clearInterval(_subscriptionsTimer); _subscriptionsTimer = null }
  if (_ccspTimer)          { clearInterval(_ccspTimer);          _ccspTimer = null }
  if (_pipelineTimer)      { clearInterval(_pipelineTimer);      _pipelineTimer = null }

  if (customers.length === 0) return

  _subscriptionsTimer = setInterval(() => refreshSubscriptions().catch(() => {}), intervals.subscriptions * 60 * 1000)
  _ccspTimer          = setInterval(() => refreshCCSP().catch(() => {}),          intervals.ccsp * 60 * 1000)
  _pipelineTimer      = setInterval(() => refreshPipeline().catch(() => {}),      intervals.pipeline * 60 * 1000)

  console.log(`[timers] subscriptions=${intervals.subscriptions}m ccsp=${intervals.ccsp}m pipeline=${intervals.pipeline}m`)
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

export default { port, fetch: app.fetch, idleTimeout: 120 }
