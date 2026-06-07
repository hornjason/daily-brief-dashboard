/**
 * Campaign Generation API — HTTP Routes
 *
 * Thin HTTP adapter for campaign-service.ts.
 * All domain logic (Gemini prompts, signal loading, intelligence gathering)
 * lives in campaign-service.ts.
 *
 * This file handles:
 * - Request parsing (Hono context → service types)
 * - Response formatting (service results → JSON)
 * - HTTP status codes
 * - In-flight guard for duplicate requests
 */

import { Hono } from 'hono'
import { google } from 'googleapis'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import {
  generateCampaign,
  generateCampaignFromPlay,
  loadCampaignsFromCache,
  loadCampaignFromCache,
  deleteCampaignFromCache,
  extractMaterial,
  deleteMaterialCache,
  getVoiceProfile,
  detectVoiceProfile,
  type CampaignRequest,
  type CampaignResult,
  type CampaignListItem,
  type PlayContextRequest,
} from './campaign-service.ts'

// ── In-flight guard ──────────────────────────────────────────────────────────

const _campaignsInFlight = new Set<string>()


// ── Router ────────────────────────────────────────────────────────────────────

export function createCampaignsRouter(): Hono {
  const router = new Hono()

  // POST /api/customer/:name/campaigns/generate
  // Supports both materialUrl-based and playContext-based generation (#663)
  router.post('/api/customer/:name/campaigns/generate', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)

    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    let body: CampaignRequest & { playContext?: PlayContextRequest }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    // #663: Support play-based generation — playContext takes precedence over materialUrl
    const hasPlayContext = body.playContext && body.playContext.playName
    if (!hasPlayContext && (!body.materialUrl || typeof body.materialUrl !== 'string')) {
      return c.json({ error: 'materialUrl or playContext is required' }, 400)
    }

    const slug = toSlug(customer.name)
    if (_campaignsInFlight.has(slug)) {
      return c.json({ error: 'Generation already in progress for this customer' }, 409)
    }

    _campaignsInFlight.add(slug)
    try {
      const result = hasPlayContext
        ? await generateCampaignFromPlay(customer, body.playContext!, body)
        : await generateCampaign(customer, body.materialUrl, body)
      return c.json(result)
    } catch (e: any) {
      console.error(`[campaigns] Generation failed for ${customer.name}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _campaignsInFlight.delete(slug)
    }
  })

  // GET /api/customer/:name/campaigns
  router.get('/api/customer/:name/campaigns', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)

    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    const campaigns = loadCampaignsFromCache(slug)

    return c.json({ campaigns })
  })

  // POST /api/campaigns/extract-material — Extract and decompose material via Gemini
  router.post('/api/campaigns/extract-material', async (c) => {
    let body: { materialUrl: string; forceRefresh?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.materialUrl || typeof body.materialUrl !== 'string') {
      return c.json({ error: 'materialUrl is required' }, 400)
    }

    try {
      const extraction = await extractMaterial(body.materialUrl, body.forceRefresh ?? false)
      return c.json({ ...extraction, cached: !body.forceRefresh })
    } catch (e: any) {
      console.error('[campaigns] Material extraction failed:', e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // DELETE /api/campaigns/extract-material?url={encodedUrl} — Invalidate cache
  router.delete('/api/campaigns/extract-material', (c) => {
    const materialUrl = c.req.query('url')
    if (!materialUrl || typeof materialUrl !== 'string') {
      return c.json({ error: 'url query parameter is required' }, 400)
    }

    const deleted = deleteMaterialCache(decodeURIComponent(materialUrl))
    return c.json({ ok: true, deleted })
  })

  // GET /api/customer/:name/campaigns/:id/preview — Preview campaign HTML
  router.get('/api/customer/:name/campaigns/:id/preview', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const campaignId = c.req.param('id')

    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)

    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    const campaign = loadCampaignFromCache(slug, campaignId)

    if (!campaign) {
      return c.json({ error: 'Campaign not found' }, 404)
    }

    c.header('Content-Type', 'text/html')
    return c.body(campaign.htmlContent)
  })

  // DELETE /api/customer/:name/campaigns/:id — remove a campaign from cache + Drive
  router.delete('/api/customer/:name/campaigns/:id', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const campaignId = c.req.param('id')
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    const campaign = loadCampaignFromCache(slug, campaignId)

    if (!campaign) {
      return c.json({ error: 'Campaign not found' }, 404)
    }

    try {
      // Delete Google Drive files (doc + HTML)
      try {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        const driveApi = google.drive({ version: 'v3', auth })
        for (const url of [campaign.driveUrl, campaign.htmlUrl].filter(Boolean)) {
          const docIdMatch = (url as string).match(/\/d\/([a-zA-Z0-9_-]+)/)
          if (docIdMatch?.[1]) {
            await driveApi.files.delete({ fileId: docIdMatch[1], supportsAllDrives: true } as any)
            console.log(`[campaigns] Deleted Drive file: ${docIdMatch[1]}`)
          }
        }
      } catch (e: any) {
        console.warn(`[campaigns] Drive delete failed (continuing):`, e?.message ?? e)
      }

      deleteCampaignFromCache(slug, campaignId)
      return c.json({ ok: true, deleted: campaignId })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── AE Voice Profile routes (#183) ──────────────────────────────────────────

  router.get('/api/ae/:name/style-guide', async (c) => {
    const aeName = decodeURIComponent(c.req.param('name'))
    try {
      const profile = await getVoiceProfile(aeName)
      if (!profile) return c.json({ error: 'No voice profile found' }, 404)
      return c.json(profile)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.post('/api/ae/:name/style-guide/detect', async (c) => {
    const aeName = decodeURIComponent(c.req.param('name'))
    try {
      const profile = await detectVoiceProfile(aeName)
      return c.json(profile)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
