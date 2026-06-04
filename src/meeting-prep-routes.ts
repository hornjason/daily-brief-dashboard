/**
 * Meeting Prep Routes — HTTP Adapter
 *
 * Thin HTTP adapter for meeting prep generation.
 * All domain logic in meeting-prep-service.ts (following campaign-service.ts pattern).
 *
 * Endpoints:
 * - GET  /api/customer/:name/meetings              — calendar events for this customer
 * - POST /api/customer/:name/meeting-prep/generate  — generate a meeting prep doc
 * - POST /api/customer/:name/meeting-prep-email     — draft email from talking points (#610)
 * - GET  /api/customer/:name/meeting-prep/history   — previously generated prep docs
 * - DELETE /api/customer/:name/meeting-prep/:index  — delete a prep doc from history
 */

import { Hono } from 'hono'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { google } from 'googleapis'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { fetchCalendar, makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { fetchCustomerMeetings } from './customer.ts'
import type { Customer } from './types.ts'
import {
  generateMeetingPrep,
  readHistory,
  getHistoryPath,
  getPrepCacheDir,
  type MeetingPrepRequest,
} from './meeting-prep-service.ts'
import { runProactivePrepScan, readAttendeeCache } from './proactive-meeting-prep.ts'
import { callGemini } from './gemini-call.ts'

// ── In-flight guard ──────────────────────────────────────────────────────────

const _prepInFlight = new Set<string>()

// ── Route factory ────────────────────────────────────────────────────────────

function findCustomerByNameOrSlug(name: string): Customer | undefined {
  const lower = name.toLowerCase()
  return customers.find(cu => cu.name.toLowerCase() === lower) ??
    customers.find(cu => toSlug(cu.name) === lower)
}

export function createMeetingPrepRouter() {
  const router = new Hono()

  // ── GET /api/customer/:name/meetings ────────────────────────────────────
  // Returns meetings filtered to this customer + all meetings for "browse all"
  router.get('/api/customer/:name/meetings', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    try {
      // Fetch customer-specific meetings and all calendar events in parallel
      const [customerMeetings, allEvents] = await Promise.all([
        fetchCustomerMeetings(customer),
        fetchCalendar(customers, true),
      ])

      return c.json({
        meetings: customerMeetings,
        allMeetings: allEvents,
      })
    } catch (e: any) {
      console.error(`[meeting-prep] Failed to fetch meetings for ${customerName}:`, e.message)
      return c.json({ meetings: [], allMeetings: [], error: sanitizeErr(e) }, 500)
    }
  })

  // ── POST /api/customer/:name/meeting-prep/generate ──────────────────────
  router.post('/api/customer/:name/meeting-prep/generate', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const body = await c.req.json<MeetingPrepRequest>()

    if (!body.meetingTitle || !body.meetingStart) {
      return c.json({ error: 'meetingTitle and meetingStart are required' }, 400)
    }

    const slug = toSlug(customer.name)
    const guardKey = `${slug}:${body.meetingTitle}:${body.meetingStart}`

    if (_prepInFlight.has(guardKey)) {
      return c.json({ error: 'Meeting prep generation already in progress for this meeting' }, 409)
    }

    _prepInFlight.add(guardKey)

    try {
      const result = await generateMeetingPrep(customer, body)
      return c.json(result)
    } catch (e: any) {
      console.error(`[meeting-prep] Generation failed for ${customerName}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _prepInFlight.delete(guardKey)
    }
  })

  // ── POST /api/customer/:name/meeting-prep-email ─────────────────────────
  // Draft a pre-meeting outreach email from talking points + evidence (#610)
  router.post('/api/customer/:name/meeting-prep-email', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const body = await c.req.json<{
      talkingPoints: string[]
      evidence: string[]
      customerName: string
    }>()

    if (!body.talkingPoints?.length) {
      return c.json({ error: 'talkingPoints array is required and must not be empty' }, 400)
    }

    const systemPrompt = `You are a sales professional writing a brief pre-meeting email to a customer contact.
Reference specific facts from the evidence provided. Professional but warm tone. Under 150 words.
Do NOT include a subject line — just the email body.
Start with a greeting, reference 1-2 specific points that show you've done your homework, and end with a clear ask or next step.`

    const userPrompt = `## Customer: ${body.customerName || customer.name}

## Talking Points:
${body.talkingPoints.map((tp, i) => `${i + 1}. ${tp}`).join('\n')}

## Evidence to Reference:
${(body.evidence ?? []).map((ev, i) => `- ${ev}`).join('\n') || 'No specific evidence provided.'}

Write a concise pre-meeting outreach email for this customer contact.`

    try {
      const result = await callGemini(systemPrompt, userPrompt, {
        callType: 'meeting-prep-email',
        customerName: customer.name,
        temperature: 0.7,
      })

      if (!result.text) {
        return c.json({ error: 'Gemini returned empty response' }, 500)
      }

      return c.json({ email: result.text })
    } catch (e: any) {
      console.error(`[meeting-prep-email] Failed for ${customerName}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/customer/:name/meeting-prep/history ────────────────────────
  router.get('/api/customer/:name/meeting-prep/history', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const history = readHistory(slug).map(entry => ({
      ...entry,
      customerName: entry.customerName || customer.name,
    }))

    return c.json({ history })
  })

  // ── DELETE /api/customer/:name/meeting-prep/:index ─────────────────────
  // Removes a prep doc from history and optionally deletes the Google Drive file
  router.delete('/api/customer/:name/meeting-prep/:index', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const index = parseInt(c.req.param('index'))
    const slug = toSlug(customer.name)
    const history = readHistory(slug)

    if (isNaN(index) || index < 0 || index >= history.length) {
      return c.json({ error: 'Invalid history index' }, 400)
    }

    const entry = history[index]

    // Delete from Google Drive if docUrl exists
    if (entry.docUrl) {
      try {
        // Extract doc ID from URL
        const docIdMatch = entry.docUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)
        if (docIdMatch?.[1]) {
          const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.delete({ fileId: docIdMatch[1], supportsAllDrives: true } as any)
          console.log(`[meeting-prep] Deleted Drive doc: ${docIdMatch[1]}`)
        }
      } catch (e: any) {
        console.warn(`[meeting-prep] Drive delete failed (continuing):`, e?.message ?? e)
        // Continue to remove from history even if Drive delete fails
      }
    }

    // Remove from history — use writeFileSync directly because writeJsonAtomic's
    // stale-overwrite guard blocks writing [] to a non-empty file (legitimate delete of last entry)
    history.splice(index, 1)
    const dir = getPrepCacheDir(slug)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(getHistoryPath(slug), JSON.stringify(history, null, 2), { mode: 0o600 })

    return c.json({ deleted: true, remaining: history.length })
  })

  // ── POST /api/meeting-prep/scan ──────────────────────────────────────────
  // Trigger proactive meeting prep scan manually (Issue #195)
  router.post('/api/meeting-prep/scan', async (c) => {
    try {
      const result = await runProactivePrepScan(
        () => fetchCalendar(customers, true),
        customers,
        (customer, meeting) => generateMeetingPrep(customer, meeting),
        (slug) => readHistory(slug),
        (name) => toSlug(name),
      )
      return c.json(result)
    } catch (e: any) {
      console.error('[meeting-prep] Scan failed:', e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/customer/:name/attendees ──────────────────────────────────
  // Returns cached attendee profiles for this customer (Issue #195)
  router.get('/api/customer/:name/attendees', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const attendees = readAttendeeCache(slug)
    return c.json({ attendees })
  })

  return router
}
