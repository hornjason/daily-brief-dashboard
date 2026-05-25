/**
 * People Routes — Thin HTTP Adapter for People Service
 *
 * CRUD endpoints for contacts, outreach history, org chart, and partner matching.
 * Follows the established createXRouter(): Hono factory pattern.
 *
 * Routes registered:
 *   GET    /api/people/contacts?customer=X      — list contacts for a customer
 *   GET    /api/people/contacts/:id             — get a single contact
 *   POST   /api/people/contacts                 — create/update a contact
 *   DELETE /api/people/contacts/:id             — delete a contact
 *   GET    /api/people/contacts/email/:email     — find contact by email
 *   GET    /api/people/outreach/:contactId       — outreach history for a contact
 *   POST   /api/people/outreach                  — log an outreach entry
 *   GET    /api/people/outreach/:contactId/pitched/:topic — check if topic was pitched
 *   GET    /api/people/org?customer=X            — org chart for a customer
 *   POST   /api/people/org                       — create/update an org chart entry
 *   GET    /api/people/partners/match?products=X,Y — match partners to product slugs
 *   GET    /api/people/profile/:email            — enriched attendee profile
 *
 * GitHub #327
 */

import { Hono } from 'hono'
import { createPeopleService } from './people-service.ts'
import { DATA_CONFIG_DIR } from './lib/paths.ts'
import { sanitizeErr } from './utils.ts'

// ── Module state ─────────────────────────────────────────────────────────────

let service: ReturnType<typeof createPeopleService> | null = null

function svc(): ReturnType<typeof createPeopleService> {
  if (!service) {
    service = createPeopleService({ configDir: DATA_CONFIG_DIR })
  }
  return service
}

// ── Route factory ────────────────────────────────────────────────────────────

export function createPeopleRouter(): Hono {
  const r = new Hono()

  // ── Contacts ──────────────────────────────────────────────────────────

  r.get('/api/people/contacts', (c) => {
    const customer = c.req.query('customer')
    if (!customer) return c.json({ error: 'customer query param required' }, 400)
    return c.json(svc().listContacts(customer))
  })

  r.get('/api/people/contacts/email/:email', (c) => {
    const email = decodeURIComponent(c.req.param('email'))
    const contact = svc().findContactByEmail(email)
    if (!contact) return c.json({ error: 'Contact not found' }, 404)
    return c.json(contact)
  })

  r.get('/api/people/contacts/:id', (c) => {
    const contact = svc().getContact(c.req.param('id'))
    if (!contact) return c.json({ error: 'Contact not found' }, 404)
    return c.json(contact)
  })

  r.post('/api/people/contacts', async (c) => {
    try {
      const body = await c.req.json()
      if (!body.customerName || !body.name || !body.email) {
        return c.json({ error: 'customerName, name, and email are required' }, 400)
      }
      const saved = svc().upsertContact(body)
      return c.json(saved, 201)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 400)
    }
  })

  r.delete('/api/people/contacts/:id', (c) => {
    const deleted = svc().deleteContact(c.req.param('id'))
    if (!deleted) return c.json({ error: 'Contact not found' }, 404)
    return c.json({ ok: true })
  })

  // ── Outreach History ──────────────────────────────────────────────────

  r.get('/api/people/outreach/:contactId', (c) => {
    const since = c.req.query('since') ?? undefined
    const history = svc().getOutreachHistory(c.req.param('contactId'), since ? { since } : undefined)
    return c.json(history)
  })

  r.post('/api/people/outreach', async (c) => {
    try {
      const body = await c.req.json()
      if (!body.contactId || !body.type || !body.subject) {
        return c.json({ error: 'contactId, type, and subject are required' }, 400)
      }
      svc().logOutreach({
        contactId: body.contactId,
        type: body.type,
        subject: body.subject,
        topics: body.topics ?? [],
        sentAt: body.sentAt ?? new Date().toISOString(),
        campaignId: body.campaignId,
        response: body.response ?? 'no_response',
      })
      return c.json({ ok: true }, 201)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 400)
    }
  })

  r.get('/api/people/outreach/:contactId/pitched/:topic', (c) => {
    const pitched = svc().wasTopicPitched(c.req.param('contactId'), c.req.param('topic'))
    return c.json({ pitched })
  })

  // ── Org Chart ─────────────────────────────────────────────────────────

  r.get('/api/people/org', (c) => {
    const customer = c.req.query('customer')
    if (!customer) return c.json({ error: 'customer query param required' }, 400)
    return c.json(svc().getOrgChart(customer))
  })

  r.post('/api/people/org', async (c) => {
    try {
      const body = await c.req.json()
      if (!body.customerName || !body.contactId) {
        return c.json({ error: 'customerName and contactId are required' }, 400)
      }
      svc().upsertOrgEntry({
        customerName: body.customerName,
        contactId: body.contactId,
        reportsTo: body.reportsTo ?? null,
        decisionAuthority: body.decisionAuthority ?? 'unknown',
        relationship: body.relationship ?? 'unknown',
        meddpiccRole: body.meddpiccRole ?? null,
      })
      return c.json({ ok: true }, 201)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 400)
    }
  })

  // ── Partner Matching ──────────────────────────────────────────────────

  r.get('/api/people/partners/match', (c) => {
    const productsParam = c.req.query('products')
    if (!productsParam) return c.json({ error: 'products query param required (comma-separated slugs)' }, 400)
    const slugs = productsParam.split(',').map(s => s.trim()).filter(Boolean)
    return c.json(svc().matchPartners(slugs))
  })

  // ── Attendee Profile ──────────────────────────────────────────────────

  r.get('/api/people/profile/:email', (c) => {
    const email = decodeURIComponent(c.req.param('email'))
    const profile = svc().getAttendeeProfile(email)
    if (!profile) return c.json({ error: 'No profile found for this email' }, 404)
    return c.json(profile)
  })

  return r
}
