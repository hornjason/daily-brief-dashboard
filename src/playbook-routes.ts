/**
 * Playbook API Routes — GitHub Issue #293
 *
 * Hono router exposing playbook endpoints:
 * - GET  /api/customer/:name/playbook — returns playbook state or 404
 * - POST /api/customer/:name/playbook/generate — generates playbook via generatePlaybook()
 * - POST /api/playbook/generate-all — batch generate for all customers (async)
 * - GET  /api/playbook/generate-all/status — batch progress (customers done / total)
 *
 * Follows meeting-prep-routes.ts pattern for customer lookup and in-flight guards.
 * Follows batch-routes.ts pattern for batch generation with status polling.
 */

import { Hono } from 'hono'
import { google } from 'googleapis'
import { generatePlaybook, readPlaybook, ingestMeetingNotes, writePlaybook } from './playbook-generator.ts'
import type { PlaybookState } from './playbook-types.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { driveClient } from './lib/drive-client.ts'
import type { Customer } from './types.ts'
import { playbookToMarkdown } from './playbook-to-markdown.ts'

// ── In-flight guard ─────────────────────────────────────────────────────────

const _playbookInFlight = new Set<string>()

// ── Batch generation state ──────────────────────────────────────────────────

let _batchGenerateState: {
  running: boolean
  total: number
  done: number
  failed: number
  current: string | null
} = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  current: null,
}

// ── Helper: Find customer by name or slug ──────────────────────────────────

function findCustomerByNameOrSlug(nameOrSlug: string): Customer | null {
  const normalized = nameOrSlug.toLowerCase()
  return (
    customers.find((c) => c.name.toLowerCase() === normalized) ||
    customers.find((c) => toSlug(c.name) === nameOrSlug) ||
    null
  )
}

// ── Router ──────────────────────────────────────────────────────────────────

export function createPlaybookRouter(): Hono {
  const router = new Hono()

  // ── GET /api/customer/:name/playbook ───────────────────────────────────

  router.get('/api/customer/:name/playbook', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const playbook = readPlaybook(slug)

    if (!playbook) {
      return c.json({ error: `Playbook not found for customer "${customer.name}"` }, 404)
    }

    return c.json(playbook)
  })

  // ── POST /api/customer/:name/playbook/generate ─────────────────────────

  router.post('/api/customer/:name/playbook/generate', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)

    if (_playbookInFlight.has(slug)) {
      return c.json({ error: 'Playbook generation already in progress for this customer' }, 409)
    }

    _playbookInFlight.add(slug)

    try {
      const playbook = await generatePlaybook(customer)
      return c.json(playbook)
    } catch (e: any) {
      console.error(`[playbook-routes] Generation failed for ${customer.name}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _playbookInFlight.delete(slug)
    }
  })

  // ── POST /api/customer/:name/playbook/ingest-notes ─────────────────────

  router.post('/api/customer/:name/playbook/ingest-notes', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const existing = readPlaybook(slug)

    if (!existing) {
      return c.json({ error: `Playbook not found for customer "${customer.name}". Generate one first.` }, 404)
    }

    // Parse request body
    let docUrl: string
    try {
      const body = await c.req.json()
      docUrl = body.docUrl
      if (!docUrl || typeof docUrl !== 'string') {
        return c.json({ error: 'Missing required field: docUrl' }, 400)
      }
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    // Extract file ID from Google Doc URL
    const fileIdMatch = docUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)
    if (!fileIdMatch) {
      return c.json({ error: 'Invalid Google Doc URL — could not extract file ID' }, 400)
    }
    const fileId = fileIdMatch[1]

    // In-flight guard
    const ingestKey = `ingest-${slug}`
    if (_playbookInFlight.has(ingestKey)) {
      return c.json({ error: 'Note ingestion already in progress for this customer' }, 409)
    }

    _playbookInFlight.add(ingestKey)

    try {
      // Read Google Doc content via Drive API
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })

      const exportRes = await drive.files.export(
        { fileId, mimeType: 'text/plain' },
        { responseType: 'text' },
      )

      const noteContent = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data)

      if (!noteContent.trim()) {
        return c.json({ error: 'Google Doc is empty — no content to ingest' }, 400)
      }

      // Ingest notes into playbook
      const updated = await ingestMeetingNotes(existing, noteContent, docUrl)

      // Count what changed
      const newActionItems = updated.sections.openActionItems.items.length - existing.sections.openActionItems.items.length
      const newSourceEntry = updated.sources.find(s => s.type === 'meeting-note' && s.sourceId === fileId)

      return c.json({
        updated: true,
        sectionsUpdated: newSourceEntry?.sectionsUpdated ?? [],
        newActionItems,
        customerName: customer.name,
      })
    } catch (e: any) {
      console.error(`[playbook-routes] Note ingestion failed for ${customer.name}:`, e.message)

      // Distinguish Drive API errors from Gemini errors
      if (e.code === 404 || e.message?.includes('File not found')) {
        return c.json({ error: `Google Doc not found — check the URL and sharing permissions` }, 404)
      }
      if (e.code === 403 || e.message?.includes('insufficient')) {
        return c.json({ error: `Cannot access Google Doc — ensure it is shared with the service account` }, 403)
      }

      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _playbookInFlight.delete(ingestKey)
    }
  })

  // ── POST /api/customer/:name/playbook/publish ──────────────────────────

  router.post('/api/customer/:name/playbook/publish', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const playbook = readPlaybook(slug)

    if (!playbook) {
      return c.json({ error: `Playbook not found for customer "${customer.name}"` }, 404)
    }

    try {
      // Convert playbook to markdown for Google Docs API rendering (#314)
      const markdown = playbookToMarkdown(playbook)

      // Get customer Drive folder
      const customerFolderId = await findCustomerDriveFolder(customer)

      const docTitle = `${customer.name} - Engagement Playbook`

      // Use driveClient.upsertDoc which creates the doc via Docs API batchUpdate
      // instead of uploading HTML. This gives pixel-perfect rendering with native
      // tables, headings, bold/italic — no HTML re-interpretation by Google.
      const docUrl = await driveClient.upsertDoc(customerFolderId, docTitle, markdown)

      const publishedAt = new Date().toISOString()

      console.log(`[playbook-routes] Published playbook to Drive via Docs API: ${docUrl}`)

      return c.json({
        docUrl,
        publishedAt,
      })
    } catch (e: any) {
      console.error(`[playbook-routes] Publish failed for ${customer.name}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── PATCH /api/customer/:name/playbook/action-items/:id ────────────────

  router.patch('/api/customer/:name/playbook/action-items/:id', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const actionItemId = c.req.param('id')
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const playbook = readPlaybook(slug)

    if (!playbook) {
      return c.json({ error: `Playbook not found for customer "${customer.name}"` }, 404)
    }

    // Parse request body
    let status: 'open' | 'completed'
    try {
      const body = await c.req.json()
      status = body.status
      if (!status || (status !== 'open' && status !== 'completed')) {
        return c.json({ error: 'Invalid status — must be "open" or "completed"' }, 400)
      }
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    // Find action item
    const actionItem = playbook.sections.openActionItems.items.find(item => item.id === actionItemId)
    if (!actionItem) {
      return c.json({ error: `Action item not found: ${actionItemId}` }, 404)
    }

    // Update status
    actionItem.status = status
    if (status === 'completed') {
      actionItem.completedAt = new Date().toISOString()
    } else {
      actionItem.completedAt = null
    }

    // Update timestamp
    playbook.sections.openActionItems.updatedAt = new Date().toISOString()

    // Write back to disk
    writePlaybook(playbook)

    console.log(`[playbook-routes] Updated action item ${actionItemId} for ${customer.name}: status=${status}`)

    return c.json(actionItem)
  })

  // ── GET /api/customer/:name/playbook/history ───────────────────────────

  router.get('/api/customer/:name/playbook/history', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const playbook = readPlaybook(slug)

    if (!playbook) {
      return c.json({ error: `Playbook not found for customer "${customer.name}"` }, 404)
    }

    return c.json(playbook.sources)
  })

  // ── POST /api/playbook/generate-all ────────────────────────────────────

  router.post('/api/playbook/generate-all', async (c) => {
    if (_batchGenerateState.running) {
      return c.json({ error: 'Batch generation already in progress' }, 409)
    }

    // Start batch generation in the background
    _batchGenerateState = {
      running: true,
      total: customers.length,
      done: 0,
      failed: 0,
      current: null,
    }

    // Run batch asynchronously (do not await)
    ;(async () => {
      for (const customer of customers) {
        const slug = toSlug(customer.name)
        _batchGenerateState.current = customer.name

        try {
          await generatePlaybook(customer)
          _batchGenerateState.done++
        } catch (e: any) {
          console.error(`[playbook-routes] Batch generation failed for ${customer.name}:`, e.message)
          _batchGenerateState.failed++
        }

        // Rate limit delay (2s between customers to respect Gemini limits)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }

      _batchGenerateState.running = false
      _batchGenerateState.current = null
    })()

    return c.json({
      status: 'started',
      total: _batchGenerateState.total,
    })
  })

  // ── GET /api/playbook/generate-all/status ──────────────────────────────

  router.get('/api/playbook/generate-all/status', async (c) => {
    return c.json(_batchGenerateState)
  })

  return router
}

