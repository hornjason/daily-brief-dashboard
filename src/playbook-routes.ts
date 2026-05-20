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
import { escapeHtml, applyInlineFormatting, renderMarkdownToHtml } from './lib/markdown-to-html.ts'

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
 * Uses shared markdown-to-html utilities (GitHub Issue #311).
 */
function generatePlaybookHTML(playbook: PlaybookState): string {

  const renderActionItems = (items: typeof playbook.sections.openActionItems.items): string => {
    if (items.length === 0) return '<p style="margin:8px 0"><em>No action items</em></p>'

    return items.map(item => {
      const statusColor = item.status === 'completed' ? '#3d7317' : '#EE0000'
      const statusIcon = item.status === 'completed' ? '✓' : '○'
      return `<div style="border:1px solid #e0e0e0;border-left:4px solid ${statusColor};padding:10px 16px;margin:8px 0;border-radius:4px">
<p style="margin:0 0 4px 0"><span style="color:${statusColor};font-weight:bold">${statusIcon} ${item.status.toUpperCase()}</span></p>
<p style="margin:4px 0;font-size:10pt">${escapeHtml(item.text)}</p>
<p style="margin:4px 0 0 0;font-size:8pt;color:#707070"><strong>Owner:</strong> ${escapeHtml(item.owner)} · <strong>Created:</strong> ${new Date(item.createdAt).toLocaleDateString()}</p>
</div>`
    }).join('\n')
  }

  const renderProductAlignment = (products: typeof playbook.sections.productAlignment.products): string => {
    if (products.length === 0) return '<p style="margin:8px 0"><em>No product alignment data</em></p>'

    const confidenceColor = (c: string) => c === 'HIGH' ? '#3d7317' : c === 'MEDIUM' ? '#b8860b' : '#EE0000'

    return products.map(p => {
      let html = `<div style="border:1px solid #e0e0e0;border-left:4px solid ${confidenceColor(p.confidence)};padding:12px 16px;margin:6px 0;border-radius:4px">`
      html += `<p style="margin:0 0 6px 0"><strong style="font-size:11pt">${escapeHtml(p.displayName)}</strong> <span style="color:${confidenceColor(p.confidence)};font-weight:bold;font-size:9pt">${p.confidence}</span></p>`
      html += `<p style="margin:4px 0;font-size:10pt">${applyInlineFormatting(p.useCase)}</p>`
      if (p.proofPoints) {
        html += `<p style="margin:8px 0 4px 0;font-weight:bold;font-size:9pt">Proof Points:</p>`
        const points = p.proofPoints.split('|').map(pp => pp.trim()).filter(Boolean)
        for (const point of points) {
          const match = point.match(/^(\d+%)\s+(.+)/)
          if (match) {
            html += `<p style="margin:2px 0 2px 12px;font-size:9pt"><span style="color:#3d7317;font-weight:bold">${match[1]}</span> ${match[2]}</p>`
          } else {
            html += `<p style="margin:2px 0 2px 12px;font-size:9pt">${point}</p>`
          }
        }
      }
      if (p.lifecycle) {
        html += `<p style="margin:8px 0 0 0;font-size:9pt"><strong>Lifecycle:</strong> ${escapeHtml(p.lifecycle)}</p>`
      }
      html += `</div>`
      return html
    }).join('\n')
  }

  const renderEngagementHistory = (entries: typeof playbook.sections.engagementHistory.entries): string => {
    if (entries.length === 0) return '<p style="margin:8px 0"><em>No engagement history</em></p>'

    const typeColor = (t: string) => t === 'meeting' ? '#0066cc' : t === 'decision' ? '#3d7317' : t === 'campaign' ? '#b8860b' : '#707070'

    return entries.slice(0, 10).map(e => `<div style="border-left:3px solid ${typeColor(e.type)};padding:8px 16px;margin:8px 0">
<p style="margin:0;font-size:9pt;color:#707070"><strong>${e.date}</strong> · <span style="color:${typeColor(e.type)};font-weight:bold">${escapeHtml(e.type.toUpperCase())}</span></p>
<p style="margin:4px 0;font-size:10pt">${escapeHtml(e.summary)}</p>
${e.attendees.length ? `<p style="margin:2px 0 0 0;font-size:8pt;color:#707070">Attendees: ${e.attendees.join(', ')}</p>` : ''}
</div>`).join('\n')
  }

  const renderMEDDPICC = (section: typeof playbook.sections.meddpicc): string => {
    if (!section?.entries?.length) return '<p style="margin:8px 0"><em>No MEDDPICC data</em></p>'

    const statusColor = (s: string) => s === 'confirmed' ? '#3d7317' : s === 'developing' ? '#b8860b' : '#999'
    const statusLabel = (s: string) => s === 'confirmed' ? 'CONFIRMED' : s === 'developing' ? 'DEVELOPING' : 'UNKNOWN'

    let html = `<p style="margin:8px 0"><strong>Qualification Score: ${section.qualificationScore}%</strong> (${section.entries.filter(e => e.status === 'confirmed').length}/8 confirmed)</p>`

    html += section.entries.map(e => `<div style="border:1px solid #e0e0e0;border-left:4px solid ${statusColor(e.status)};padding:10px 16px;margin:8px 0;border-radius:4px">
<p style="margin:0 0 4px 0"><strong>${escapeHtml(e.displayName)}</strong> <span style="color:${statusColor(e.status)};font-weight:bold;font-size:9pt">${statusLabel(e.status)}</span></p>
<p style="margin:4px 0;font-size:10pt">${applyInlineFormatting(e.evidence)}</p>
</div>`).join('\n')

    return html
  }

  const renderExpansionOpportunities = (content: string): string => {
    if (!content?.trim()) return '<p style="margin:8px 0"><em>No expansion opportunities</em></p>'

    // Pre-process inline bullets — but keep Business value with its parent bullet
    const normalized = content
      .replace(/\.\s*-\s+/g, '.\n- ')
      .replace(/([^-\n])\s+-\s+/g, '$1\n- ')

    const bullets = normalized.split('\n').map(l => l.trim()).filter(l => /^[-*•]/.test(l))

    if (bullets.length === 0) return renderMarkdownToHtml(content)

    const confidenceColor = (c: string) => c === 'HIGH' ? '#3d7317' : c === 'MEDIUM' ? '#b8860b' : '#EE0000'

    return bullets.map(bullet => {
      const text = bullet.replace(/^[-*•]\s*/, '')
      const match = text.match(/^\*\*(.+?)\s*\((\w+)\):\*\*\s*(.*)/)
      if (match) {
        const [, product, confidence, rest] = match
        const bvMatch = rest.match(/^(.*?)\.\s*(?:<br><strong>)?Business value:(?:<\/strong>)?\s*(.*)$/si)
        let description = rest
        let businessValue = ''
        if (bvMatch) {
          description = bvMatch[1] + '.'
          businessValue = bvMatch[2]
        }
        let html = `<div style="border:1px solid #e0e0e0;border-left:4px solid ${confidenceColor(confidence)};padding:10px 16px;margin:8px 0;border-radius:4px">`
        html += `<p style="margin:0 0 4px 0"><strong style="font-size:11pt">${applyInlineFormatting(product)}</strong> <span style="color:${confidenceColor(confidence)};font-weight:bold;font-size:9pt">${confidence}</span></p>`
        html += `<p style="margin:4px 0;font-size:10pt">${applyInlineFormatting(description)}</p>`
        if (businessValue) {
          html += `<p style="margin:6px 0 0 0;font-size:9pt"><strong style="color:#5f0000">Business value:</strong> ${applyInlineFormatting(businessValue)}</p>`
        }
        html += `</div>`
        return html
      }
      return `<p style="margin:8px 0">${applyInlineFormatting(text)}</p>`
    }).join('\n')
  }

  const renderKeyRelationships = (content: string): string => {
    if (!content?.trim()) return '<p style="margin:8px 0"><em>No key relationships</em></p>'

    const lines = content.split('\n')
    let html = ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s-|]+\|$/.test(lines[i + 1]?.trim())) {
        // Save header row before advancing
        const headerCols = line.split('|').filter(c => c.trim()).map(c => c.trim().toLowerCase())
        const rows: string[][] = []
        i += 2
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.push(lines[i].trim().split('|').filter(c => c.trim()).map(c => c.trim()))
          i++
        }
        i--

        const isPartner = headerCols.some(h => h.includes('partner') || h.includes('specializ'))
        const sectionLabel = isPartner ? 'Certified Partners' : 'Account Team'
        html += `<p style="margin:12px 0 4px 0;font-size:9pt;color:#5f0000;font-weight:bold;text-transform:uppercase;letter-spacing:1px">${sectionLabel}</p>`

        for (const row of rows) {
          const name = row[0] ?? ''
          const role = row[1] ?? ''
          const focus = row[2] ?? ''
          html += `<p style="margin:2px 0;font-size:10pt"><strong>${applyInlineFormatting(name)}</strong> · ${applyInlineFormatting(role)}${focus ? ` — ${applyInlineFormatting(focus)}` : ''}</p>`
        }
      } else {
        html += `<p style="margin:8px 0">${applyInlineFormatting(line)}</p>`
      }
    }
    return html
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
    word-wrap: break-word;
    overflow-wrap: break-word;
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
${renderMarkdownToHtml(playbook.sections.strategicPosition.content)}

<h2>2. SWOT Analysis</h2>
${renderMarkdownToHtml(playbook.sections.swotAnalysis?.content ?? '')}

<h2>3. Key Relationships</h2>
${renderKeyRelationships(playbook.sections.keyRelationships.content)}

<h2>4. Current Priorities</h2>
${renderMarkdownToHtml(playbook.sections.currentPriorities.content)}

<h2>5. MEDDPICC Qualification</h2>
${renderMEDDPICC(playbook.sections.meddpicc)}

<h2>6. Product Alignment</h2>
${renderProductAlignment(playbook.sections.productAlignment.products)}

<h2>7. Open Action Items</h2>
${renderActionItems(playbook.sections.openActionItems.items)}

<h2>8. Engagement History</h2>
${renderEngagementHistory(playbook.sections.engagementHistory.entries)}

<h2>9. Expansion Opportunities</h2>
${renderExpansionOpportunities(playbook.sections.expansionOpportunities.content)}

<h2>10. Renewals and Risk</h2>
${renderMarkdownToHtml(playbook.sections.renewalsAndRisk.content)}

<div class="footer">Generated by PAI Intelligence — ${generatedDate}</div>
</body>
</html>`
}
