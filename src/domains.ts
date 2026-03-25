import { google } from 'googleapis'
import { makeAuth } from './google.ts'
import type { Customer } from './types.ts'

// Domains that are never customer domains
const BLOCKLIST = new Set([
  'redhat.com', 'ibm.com', 'gmail.com', 'googlemail.com', 'google.com',
  'outlook.com', 'hotmail.com', 'yahoo.com', 'microsoft.com', 'live.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'salesforce.com', 'zoom.us', 'slack.com', 'dropboxmail.com',
  // Known false-positive tooling/partner domains
  'tableau.com', 'cisco.com', 'gdt.com', 'concursolutions.com', 'insight.com',
  'workday.com', 'servicenow.com', 'docusign.com', 'box.com', 'okta.com',
  'qualtrics.com', 'coupa.com', 'ariba.com', 'oracle.com', 'sap.com',
])

function extractDomain(email: string): string | null {
  const m = email.match(/@([\w.-]+\.[a-z]{2,})$/i)
  if (!m) return null
  const d = m[1].toLowerCase()
  return BLOCKLIST.has(d) ? null : d
}

export interface DomainCandidate {
  domain: string
  count: number
  sources: ('gmail' | 'calendar' | 'web')[]
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

  const webDomains: string[] = []
  const gmailCounts = new Map<string, number>()
  const calCounts   = new Map<string, number>()

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

  // ── 2. Gmail — From domain only, Subject must contain customer name ──────────
  try {
    const gmail = google.gmail({ version: 'v1', auth })
    const nameTermsQuoted = [name, ...(customer.aliases ?? [])].map((n) => `"${n}"`).join(' OR ')
    const q = `(${nameTermsQuoted}) after:${afterStr}`
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 50 })
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

        const d = extractDomain(from)
        if (d) gmailCounts.set(d, (gmailCounts.get(d) ?? 0) + 1)
      }
    }
  } catch {}

  // ── 3. Calendar — attendee domains ───────────────────────────────────────────
  try {
    const calendar = google.calendar({ version: 'v3', auth })
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: since.toISOString(),
      timeMax: new Date().toISOString(),
      singleEvents: true,
      maxResults: 100,
      q: name,
    })

    const events = (res.data.items ?? []).filter((ev) => {
      const title = (ev.summary ?? '').toLowerCase()
      return nameTerms.some((t) => title.includes(t))
    })

    for (const ev of events) {
      const attendees = (ev.attendees ?? [])
        .map((a) => a.email ?? '')
        .filter((e) => !e.endsWith('@redhat.com') && !e.includes('resource.calendar'))
      for (const email of attendees) {
        const d = extractDomain(email)
        if (d) calCounts.set(d, (calCounts.get(d) ?? 0) + 1)
      }
    }
  } catch {}

  // ── Merge + rank ─────────────────────────────────────────────────────────────
  // Strategy: confirmed (web + signal) > web only > signal only
  const allSignalDomains = new Set([...gmailCounts.keys(), ...calCounts.keys()])
  const candidates: DomainCandidate[] = []

  // Web candidates first — add signal counts if they happen to match
  for (const domain of webDomains) {
    const gc = gmailCounts.get(domain) ?? 0
    const cc = calCounts.get(domain) ?? 0
    const sources: ('gmail' | 'calendar' | 'web')[] = ['web']
    if (gc > 0) sources.push('gmail')
    if (cc > 0) sources.push('calendar')
    candidates.push({ domain, count: gc + cc, sources })
    allSignalDomains.delete(domain)  // don't double-count
  }

  // Remaining signal-only candidates (not in web results)
  for (const domain of allSignalDomains) {
    const gc = gmailCounts.get(domain) ?? 0
    const cc = calCounts.get(domain) ?? 0
    const sources: ('gmail' | 'calendar' | 'web')[] = []
    if (gc > 0) sources.push('gmail')
    if (cc > 0) sources.push('calendar')
    candidates.push({ domain, count: gc + cc, sources })
  }

  // Sort: confirmed (web + signal) first, then by count
  candidates.sort((a, b) => {
    const aConfirmed = a.sources.includes('web') && a.count > 0 ? 1 : 0
    const bConfirmed = b.sources.includes('web') && b.count > 0 ? 1 : 0
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
