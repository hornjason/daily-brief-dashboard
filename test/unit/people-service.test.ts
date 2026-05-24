import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'fs'
import { resolve } from 'path'

const TEST_DIR = resolve(import.meta.dir, '../../test-fixtures/people-service')
const CONTACTS_PATH = resolve(TEST_DIR, 'contacts.json')
const PARTNERS_PATH = resolve(TEST_DIR, 'partners.json')

function setup() {
  mkdirSync(TEST_DIR, { recursive: true })
}

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ok */ }
}

// ── Sample data ──────────────────────────────────────────────────────────────

const sampleContact = {
  id: 'contact-1',
  customerName: 'Acme Corp',
  name: 'Jane Doe',
  email: 'jane.doe@acme.com',
  title: 'VP of Engineering',
  linkedinUrl: 'https://linkedin.com/in/janedoe',
  role: 'champion' as const,
  interests: ['kubernetes', 'automation'],
  communicationPreferences: { preferredChannel: 'email' as const },
  notes: 'Key technical decision maker',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
}

const sampleOutreachEntry = {
  contactId: 'contact-1',
  type: 'email' as const,
  subject: 'OpenShift 4.17 Launch',
  topics: ['openshift', 'migration'],
  sentAt: '2026-05-10T10:00:00.000Z',
  campaignId: 'camp-001',
  response: 'replied' as const,
}

const sampleOrgEntry = {
  customerName: 'Acme Corp',
  contactId: 'contact-1',
  reportsTo: null as string | null,
  decisionAuthority: 'high' as const,
  relationship: 'champion' as const,
  meddpiccRole: 'E' as const,
}

const samplePartners = [
  {
    name: 'AHEAD',
    aliases: ['Ahead'],
    domain: 'ahead.com',
    partnershipLevel: 'Red Hat Specialized Partner',
    specializations: ['Container Mgmt'],
    geo: 'NA',
    country: 'US, Canada',
  },
  {
    name: 'CDW',
    aliases: [],
    domain: 'cdw.com',
    partnershipLevel: 'Red Hat Specialized Partner',
    specializations: ['Mission Critical Automation', 'Container Mgmt'],
    geo: 'NA',
    country: 'US, Canada',
  },
]

// ── Tests ────────────────────────────────────────────────────────────────────

describe('people-service', () => {
  beforeEach(setup)
  afterEach(cleanup)

  describe('Contact CRUD', () => {
    it('returns empty array when no contacts file exists', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })
      expect(svc.listContacts('Acme Corp')).toEqual([])
    })

    it('saves and retrieves a contact', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const saved = svc.upsertContact(sampleContact)
      expect(saved.id).toBe('contact-1')
      expect(saved.name).toBe('Jane Doe')

      const contacts = svc.listContacts('Acme Corp')
      expect(contacts).toHaveLength(1)
      expect(contacts[0].email).toBe('jane.doe@acme.com')
    })

    it('updates an existing contact by id', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      const updated = svc.upsertContact({ ...sampleContact, title: 'CTO' })
      expect(updated.title).toBe('CTO')

      const contacts = svc.listContacts('Acme Corp')
      expect(contacts).toHaveLength(1)
      expect(contacts[0].title).toBe('CTO')
    })

    it('deletes a contact', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      const deleted = svc.deleteContact('contact-1')
      expect(deleted).toBe(true)

      const contacts = svc.listContacts('Acme Corp')
      expect(contacts).toHaveLength(0)
    })

    it('returns false when deleting non-existent contact', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const deleted = svc.deleteContact('nonexistent')
      expect(deleted).toBe(false)
    })

    it('finds contact by email', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      const found = svc.findContactByEmail('jane.doe@acme.com')
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Jane Doe')
    })

    it('auto-generates id when not provided', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const { id, ...contactWithoutId } = sampleContact
      const saved = svc.upsertContact(contactWithoutId as any)
      expect(saved.id).toBeTruthy()
      expect(saved.id.startsWith('c-')).toBe(true)
    })
  })

  describe('Outreach History', () => {
    it('returns empty array when no outreach history', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })
      expect(svc.getOutreachHistory('contact-1')).toEqual([])
    })

    it('logs and retrieves outreach entries', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.logOutreach(sampleOutreachEntry)

      const history = svc.getOutreachHistory('contact-1')
      expect(history).toHaveLength(1)
      expect(history[0].subject).toBe('OpenShift 4.17 Launch')
      expect(history[0].response).toBe('replied')
    })

    it('returns outreach history sorted newest first', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.logOutreach({ ...sampleOutreachEntry, sentAt: '2026-05-01T10:00:00.000Z', subject: 'First' })
      svc.logOutreach({ ...sampleOutreachEntry, sentAt: '2026-05-15T10:00:00.000Z', subject: 'Second' })

      const history = svc.getOutreachHistory('contact-1')
      expect(history[0].subject).toBe('Second')
      expect(history[1].subject).toBe('First')
    })

    it('checks if a topic was already pitched to a contact', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.logOutreach(sampleOutreachEntry)

      expect(svc.wasTopicPitched('contact-1', 'openshift')).toBe(true)
      expect(svc.wasTopicPitched('contact-1', 'ansible')).toBe(false)
    })

    it('filters outreach history by date range', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.logOutreach({ ...sampleOutreachEntry, sentAt: '2026-04-01T10:00:00.000Z', subject: 'Old' })
      svc.logOutreach({ ...sampleOutreachEntry, sentAt: '2026-05-15T10:00:00.000Z', subject: 'Recent' })

      const history = svc.getOutreachHistory('contact-1', { since: '2026-05-01T00:00:00.000Z' })
      expect(history).toHaveLength(1)
      expect(history[0].subject).toBe('Recent')
    })
  })

  describe('Org Chart', () => {
    it('returns empty org chart when no entries', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })
      expect(svc.getOrgChart('Acme Corp')).toEqual([])
    })

    it('saves and retrieves org chart entries', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.upsertOrgEntry(sampleOrgEntry)

      const chart = svc.getOrgChart('Acme Corp')
      expect(chart).toHaveLength(1)
      expect(chart[0].decisionAuthority).toBe('high')
      expect(chart[0].meddpiccRole).toBe('E')
    })

    it('updates org entry when contact already has one', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.upsertOrgEntry(sampleOrgEntry)
      svc.upsertOrgEntry({ ...sampleOrgEntry, relationship: 'blocker' })

      const chart = svc.getOrgChart('Acme Corp')
      expect(chart).toHaveLength(1)
      expect(chart[0].relationship).toBe('blocker')
    })

    it('maps MEDDPICC roles correctly', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.upsertOrgEntry({ ...sampleOrgEntry, meddpiccRole: 'C1' })

      const chart = svc.getOrgChart('Acme Corp')
      expect(chart[0].meddpiccRole).toBe('C1')
    })
  })

  describe('Partner Matching', () => {
    it('returns empty matches when no partners file', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const matches = svc.matchPartners(['openshift'])
      expect(matches).toEqual([])
    })

    it('matches partners by product slug to specialization', async () => {
      writeFileSync(PARTNERS_PATH, JSON.stringify(samplePartners))

      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const matches = svc.matchPartners(['ocp'])
      expect(matches.length).toBeGreaterThanOrEqual(1)
      expect(matches.some(m => m.partner.name === 'AHEAD')).toBe(true)
    })

    it('matches ansible/aap to Mission Critical Automation', async () => {
      writeFileSync(PARTNERS_PATH, JSON.stringify(samplePartners))

      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const matches = svc.matchPartners(['aap'])
      expect(matches.some(m => m.partner.name === 'CDW')).toBe(true)
    })

    it('returns no matches for unknown product slugs', async () => {
      writeFileSync(PARTNERS_PATH, JSON.stringify(samplePartners))

      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const matches = svc.matchPartners(['unknown-product'])
      expect(matches).toEqual([])
    })

    it('includes match reason in results', async () => {
      writeFileSync(PARTNERS_PATH, JSON.stringify(samplePartners))

      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const matches = svc.matchPartners(['ocp'])
      const ahead = matches.find(m => m.partner.name === 'AHEAD')
      expect(ahead).toBeTruthy()
      expect(ahead!.matchedSpecializations).toContain('Container Mgmt')
      expect(ahead!.matchedProducts).toContain('ocp')
    })
  })

  describe('Attendee Profile Lookup', () => {
    it('returns null for unknown email', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      const profile = svc.getAttendeeProfile('unknown@test.com')
      expect(profile).toBeNull()
    })

    it('returns enriched profile with outreach history for known contact', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')
      const svc = createPeopleService({ configDir: TEST_DIR })

      svc.upsertContact(sampleContact)
      svc.logOutreach(sampleOutreachEntry)
      svc.upsertOrgEntry(sampleOrgEntry)

      const profile = svc.getAttendeeProfile('jane.doe@acme.com')
      expect(profile).not.toBeNull()
      expect(profile!.contact.name).toBe('Jane Doe')
      expect(profile!.outreachHistory).toHaveLength(1)
      expect(profile!.orgEntry).not.toBeNull()
      expect(profile!.orgEntry!.meddpiccRole).toBe('E')
    })
  })

  describe('Data persistence', () => {
    it('persists contacts across service instances', async () => {
      const { createPeopleService } = await import('../../src/people-service.ts')

      const svc1 = createPeopleService({ configDir: TEST_DIR })
      svc1.upsertContact(sampleContact)

      // Create a new instance — should read from disk
      const svc2 = createPeopleService({ configDir: TEST_DIR })
      const contacts = svc2.listContacts('Acme Corp')
      expect(contacts).toHaveLength(1)
      expect(contacts[0].name).toBe('Jane Doe')
    })
  })
})
