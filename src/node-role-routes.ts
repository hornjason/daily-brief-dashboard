/**
 * BKL-HERO-01 Phase 0 — read-only NODE_ROLE endpoint.
 *
 * Exposes a single read of `process.env.NODE_ROLE` so the frontend can
 * conditionally render the L3-only wizard (hides Data Sources, Refresh
 * Timer, Automation & Limits sections). Read-only, no caching — the env
 * var does not change at runtime.
 */
import type { Hono } from 'hono'

export function registerNodeRoleRoutes(app: Hono): void {
  // GET /api/node-role — { isL3Only: boolean }
  // isL3Only = true when NODE_ROLE is anything other than 'primary' (including unset).
  app.get('/api/node-role', (c) => {
    return c.json({ isL3Only: process.env.NODE_ROLE !== 'primary' })
  })
}
