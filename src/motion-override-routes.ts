/**
 * src/motion-override-routes.ts
 * Motion Override API Routes — GitHub Issue #520
 *
 * POST endpoints for user motion overrides: custom assets, dismiss, pin, undismiss.
 * Follows the established createXRouter(): Hono factory pattern.
 *
 * On merge: These routes should be added to graph-routes.ts's createGraphRouter(),
 * or mounted alongside it in server.ts.
 */

import { Hono } from 'hono'
import {
  addCustomAsset,
  dismissMotion,
  pinMotion,
  undismissMotion,
  loadOverrides,
} from './lib/motion-overrides.ts'
import { sanitizeErr } from './utils.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'

function findCustomerBySlug(slug: string): boolean {
  return customers.some(c => toSlug(c.name) === slug)
}

// ── Router ─────────────────────────────────────────────────────────────────

export function createMotionOverrideRouter(): Hono {
  const router = new Hono()

  // ── POST /api/customer/:slug/motion/assets ──────────────────────────────
  router.post('/api/customer/:slug/motion/assets', async (c) => {
    const slug = c.req.param('slug')
    if (!findCustomerBySlug(slug)) return c.json({ error: `Customer "${slug}" not found` }, 404)

    try {
      const body = await c.req.json()
      const { phaseId, asset } = body

      if (!phaseId || !asset?.name || !asset?.url || !asset?.type) {
        return c.json({ error: 'Missing required fields: phaseId, asset.name, asset.url, asset.type' }, 400)
      }

      addCustomAsset(slug, phaseId, asset)
      const overrides = loadOverrides(slug)
      return c.json({ ok: true, overrides })
    } catch (e: any) {
      console.error(`[motion-overrides] Add asset failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── POST /api/customer/:slug/motion/dismiss ─────────────────────────────
  router.post('/api/customer/:slug/motion/dismiss', async (c) => {
    const slug = c.req.param('slug')
    if (!findCustomerBySlug(slug)) return c.json({ error: `Customer "${slug}" not found` }, 404)

    try {
      const body = await c.req.json()
      const { motionId } = body

      if (!motionId) {
        return c.json({ error: 'Missing required field: motionId' }, 400)
      }

      dismissMotion(slug, motionId)
      const overrides = loadOverrides(slug)
      return c.json({ ok: true, overrides })
    } catch (e: any) {
      console.error(`[motion-overrides] Dismiss failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── POST /api/customer/:slug/motion/pin ─────────────────────────────────
  router.post('/api/customer/:slug/motion/pin', async (c) => {
    const slug = c.req.param('slug')
    if (!findCustomerBySlug(slug)) return c.json({ error: `Customer "${slug}" not found` }, 404)

    try {
      const body = await c.req.json()
      const { motionId } = body

      if (!motionId) {
        return c.json({ error: 'Missing required field: motionId' }, 400)
      }

      pinMotion(slug, motionId)
      const overrides = loadOverrides(slug)
      return c.json({ ok: true, overrides })
    } catch (e: any) {
      console.error(`[motion-overrides] Pin failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── POST /api/customer/:slug/motion/undismiss ───────────────────────────
  router.post('/api/customer/:slug/motion/undismiss', async (c) => {
    const slug = c.req.param('slug')
    if (!findCustomerBySlug(slug)) return c.json({ error: `Customer "${slug}" not found` }, 404)

    try {
      const body = await c.req.json()
      const { motionId } = body

      if (!motionId) {
        return c.json({ error: 'Missing required field: motionId' }, 400)
      }

      undismissMotion(slug, motionId)
      const overrides = loadOverrides(slug)
      return c.json({ ok: true, overrides })
    } catch (e: any) {
      console.error(`[motion-overrides] Undismiss failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
