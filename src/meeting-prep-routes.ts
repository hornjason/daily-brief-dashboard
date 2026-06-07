/**
 * Meeting Prep Routes — HTTP Adapter
 *
 * Thin HTTP adapter for meeting prep generation.
 * All domain logic in meeting-prep-service.ts (following campaign-service.ts pattern).
 *
 * Endpoints:
 * - GET  /api/customer/:name/meetings              — calendar events for this customer
 * - GET  /api/customer/:name/meeting-prep-brief     — instant pre-meeting intelligence brief (#600)
 * - POST /api/customer/:name/meeting-prep/generate  — generate a meeting prep doc
 * - GET  /api/customer/:name/meeting-prep/history   — previously generated prep docs
 * - DELETE /api/customer/:name/meeting-prep/:index  — delete a prep doc from history
 * - POST /api/customer/:slug/meeting-debrief        — save post-meeting debrief (#611)
 * - GET  /api/customer/:slug/meeting-debriefs       — list debriefs for a customer (#611)
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
import { generateMeetingPrepBrief } from './lib/meeting-prep-intelligence.ts'
import { saveDebrief, readDebriefs, type DebriefRequest } from './meeting-debrief-service.ts'
import { CACHE_DIR } from './lib/paths.ts'

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

  // ── GET /api/customer/:name/meeting-prep-brief ──────────────────────────
  // Returns instant pre-meeting intelligence brief from the graph (#600)
  router.get('/api/customer/:name/meeting-prep-brief', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)

    try {
      const brief = await generateMeetingPrepBrief(slug, CACHE_DIR)

      if (!brief) {
        return c.json({
          error: 'No intelligence graph available for this customer. Run intelligence pipeline first.',
          customerName: customer.name,
        }, 404)
      }

      return c.json(brief)
    } catch (e: any) {
      console.error(`[meeting-prep-brief] Failed for ${customerName}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
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

    // #644: Accept audience override from query param or body
    const audienceParam = c.req.query('audience') as 'customer' | 'partner' | 'internal' | undefined
    if (audienceParam && ['customer', 'partner', 'internal'].includes(audienceParam)) {
      body.audience = audienceParam
    }

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

  // ── POST /api/customer/:name/meeting-debrief ──────────────────────────
  // Save a post-meeting debrief (Issue #611)
  router.post('/api/customer/:name/meeting-debrief', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const body = await c.req.json<DebriefRequest>()

    if (!body.notes || typeof body.notes !== 'string' || body.notes.trim().length === 0) {
      return c.json({ error: 'notes field is required and must be non-empty' }, 400)
    }

    const slug = toSlug(customer.name)

    try {
      const result = saveDebrief(slug, {
        notes: body.notes.trim(),
        talkingPointsUsed: body.talkingPointsUsed,
        nextSteps: body.nextSteps?.trim(),
      })
      return c.json(result)
    } catch (e: any) {
      console.error(`[meeting-debrief] Save failed for ${customerName}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/customer/:name/meeting-debriefs ─────────────────────────
  // List all debriefs for a customer, newest first, capped at 10 (Issue #611)
  router.get('/api/customer/:name/meeting-debriefs', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const debriefs = readDebriefs(slug, 10)
    return c.json({ debriefs })
  })

  return router
}
