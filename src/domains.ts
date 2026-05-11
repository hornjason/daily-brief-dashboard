import { google } from 'googleapis'
import { makeAuth } from './google.ts'
import type { Customer } from './types.ts'
import { isPrimaryCalendarEvent } from './calendar-filter.ts'

// Extract all email domains from a flat array of cell values
export function extractDomainsFromCells(cells: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const cell of cells) {
    const emails = cell.match(/[a-zA-Z0-9._%+\-]+@([\w.-]+\.[a-z]{2,})/gi) ?? []
    for (const email of emails) {
      const d = extractDomain(email)
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
    }
  }
  return counts
}

// Domains that are never customer domains
export const BLOCKLIST = new Set([
  'redhat.com', 'ibm.com', 'gmail.com', 'googlemail.com', 'google.com',
  'outlook.com', 'hotmail.com', 'yahoo.com', 'microsoft.com', 'live.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'salesforce.com', 'zoom.us', 'slack.com', 'dropboxmail.com',
  // Known false-positive tooling/partner domains
  'tableau.com', 'cisco.com', 'gdt.com', 'concursolutions.com', 'insight.com',
  'servicenow.com', 'docusign.com', 'box.com', 'okta.com',
  'qualtrics.com', 'coupa.com', 'ariba.com', 'oracle.com', 'sap.com',
])

export function extractDomain(email: string, domainOverride?: string): string | null {
  const m = email.match(/@([\w.-]+\.[a-z]{2,})$/i)
  if (!m) return null
  const d = m[1].toLowerCase()
  // BKL-F05: customer-level override bypasses blocklist (e.g. workday.com for Workday Inc)
  if (domainOverride && d === domainOverride.toLowerCase()) return d
  return BLOCKLIST.has(d) ? null : d
}

/** BKL-F05: Whether a DomainCandidate is high-confidence (auto-save eligible). */
export function isHighConfidenceDomain(c: DomainCandidate): boolean {
  return c.sources.includes('web') && (c.sources.includes('calendar') || c.sources.includes('gmail') || c.sources.includes('supportable'))
}

export interface DomainCandidate {
  domain: string
  count: number
  sources: ('supportable' | 'gmail' | 'calendar' | 'web')[]
}

export interface DomainInferenceResult {
  customerName: string
  candidates: DomainCandidate[]  // sorted: confirmed > web-only > signal-only
  currentDomain?: string
}

export async function inferCustomerDomain(
  customer: Customer,
  authPath: string,
): Promise<DomainInferenceResult> {
  const auth = makeAuth(authPath)
  const name = customer.name
  const nameTerms = [name, ...(customer.aliases ?? [])].map((n) => n.toLowerCase())
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const afterStr = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`

  const supportableCounts = new Map<string, number>()
  const webDomains: string[] = []
  const gmailCounts = new Map<string, number>()
  const calCounts   = new Map<string, number>()

  // ── 0. Supportable sheet — customer's own tab has real contact emails ─────────
  if (customer.supportableFileId) {
    try {
      const sheets = google.sheets({ version: 'v4', auth })
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: customer.supportableFileId,
        fields: 'sheets.properties.title',
      })
      const tabs = (meta.data.sheets ?? []).map((s: any) => s.properties?.title as string)
      // Find the tab whose name best matches the customer name
      const customerTab = tabs.find((t) =>
        t.toLowerCase() === name.toLowerCase() ||
        nameTerms.some((term) => t.toLowerCase().includes(term))
      )
      if (customerTab) {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: customer.supportableFileId,
          range: customerTab,
        })
        const cells = (res.data.values ?? []).flat().map(String)
        const found = extractDomainsFromCells(cells)
        for (const [d, c] of found) supportableCounts.set(d, (supportableCounts.get(d) ?? 0) + c)
      }
    } catch {}
  }

  // ── 1. Web search (Clearbit) — always runs ───────────────────────────────────
  const cleanName = name
    .replace(/,?\s+(INC|LLC|LTD|CORP|CORPORATION|INCORPORATED|LIMITED|CO|GROUP|HOLDINGS|INTERNATIONAL|TECHNOLOGIES|LOGISTICS|SOLUTIONS|SERVICES|FOODS|SYSTEMS|GLOBAL|NETWORKS|SOFTWARE)\.?$/i, '')
    .trim()

  const clearbitQueries = [...new Set([cleanName, name, ...(customer.aliases ?? [])])].slice(0, 4)

  for (const q of clearbitQueries) {
    try {
      const res = await fetch(
        `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
      )
      if (res.ok) {
        const hits: { name: string; domain: string }[] = await res.json()
        for (const hit of hits.slice(0, 3)) {
          if (hit.domain && !BLOCKLIST.has(hit.domain) && !webDomains.includes(hit.domain)) {
            webDomains.push(hit.domain)
          }
        }
      }
    } catch {}
    if (webDomains.length >= 3) break
  }

  // ── 2. Gmail — skip if Supportable already found a confident domain ──────────
  // Supportable emails are highest-quality signal — skip Gmail + Calendar when found.
  const skipSignalSearch = supportableCounts.size > 0

  if (!skipSignalSearch) try {
    const gmail = google.gmail({ version: 'v1', auth })
    const nameTermsQuoted = [name, ...(customer.aliases ?? [])].map((n) => `"${n}"`).join(' OR ')
    const q = `(${nameTermsQuoted}) after:${afterStr}`
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 15 })
    const msgs = list.data.messages ?? []

    if (msgs.length > 0) {
      const details = await Promise.all(
        msgs.map((m) =>
          gmail.users.messages.get({
            userId: 'me', id: m.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject'],
          })
        )
      )

      for (const { data } of details) {
        const headers = data.payload?.headers ?? []
        const subject = headers.find((h) => h.name === 'Subject')?.value?.toLowerCase() ?? ''
        const from    = headers.find((h) => h.name === 'From')?.value ?? ''

        // Only count if subject actually references the customer
        if (!nameTerms.some((t) => subject.includes(t))) continue

        const d = extractDomain(from, customer.domainOverride)
        if (d) gmailCounts.set(d, (gmailCounts.get(d) ?? 0) + 1)
      }
    }
  } catch {}

  // ── 3. Calendar — attendee domains ───────────────────────────────────────────
  if (!skipSignalSearch) try {
    const calendar = google.calendar({ version: 'v3', auth })
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: since.toISOString(),
      timeMax: new Date().toISOString(),
      singleEvents: true,
      maxResults: 100,
      q: name,
    })

    const events = (res.data.items ?? [])
      .filter(isPrimaryCalendarEvent) // Exclude subscribed/shared calendar events (issue #94)
      .filter((ev) => {
        const title = (ev.summary ?? '').toLowerCase()
        return nameTerms.some((t) => title.includes(t))
    })

    for (const ev of events) {
      const attendees = (ev.attendees ?? [])
        .map((a) => a.email ?? '')
        .filter((e) => !e.endsWith('@redhat.com') && !e.includes('resource.calendar'))
      for (const email of attendees) {
        const d = extractDomain(email, customer.domainOverride)
        if (d) calCounts.set(d, (calCounts.get(d) ?? 0) + 1)
      }
    }
  } catch {}

  // ── Merge + rank ─────────────────────────────────────────────────────────────
  // Priority: supportable (direct contact emails) > web+signal confirmed > web only > signal only
  const allDomains = new Set([
    ...supportableCounts.keys(),
    ...webDomains,
    ...gmailCounts.keys(),
    ...calCounts.keys(),
  ])
  const candidates: DomainCandidate[] = []

  for (const domain of allDomains) {
    const sc = supportableCounts.get(domain) ?? 0
    const gc = gmailCounts.get(domain) ?? 0
    const cc = calCounts.get(domain) ?? 0
    const wc = webDomains.includes(domain) ? 1 : 0
    const sources: DomainCandidate['sources'] = []
    if (sc > 0) sources.push('supportable')
    if (wc > 0) sources.push('web')
    if (gc > 0) sources.push('gmail')
    if (cc > 0) sources.push('calendar')
    candidates.push({ domain, count: sc + gc + cc, sources })
  }

  // Sort: supportable first, then web+signal confirmed, then web only, then signal only
  candidates.sort((a, b) => {
    const aS = a.sources.includes('supportable') ? 3 : 0
    const bS = b.sources.includes('supportable') ? 3 : 0
    if (aS !== bS) return bS - aS
    const aConfirmed = a.sources.includes('web') && a.count > 0 ? 2 : 0
    const bConfirmed = b.sources.includes('web') && b.count > 0 ? 2 : 0
    if (aConfirmed !== bConfirmed) return bConfirmed - aConfirmed
    const aWeb = a.sources.includes('web') ? 1 : 0
    const bWeb = b.sources.includes('web') ? 1 : 0
    if (aWeb !== bWeb) return bWeb - aWeb
    return b.count - a.count
  })

  return {
    customerName: name,
    candidates: candidates.slice(0, 5),
    currentDomain: customer.domain,
  }
}
