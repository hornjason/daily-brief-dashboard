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
import { Readable } from 'stream'
import { generatePlaybook, readPlaybook, ingestMeetingNotes, writePlaybook } from './playbook-generator.ts'
import type { PlaybookState } from './playbook-types.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { driveClient } from './lib/drive-client.ts'
import type { Customer } from './types.ts'

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
      // Convert playbook markdown to HTML
      const htmlContent = generatePlaybookHTML(playbook)

      // Get customer Drive folder
      const customerFolderId = await findCustomerDriveFolder(customer)

      // Create Google Doc in customer folder
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })
      const DOC_MIME = 'application/vnd.google-apps.document'
      const docTitle = `${customer.name} - Engagement Playbook`

      // Delete existing docs with same name (upsert pattern)
      const existing = await drive.files.list({
        q: `'${customerFolderId}' in parents and name = '${docTitle.replace(/'/g, "\\'")}' and mimeType = '${DOC_MIME}' and trashed = false`,
        fields: 'files(id)',
        pageSize: 10,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      for (const f of existing.data.files ?? []) {
        if (f.id) await drive.files.delete({ fileId: f.id, supportsAllDrives: true } as any)
      }

      // Create Google Doc from HTML
      const docResponse = await drive.files.create({
        requestBody: {
          name: docTitle,
          mimeType: DOC_MIME,
          parents: [customerFolderId],
        },
        media: {
          mimeType: 'text/html',
          body: Readable.from(Buffer.from(htmlContent)),
        },
        fields: 'id,webViewLink',
        supportsAllDrives: true,
      })

      const docUrl = docResponse.data.webViewLink ?? `https://docs.google.com/document/d/${docResponse.data.id}/edit`
      const publishedAt = new Date().toISOString()

      console.log(`[playbook-routes] Published playbook to Drive: ${docUrl}`)

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

// ── HTML Generation Helper ─────────────────────────────────────────────────

/**
 * Convert playbook state to styled HTML for Google Docs import.
 * Follows meeting-prep-html-template.ts pattern with Red Hat branding.
 */
function generatePlaybookHTML(playbook: PlaybookState): string {
  const escapeHtml = (text: string): string => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  const applyInlineFormatting = (text: string): string => {
    let result = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>')
    result = result.replace(/(?<!https?:\/\/[^\s]*)\*([^*]+)\*/g, '<em>$1</em>')
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0066cc">$1</a>')
    return result
  }

  const renderContent = (content: string): string => {
    const lines = content.split('\n')
    const result: string[] = []
    let i = 0

    while (i < lines.length) {
      const trimmed = lines[i].trim()
      if (!trimmed) { i++; continue }

      // Detect markdown table blocks
      if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s-|]+\|$/.test(lines[i + 1]?.trim())) {
        const tableLines: string[] = []
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tableLines.push(lines[i].trim())
          i++
        }
        const headerCells = tableLines[0].split('|').filter(c => c.trim()).map(c => applyInlineFormatting(c.trim()))
        const dataRows = tableLines.slice(2).map(row => row.split('|').filter(c => c.trim()).map(c => applyInlineFormatting(c.trim())))
        result.push(`<table><tr>${headerCells.map(c => `<th>${c}</th>`).join('')}</tr>${dataRows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`)
        continue
      }

      if (/^[-*•]\s+/.test(trimmed)) {
        result.push(`<li>${applyInlineFormatting(trimmed.replace(/^[-*•]\s+/, ''))}</li>`)
      } else {
        result.push(`<p style="margin:8px 0">${applyInlineFormatting(trimmed)}</p>`)
      }
      i++
    }
    return result.join('\n')
  }

  const renderActionItems = (items: typeof playbook.sections.openActionItems.items): string => {
    if (items.length === 0) return '<p style="margin:8px 0"><em>No action items</em></p>'

    return `<table>
<tr><th>Action</th><th>Owner</th><th>Status</th><th>Created</th></tr>
${items.map(item => `<tr>
  <td>${escapeHtml(item.text)}</td>
  <td>${escapeHtml(item.owner)}</td>
  <td><span class="badge-${item.status === 'completed' ? 'new' : 'urgent'}">${item.status.toUpperCase()}</span></td>
  <td>${new Date(item.createdAt).toLocaleDateString()}</td>
</tr>`).join('\n')}
</table>`
  }

  const renderProductAlignment = (products: typeof playbook.sections.productAlignment.products): string => {
    if (products.length === 0) return '<p style="margin:8px 0"><em>No product alignment data</em></p>'

    return `<table>
<tr><th>Product</th><th>Confidence</th><th>Use Case</th></tr>
${products.map(p => `<tr>
  <td><strong>${escapeHtml(p.displayName)}</strong></td>
  <td><span class="badge-${p.confidence === 'HIGH' ? 'new' : p.confidence === 'MEDIUM' ? 'info' : 'urgent'}">${p.confidence}</span></td>
  <td>${escapeHtml(p.useCase)}</td>
</tr>`).join('\n')}
</table>`
  }

  const renderEngagementHistory = (entries: typeof playbook.sections.engagementHistory.entries): string => {
    if (entries.length === 0) return '<p style="margin:8px 0"><em>No engagement history</em></p>'

    return `<table>
<tr><th>Date</th><th>Type</th><th>Summary</th><th>Attendees</th></tr>
${entries.slice(0, 10).map(e => `<tr>
  <td>${e.date}</td>
  <td>${escapeHtml(e.type)}</td>
  <td>${escapeHtml(e.summary)}</td>
  <td>${e.attendees.join(', ')}</td>
</tr>`).join('\n')}
</table>`
  }

  const generatedDate = new Date(playbook.generatedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10pt;
    color: #333;
    line-height: 1.5;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
  }
  h1 {
    font-size: 16pt;
    color: #333;
    margin-bottom: 4px;
  }
  .subtitle {
    font-size: 10pt;
    color: #707070;
    margin-bottom: 20px;
  }
  h2 {
    font-size: 14pt;
    color: #EE0000;
    border-bottom: 2px solid #EE0000;
    padding-bottom: 6px;
    margin-top: 28px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
    font-size: 9pt;
  }
  th {
    background-color: #5f0000;
    color: white;
    font-weight: bold;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid #5f0000;
  }
  td {
    padding: 8px 10px;
    border: 1px solid #e0e0e0;
    vertical-align: top;
  }
  tr:nth-child(even) td {
    background-color: #f2f2f2;
  }
  tr:nth-child(odd) td {
    background-color: #ffffff;
  }
  ul {
    padding-left: 20px;
    margin: 8px 0;
  }
  li {
    margin-bottom: 4px;
  }
  .badge-urgent {
    color: #EE0000;
    font-weight: bold;
  }
  .badge-new {
    color: #3d7317;
    font-weight: bold;
  }
  .badge-info {
    color: #0066cc;
    font-weight: bold;
  }
  .footer {
    font-size: 8pt;
    color: #a3a3a3;
    margin-top: 30px;
    border-top: 1px solid #e0e0e0;
    padding-top: 8px;
  }
</style>
</head>
<body>
<h1>Customer Engagement Playbook: ${escapeHtml(playbook.customerName)}</h1>
<div class="subtitle"><strong>Generated:</strong> ${generatedDate}</div>

<h2>1. Strategic Position</h2>
${renderContent(playbook.sections.strategicPosition.content)}

<h2>2. Key Relationships</h2>
${renderContent(playbook.sections.keyRelationships.content)}

<h2>3. Current Priorities</h2>
${renderContent(playbook.sections.currentPriorities.content)}

<h2>4. Product Alignment</h2>
${renderProductAlignment(playbook.sections.productAlignment.products)}

<h2>5. Open Action Items</h2>
${renderActionItems(playbook.sections.openActionItems.items)}

<h2>6. Engagement History</h2>
${renderEngagementHistory(playbook.sections.engagementHistory.entries)}

<h2>7. Expansion Opportunities</h2>
${renderContent(playbook.sections.expansionOpportunities.content)}

<h2>8. Renewals and Risk</h2>
${renderContent(playbook.sections.renewalsAndRisk.content)}

<div class="footer">Generated by PAI Intelligence — ${generatedDate}</div>
</body>
</html>`
}
