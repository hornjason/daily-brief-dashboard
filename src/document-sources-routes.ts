/**
 * Document Sources Admin Routes — GitHub Issue #316
 *
 * CRUD API for managing configurable document sources.
 * Admin panel can list, add, edit, remove document sources.
 */

import { Hono } from 'hono'
import { resolve } from 'path'
import {
  loadDocumentSources,
  addDocumentSource,
  updateDocumentSource,
  removeDocumentSource,
} from './document-sources.ts'
import { sanitizeErr } from './utils.ts'

const CONFIG_DIR = process.env.CONFIG_DIR ?? 'config'

export function getDocumentSourcesPath(): string {
  return resolve(CONFIG_DIR, 'document-sources.json')
}

export function createDocumentSourcesRouter(): Hono {
  const router = new Hono()

  router.get('/api/admin/document-sources', (c) => {
    try {
      const sources = loadDocumentSources(getDocumentSourcesPath())
      return c.json({ sources })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.post('/api/admin/document-sources', async (c) => {
    try {
      const body = await c.req.json()
      if (!body.name || !body.type || !body.identifier) {
        return c.json({ error: 'name, type, and identifier are required' }, 400)
      }
      const added = addDocumentSource(getDocumentSourcesPath(), {
        name: body.name,
        type: body.type,
        identifier: body.identifier,
        configKey: body.configKey,
        status: 'pending',
      })
      return c.json({ ok: true, source: added })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.put('/api/admin/document-sources/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()
      const updated = updateDocumentSource(getDocumentSourcesPath(), id, body)
      if (!updated) return c.json({ error: 'Source not found' }, 404)
      return c.json({ ok: true, source: updated })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.delete('/api/admin/document-sources/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const removed = removeDocumentSource(getDocumentSourcesPath(), id)
      if (!removed) return c.json({ error: 'Source not found' }, 404)
      return c.json({ ok: true })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
