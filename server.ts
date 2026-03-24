import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { streamSSE } from 'hono/streaming'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { fetchEmail, fetchDrive, fetchCalendar } from './src/google.ts'
import { fetchCases, fetchCustomerCases, fetchCustomerSubscriptions } from './src/redhat.ts'
import { fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief } from './src/customer.ts'
import { fetchCustomerSheetData, fetchCustomerSheetRaw } from './src/sheets.ts'
import type { Customer, ProductSubscription } from './src/types.ts'

// Load customer config
const CUSTOMERS_PATH = resolve(import.meta.dir, 'config/customers.json')
let customers: Customer[] = []
try {
  customers = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8')).customers ?? []
} catch {
  console.warn('[warn] config/customers.json not found — customer filtering disabled')
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
const CACHE_DIR = resolve(import.meta.dir, 'cache')
mkdirSync(CACHE_DIR, { recursive: true })

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

// Serve landing page
app.get('/', serveStatic({ path: './public/index.html' }))

// Customer list for landing page
app.get('/customers', (c) => c.json(customers))

// ── Dashboard API endpoints ──────────────────────────────────────────────────

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
    for (const customer of customers) {
      const cached = readSheetCache(customer.name)
      if (cached) {
        for (const p of cached.rows) {
          allProductDescriptions.add(p.productDescription)
          totalLicenses += p.quantity
        }
      }
    }

    return c.json({
      openCasesTotal: allCases.length,
      sev1Count,
      meetingsToday,
      meetingsThisWeek,
      renewalsWithin90Days: 0, // TODO: implement when needed
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

// ── Customer intelligence pages ───────────────────────────────────────────────
app.get('/customer/:name', serveStatic({ path: './public/customer.html' }))

app.get('/customer/:name/events', (c) => {
  const rawName = decodeURIComponent(c.req.param('name'))
  const customer = customers.find(
    (cu) => cu.name.toLowerCase() === rawName.toLowerCase()
  )
  if (!customer) return c.text('Customer not found', 404)

  return streamSSE(c, async (stream) => {
    // Meta
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

const port = Number(process.env.PORT ?? 7777)
console.log(`\n🗂️  Daily Brief Dashboard`)
console.log(`   http://localhost:${port}`)
console.log(`   http://localhost:${port}/dashboard\n`)

export default { port, fetch: app.fetch, idleTimeout: 120 }
