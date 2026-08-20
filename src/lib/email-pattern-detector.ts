import { google } from 'googleapis'
import { resolve } from 'path'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'
import { CONFIG_DIR } from './paths.ts'

export interface EmailPattern {
  format: 'first.last' | 'flast' | 'firstl' | 'first' | 'last.first' | 'unknown'
  confidence: number
  sampleEmails: string[]
  source: 'gmail' | 'calendar' | 'both'
}

const GCAL_TOKEN_PATH = process.env.GCAL_TOKEN ?? resolve(CONFIG_DIR, '.calendar-token.json')

const NON_PERSONAL = /^(info|support|sales|admin|contact|noreply|no-reply|no\.reply|help|team|hello|marketing|hr|billing|accounts?|office|reception|webmaster|postmaster|abuse|security|careers|jobs|press|media|events|newsletter|notifications?|updates?|feedback|service|customerservice)$/

function isPersonalEmail(local: string): boolean {
  return !NON_PERSONAL.test(local) && !/\d/.test(local) && local.length >= 3
}

function classifyLocalPart(local: string): EmailPattern['format'] {
  const lower = local.toLowerCase()
  if (!isPersonalEmail(lower)) return 'unknown'
  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(lower)) return 'first.last'
  if (/^[a-z]+$/.test(lower) && lower.length >= 4 && lower.length <= 15) return 'flast'
  return 'unknown'
}

export function generateEmailFromPattern(
  firstName: string,
  lastName: string,
  domain: string,
  pattern: EmailPattern | null,
): { email: string; emailSource: 'gmail' | 'calendar' | 'inferred' } {
  if (pattern && pattern.confidence >= 0.5 && pattern.format !== 'unknown') {
    let email: string
    switch (pattern.format) {
      case 'first.last':
        email = `${firstName}.${lastName}@${domain}`
        break
      case 'last.first':
        email = `${lastName}.${firstName}@${domain}`
        break
      case 'firstl':
        email = `${firstName}${lastName[0]}@${domain}`
        break
      case 'first':
        email = `${firstName}@${domain}`
        break
      case 'flast':
      default:
        email = `${firstName[0]}${lastName}@${domain}`
        break
    }
    const emailSource = pattern.source === 'both' ? 'gmail' : pattern.source
    return { email, emailSource }
  }
  return { email: `${firstName[0]}${lastName}@${domain}`, emailSource: 'inferred' }
}

async function searchGmailForDomain(domain: string): Promise<string[]> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const gmail = google.gmail({ version: 'v1', auth })
    const query = `from:@${domain} OR to:@${domain}`
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20,
    })
    const messages = listRes.data.messages ?? []
    if (messages.length === 0) return []

    const emails = new Set<string>()
    const details = await Promise.all(
      messages.slice(0, 20).map(msg =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc'],
        })
      )
    )
    for (const { data } of details) {
      const headers = data.payload?.headers ?? []
      for (const h of headers) {
        if (!h.value) continue
        const matches = h.value.match(/[\w.+-]+@[\w.-]+/g) ?? []
        for (const match of matches) {
          if (match.toLowerCase().endsWith(`@${domain}`)) {
            emails.add(match.toLowerCase())
          }
        }
      }
    }
    return [...emails]
  } catch (e: any) {
    console.warn(`[email-pattern-detector] Gmail search failed for ${domain}:`, e?.message ?? e)
    return []
  }
}

async function searchCalendarForDomain(domain: string): Promise<string[]> {
  try {
    let auth
    try {
      auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    } catch {
      auth = makeAuth(GCAL_TOKEN_PATH)
    }
    const calendar = google.calendar({ version: 'v3', auth })
    const now = new Date()
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: ninetyDaysAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      maxResults: 100,
    })

    const emails = new Set<string>()
    for (const event of res.data.items ?? []) {
      for (const attendee of event.attendees ?? []) {
        if (attendee.email?.toLowerCase().endsWith(`@${domain}`)) {
          emails.add(attendee.email.toLowerCase())
        }
      }
    }
    return [...emails]
  } catch (e: any) {
    console.warn(`[email-pattern-detector] Calendar search failed for ${domain}:`, e?.message ?? e)
    return []
  }
}

export async function detectEmailPattern(domain: string, companyName: string): Promise<EmailPattern | null> {
  const [gmailEmails, calendarEmails] = await Promise.all([
    searchGmailForDomain(domain),
    searchCalendarForDomain(domain),
  ])

  const allEmails = [...new Set([...gmailEmails, ...calendarEmails])]
  if (allEmails.length === 0) return null

  const source: EmailPattern['source'] =
    gmailEmails.length > 0 && calendarEmails.length > 0 ? 'both' :
    gmailEmails.length > 0 ? 'gmail' : 'calendar'

  const formatCounts = new Map<EmailPattern['format'], number>()
  const personalEmails: string[] = []

  for (const email of allEmails) {
    const local = email.split('@')[0]
    if (!isPersonalEmail(local)) continue
    personalEmails.push(email)
    const format = classifyLocalPart(local)
    if (format !== 'unknown') {
      formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1)
    }
  }

  if (personalEmails.length === 0) return null
  if (formatCounts.size === 0) {
    return { format: 'unknown', confidence: 0, sampleEmails: personalEmails.slice(0, 5), source }
  }

  let dominantFormat: EmailPattern['format'] = 'unknown'
  let maxCount = 0
  for (const [format, count] of formatCounts) {
    if (count > maxCount) {
      maxCount = count
      dominantFormat = format
    }
  }

  const confidence = maxCount / personalEmails.length

  console.log(`[email-pattern-detector] ${domain}: ${dominantFormat} (confidence ${confidence.toFixed(2)}, ${personalEmails.length} personal emails from ${source})`)

  return {
    format: dominantFormat,
    confidence,
    sampleEmails: personalEmails.slice(0, 5),
    source,
  }
}
