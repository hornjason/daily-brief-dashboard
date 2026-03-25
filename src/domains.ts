import { google } from 'googleapis'
import { makeAuth } from './google.ts'
import type { Customer } from './types.ts'

// Domains that are never customer domains
const BLOCKLIST = new Set([
  'redhat.com', 'ibm.com', 'gmail.com', 'googlemail.com', 'google.com',
  'outlook.com', 'hotmail.com', 'yahoo.com', 'microsoft.com', 'live.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'salesforce.com', 'zoom.us', 'slack.com', 'dropboxmail.com',
])

function extractDomain(email: string): string | null {
  const m = email.match(/@([\w.-]+\.[a-z]{2,})$/i)
  if (!m) return null
  const d = m[1].toLowerCase()
  return BLOCKLIST.has(d) ? null : d
}

function tally(domains: (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const d of domains) {
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return counts
}

export interface DomainCandidate {
  domain: string
  count: number
  sources: ('gmail' | 'calendar')[]
}

export interface DomainInferenceResult {
  customerName: string
  candidates: DomainCandidate[]  // sorted by count desc
  currentDomain?: string
}

export async function inferCustomerDomain(
  customer: Customer,
  authPath: string,
): Promise<DomainInferenceResult> {
  const auth = makeAuth(authPath)
  const name = customer.name
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const afterStr = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`

  const gmailCounts = new Map<string, number>()
  const calCounts   = new Map<string, number>()

  // ── Gmail ────────────────────────────────────────────────────────────────────
  try {
    const gmail = google.gmail({ version: 'v1', auth })
    // Search for threads that mention this customer — cast wide net
    const q = `("${name}" OR "${name.split(' ')[0]}") after:${afterStr}`
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 50 })
    const msgs = list.data.messages ?? []

    if (msgs.length > 0) {
      const details = await Promise.all(
        msgs.map((m) =>
          gmail.users.messages.get({
            userId: 'me', id: m.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc'],
          })
        )
      )

      for (const { data } of details) {
        const headers = data.payload?.headers ?? []
        const addresses = headers
          .filter((h) => ['From', 'To', 'Cc'].includes(h.name ?? ''))
          .flatMap((h) => (h.value ?? '').split(','))
        for (const addr of addresses) {
          const d = extractDomain(addr.trim())
          if (d) gmailCounts.set(d, (gmailCounts.get(d) ?? 0) + 1)
        }
      }
    }
  } catch {}

  // ── Calendar ─────────────────────────────────────────────────────────────────
  try {
    const calendar = google.calendar({ version: 'v3', auth })
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: since.toISOString(),
      timeMax: new Date().toISOString(),
      singleEvents: true,
      maxResults: 100,
      q: name.split(' ')[0],  // search by first word for broader recall
    })

    const events = (res.data.items ?? []).filter((ev) => {
      const title = (ev.summary ?? '').toLowerCase()
      return title.includes(name.toLowerCase()) ||
             title.includes(name.split(' ')[0].toLowerCase())
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
  const allDomains = new Set([...gmailCounts.keys(), ...calCounts.keys()])
  const candidates: DomainCandidate[] = []

  for (const domain of allDomains) {
    const gc = gmailCounts.get(domain) ?? 0
    const cc = calCounts.get(domain) ?? 0
    const sources: ('gmail' | 'calendar')[] = []
    if (gc > 0) sources.push('gmail')
    if (cc > 0) sources.push('calendar')
    candidates.push({ domain, count: gc + cc, sources })
  }

  candidates.sort((a, b) => b.count - a.count)

  return {
    customerName: name,
    candidates: candidates.slice(0, 5),  // top 5 for UI
    currentDomain: customer.domain,
  }
}
