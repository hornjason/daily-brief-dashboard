/**
 * Meeting Context Module — GitHub Issue #987
 * Cross-references Calendar events + Gmail threads + Drive meeting notes
 * by attendee overlap and temporal proximity. Emits correlated signals
 * through the signal stack.
 *
 * Uses callGemini() (ADR-023) for use case extraction with responseSchema (ADR-040).
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth } from '../google.ts'
import { callGemini } from '../gemini-call.ts'
import { writeJsonAtomic } from '../lib/atomic-write.ts'
import { CACHE_DIR, CONFIG_DIR } from '../lib/paths.ts'

// ── Configuration ───────────────────────────────────────────────────────────

const MEETING_CONTEXT_CACHE_DIR = resolve(CACHE_DIR, 'meeting-context')
const CACHE_TTL_MS = 4 * 60 * 60 * 1000  // 4 hours
const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN ?? resolve(CONFIG_DIR, '.gmail-token.json')
const GCAL_TOKEN_PATH = process.env.GCAL_TOKEN ?? resolve(CONFIG_DIR, '.calendar-token.json')
const TEMPORAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000  // ±7 days

// ── Types ───────────────────────────────────────────────────────────────────

interface UseCase {
  description: string
  category: string
  source: string
  confirmationLevel: 'confirmed' | 'implied' | 'exploring'
}

interface MeetingContextCache {
  cachedAt: string
  signals: MeetingContextSignalData[]
}

interface MeetingContextSignalData {
  meetingId: string
  meetingTitle: string
  meetingDate: string
  attendeeEmails: string[]
  useCases: UseCase[]
  relatedDocs: Array<{ id: string; name: string; modifiedTime: string }>
  sourceThreadIds: string[]
  customerSlug: string
}

// ── Use case extraction schema (ADR-040) ────────────────────────────────────

const USE_CASE_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    useCases: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          description: { type: 'string' as const },
          category: { type: 'string' as const },
          source: { type: 'string' as const },
          confirmationLevel: {
            type: 'string' as const,
            enum: ['confirmed', 'implied', 'exploring'],
          },
        },
        required: ['description', 'category', 'source', 'confirmationLevel'],
      },
    },
  },
  required: ['useCases'],
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCachePath(slug: string): string {
  return resolve(MEETING_CONTEXT_CACHE_DIR, `${slug}.json`)
}

function readCache(slug: string): MeetingContextCache | null {
  const path = getCachePath(slug)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function writeCache(slug: string, data: MeetingContextCache): void {
  if (!existsSync(MEETING_CONTEXT_CACHE_DIR)) {
    mkdirSync(MEETING_CONTEXT_CACHE_DIR, { recursive: true })
  }
  writeJsonAtomic(getCachePath(slug), data)
}

function isCacheFresh(slug: string): boolean {
  const cache = readCache(slug)
  if (!cache) return false
  const age = Date.now() - new Date(cache.cachedAt).getTime()
  return age < CACHE_TTL_MS
}

/**
 * Decode base64url-encoded Gmail body parts into plain text.
 */
function extractBodyText(payload: any): string {
  if (!payload) return ''
  // Plain text part
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }
  // Multipart — recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBodyText(part)
      if (text) return text
    }
  }
  return ''
}

/**
 * Extract external (non-redhat) attendee emails from a calendar event.
 * Mirrors the pattern in proactive-meeting-prep.ts.
 */
function extractExternalAttendees(event: any): string[] {
  const attendees: any[] = event.attendees ?? []
  return attendees
    .filter((a: any) => !a.self && a.email && !a.email.endsWith('@redhat.com'))
    .map((a: any) => a.email as string)
}

/**
 * Build a Gmail query to find threads involving specific attendee emails.
 * Uses from:/to: clauses for precise matching.
 */
function buildGmailQuery(attendeeEmails: string[], newerThanDays = 90): string {
  if (attendeeEmails.length === 0) return ''
  const clauses = attendeeEmails.flatMap(email => [
    `from:${email}`,
    `to:${email}`,
  ])
  return `(${clauses.join(' OR ')}) newer_than:${newerThanDays}d`
}

/**
 * Find Drive docs modified within ±7 days of a meeting date,
 * from the customer docs cache.
 */
function findRelatedDocs(
  meetingDate: string,
  customerSlug: string,
): Array<{ id: string; name: string; modifiedTime: string }> {
  // Read customer docs cache
  const docsPath = resolve(CACHE_DIR, `${customerSlug}-docs.json`)
  if (!existsSync(docsPath)) return []

  try {
    const raw = JSON.parse(readFileSync(docsPath, 'utf-8'))
    const docs: any[] = Array.isArray(raw) ? raw : raw.data ?? raw.docs ?? []
    const meetingTime = new Date(meetingDate).getTime()

    return docs
      .filter((doc: any) => {
        if (!doc.modifiedTime) return false
        const docTime = new Date(doc.modifiedTime).getTime()
        return Math.abs(docTime - meetingTime) <= TEMPORAL_WINDOW_MS
      })
      .map((doc: any) => ({
        id: doc.id ?? doc.fileId ?? '',
        name: doc.name ?? doc.title ?? '',
        modifiedTime: doc.modifiedTime,
      }))
      .slice(0, 10)
  } catch {
    return []
  }
}

/**
 * Extract customer-stated use cases from email body text via callGemini().
 * ADR-023: all Gemini calls via callGemini().
 * ADR-040: structured output via responseSchema.
 */
async function extractUseCases(
  emailTexts: string[],
  customerName: string,
): Promise<UseCase[]> {
  if (emailTexts.length === 0) return []

  const combined = emailTexts.slice(0, 10).join('\n---\n').slice(0, 8000)

  const systemPrompt = `You are extracting customer-stated use cases from email conversations.
Only extract use cases that the CUSTOMER has stated or confirmed — not suggestions made by Red Hat.
Each use case should have a description, category (e.g., "automation", "security", "cloud migration", "modernization", "AI/ML", "observability"),
a source reference (email subject or brief context), and a confirmation level.`

  const userPrompt = `Extract customer-confirmed use cases from these email threads with ${customerName}:

${combined}

Return structured use cases. If no clear customer-stated use cases are found, return an empty array.`

  console.log(`[meeting-context] Extracting use cases for ${customerName}: ${emailTexts.length} texts, ${combined.length} chars combined`)

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'meeting-context-use-case-extraction',
      customerName,
      model: 'lite',
      responseSchema: USE_CASE_RESPONSE_SCHEMA,
    })

    const parsed = JSON.parse(result.text)
    const useCases = (parsed.useCases ?? []) as UseCase[]
    console.log(`[meeting-context] Extracted ${useCases.length} use cases for ${customerName}`)
    return useCases
  } catch (e: any) {
    console.warn(`[meeting-context] Use case extraction failed for ${customerName}: ${e.message?.slice(0, 200)}`)
    return []
  }
}

/**
 * Fetch Gmail threads involving specific attendee emails.
 * Uses the Gmail API pattern from src/google.ts:L66-96.
 */
async function fetchThreadsForAttendees(
  attendeeEmails: string[],
): Promise<Array<{ threadId: string; subject: string; bodyText: string }>> {
  if (attendeeEmails.length === 0) return []

  try {
    const auth = makeAuth(GMAIL_TOKEN_PATH)
    const gmail = google.gmail({ version: 'v1', auth })

    const query = buildGmailQuery(attendeeEmails)
    if (!query) return []

    const list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 30,
    })

    const messages = list.data.messages ?? []
    if (messages.length === 0) return []

    // Collect unique thread IDs from message results
    const threadIds = new Set<string>()
    for (const msg of messages) {
      if (msg.threadId) threadIds.add(msg.threadId)
    }

    // Fetch FULL threads (all messages in each thread) — not individual messages
    const threadResults = await Promise.all(
      [...threadIds].slice(0, 15).map(tid =>
        gmail.users.threads.get({
          userId: 'me',
          id: tid,
          format: 'full',
        }).catch(() => null)
      )
    )

    const threads: Array<{ threadId: string; subject: string; bodyText: string }> = []

    for (const result of threadResults) {
      if (!result) continue
      const thread = result.data
      const threadMessages = thread.messages ?? []
      if (threadMessages.length === 0) continue

      // Get subject from first message
      const firstHeaders = threadMessages[0].payload?.headers ?? []
      const subject = firstHeaders.find(h => h.name === 'Subject')?.value ?? ''

      // Concatenate ALL message bodies in the thread
      const allBodies: string[] = []
      for (const msg of threadMessages) {
        const body = extractBodyText(msg.payload)
        if (body) allBodies.push(body)
      }
      const fullText = allBodies.join('\n---\n')

      threads.push({
        threadId: thread.id ?? '',
        subject,
        bodyText: fullText.slice(0, 6000),
      })
    }

    return threads
  } catch (e: any) {
    console.warn(`[meeting-context] Gmail fetch failed: ${e.message}`)
    return []
  }
}

/**
 * Fetch upcoming calendar events with customer attendees.
 * Uses the Calendar API pattern from src/google.ts:L128-250.
 */
async function fetchUpcomingMeetings(): Promise<any[]> {
  try {
    const auth = makeAuth(GCAL_TOKEN_PATH)
    const calendar = google.calendar({ version: 'v3', auth })

    const now = new Date()
    const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: twoWeeksOut.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    }).catch(() => ({ data: { items: [] } }))

    return (res.data.items ?? []).filter((ev: any) => {
      // Skip declined events
      const selfAttendee = (ev.attendees ?? []).find((a: any) => a.self)
      if (selfAttendee?.responseStatus === 'declined') return false
      // Must have external attendees
      const external = extractExternalAttendees(ev)
      return external.length > 0
    })
  } catch (e: any) {
    console.warn(`[meeting-context] Calendar fetch failed: ${e.message}`)
    return []
  }
}

/**
 * Core correlation logic: for a customer slug, find upcoming meetings
 * with that customer's attendees, fetch relevant Gmail threads, find
 * related Drive docs, and extract use cases.
 */
async function correlateForCustomer(
  customerSlug: string,
): Promise<MeetingContextSignalData[]> {
  const { customers } = await import('../server-state.ts')
  const { toSlug } = await import('../cache-layer.ts')
  const customer = customers.find((c: any) => toSlug(c.name) === customerSlug)
  if (!customer) return []

  const customerDomains = [customer.domain, ...(customer.aliasDomains ?? [])].filter(Boolean) as string[]

  // Fetch upcoming meetings
  const allMeetings = await fetchUpcomingMeetings()
  console.log(`[meeting-context] ${customerSlug}: ${allMeetings.length} upcoming meetings found, domains: ${customerDomains.join(',')}`)

  // Filter to meetings with this customer's attendees
  const customerMeetings = allMeetings.filter((ev: any) => {
    const external = extractExternalAttendees(ev)
    return external.some(email => {
      const emailDomain = email.split('@')[1]?.toLowerCase() ?? ''
      return customerDomains.some(d => emailDomain.endsWith(d))
    })
  })
  console.log(`[meeting-context] ${customerSlug}: ${customerMeetings.length} meetings match customer domains`)

  if (customerMeetings.length === 0) return []

  const results: MeetingContextSignalData[] = []

  for (const meeting of customerMeetings.slice(0, 5)) {
    const attendeeEmails = extractExternalAttendees(meeting)
    const meetingDate = meeting.start?.dateTime ?? meeting.start?.date ?? new Date().toISOString()

    // Fetch Gmail threads for these specific attendees
    const threads = await fetchThreadsForAttendees(attendeeEmails)

    // Find related Drive docs within ±7 days
    const relatedDocs = findRelatedDocs(meetingDate, customerSlug)

    // Extract use cases from email thread text
    const emailTexts = threads.map(t => `Subject: ${t.subject}\n${t.bodyText}`)
    const useCases = await extractUseCases(emailTexts, customer.name)

    results.push({
      meetingId: meeting.id ?? '',
      meetingTitle: meeting.summary ?? 'Untitled Meeting',
      meetingDate,
      attendeeEmails,
      useCases,
      relatedDocs,
      sourceThreadIds: threads.map(t => t.threadId),
      customerSlug,
    })
  }

  return results
}

// ── Module Registration ─────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'meeting-context',
  displayName: 'Meeting Context Correlation',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: CACHE_TTL_MS,
  refreshEndpoint: '/api/customer/_global/modules/meeting-context/sync',

  cachePaths: (slug: string) => [getCachePath(slug)],

  async fetch(): Promise<void> {},

  async cleanup(customerName: string): Promise<void> {
    const { toSlug } = await import('../cache-layer.ts')
    const slug = toSlug(customerName)
    const path = getCachePath(slug)
    if (existsSync(path)) {
      const { unlinkSync } = await import('fs')
      unlinkSync(path)
    }
  },

  async syncNow(customerName: string): Promise<void> {
    if (!customerName || customerName === '_global') return
    const { toSlug } = await import('../cache-layer.ts')
    const slug = toSlug(customerName)

    const signalData = await correlateForCustomer(slug)
    const cache: MeetingContextCache = {
      cachedAt: new Date().toISOString(),
      signals: signalData,
    }
    writeCache(slug, cache)
    FeatureModuleRegistry.recordOutcome('meeting-context', {
      success: true,
      recordCount: signalData.length,
    })
  },

  async ensureFresh(customerSlug: string): Promise<void> {
    if (isCacheFresh(customerSlug)) return
    // Cache stale or missing — trigger refresh
    const signalData = await correlateForCustomer(customerSlug)
    const cache: MeetingContextCache = {
      cachedAt: new Date().toISOString(),
      signals: signalData,
    }
    writeCache(customerSlug, cache)
  },

  usesGemini: true,

  async signals(customerSlug: string): Promise<Signal[]> {
    const cache = readCache(customerSlug)
    if (!cache || !cache.signals || cache.signals.length === 0) return []

    return cache.signals.map(data => ({
      source: 'meeting-context' as const,
      type: 'meeting' as const,
      headline: `Customer confirmed use cases for ${data.meetingTitle}`,
      detail: data.useCases.length > 0
        ? `${data.useCases.length} use case(s): ${data.useCases.map(u => u.description).join('; ')}`
        : `Meeting with ${data.attendeeEmails.length} external attendee(s)`,
      rawRelevance: 0.75,
      timestamp: data.meetingDate,
      metadata: {
        customerSlug: data.customerSlug,
        meetingId: data.meetingId,
        meetingTitle: data.meetingTitle,
        meetingDate: data.meetingDate,
        attendeeEmails: data.attendeeEmails,
        useCases: data.useCases,
        relatedDocs: data.relatedDocs,
        sourceThreadIds: data.sourceThreadIds,
      },
    }))
  },
})
