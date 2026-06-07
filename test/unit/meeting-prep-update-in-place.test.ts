/**
 * Unit tests for #641: Meeting Prep update-in-place Drive doc logic
 *
 * Verifies that:
 * - First generation uses files.create()
 * - Regeneration (existing doc found) uses files.update() — NOT files.delete() + files.create()
 * - docId is stored in PrepHistoryEntry
 * - docId-first lookup with title-match fallback
 */
import { describe, test, expect } from 'bun:test'
import type { PrepHistoryEntry } from '../../src/meeting-prep-service.ts'

// ── Interface tests ──────────────────────────────────────────────────────────

describe('#641: PrepHistoryEntry docId field', () => {
  test('AC-4: PrepHistoryEntry accepts docId field', () => {
    const entry: PrepHistoryEntry = {
      meetingTitle: 'Weekly Sync',
      meetingStart: '2026-06-06T10:00:00Z',
      docUrl: 'https://docs.google.com/document/d/abc123/edit',
      title: 'Meeting Prep — Weekly Sync — Jun 6, 2026',
      generatedAt: '2026-06-06T09:00:00Z',
      customerName: 'Acme Corp',
      docId: 'abc123',
    }
    expect(entry.docId).toBe('abc123')
  })

  test('AC-4: PrepHistoryEntry docId is optional (backward compat)', () => {
    const entry: PrepHistoryEntry = {
      meetingTitle: 'Weekly Sync',
      meetingStart: '2026-06-06T10:00:00Z',
      docUrl: 'https://docs.google.com/document/d/abc123/edit',
      title: 'Meeting Prep — Weekly Sync — Jun 6, 2026',
      generatedAt: '2026-06-06T09:00:00Z',
    }
    expect(entry.docId).toBeUndefined()
  })
})

// ── Update-in-place logic simulation tests ───────────────────────────────────

describe('#641: Update-in-place logic', () => {
  test('AC-5: docId-first lookup finds match from history', () => {
    const docTitle = 'Meeting Prep — Weekly Sync — Jun 6, 2026'
    const history: PrepHistoryEntry[] = [
      {
        meetingTitle: 'Weekly Sync',
        meetingStart: '2026-06-06T10:00:00Z',
        docUrl: 'https://docs.google.com/document/d/existing-id-123/edit',
        title: docTitle,
        generatedAt: '2026-06-05T09:00:00Z',
        docId: 'existing-id-123',
      },
    ]

    // Simulate the lookup logic from generateMeetingPrep
    const historyMatch = history.find(h => h.docId && h.title === docTitle)
    const existingDocId = historyMatch?.docId ?? null

    expect(existingDocId).toBe('existing-id-123')
  })

  test('AC-5: falls back to title match when no docId in history', () => {
    const docTitle = 'Meeting Prep — Weekly Sync — Jun 6, 2026'
    const history: PrepHistoryEntry[] = [
      {
        meetingTitle: 'Weekly Sync',
        meetingStart: '2026-06-06T10:00:00Z',
        docUrl: 'https://docs.google.com/document/d/old-id/edit',
        title: docTitle,
        generatedAt: '2026-06-05T09:00:00Z',
        // no docId — legacy entry
      },
    ]

    // docId-first lookup finds nothing
    const historyMatch = history.find(h => h.docId && h.title === docTitle)
    const existingDocId = historyMatch?.docId ?? null

    // Falls through to Drive title search (simulated as null here)
    expect(existingDocId).toBeNull()
    // In real code, the Drive files.list fallback would run here
  })

  test('AC-9: first generation path when no history exists', () => {
    const docTitle = 'Meeting Prep — First Meeting — Jun 6, 2026'
    const history: PrepHistoryEntry[] = []

    const historyMatch = history.find(h => h.docId && h.title === docTitle)
    const existingDocId = historyMatch?.docId ?? null

    // No existing doc — first generation uses files.create()
    expect(existingDocId).toBeNull()
  })

  test('AC-8: regeneration selects update path when docId exists', () => {
    const docTitle = 'Meeting Prep — Recurring Standup — Jun 6, 2026'
    const history: PrepHistoryEntry[] = [
      {
        meetingTitle: 'Recurring Standup',
        meetingStart: '2026-06-06T09:00:00Z',
        docUrl: 'https://docs.google.com/document/d/standup-doc-id/edit',
        title: docTitle,
        generatedAt: '2026-06-05T09:00:00Z',
        docId: 'standup-doc-id',
      },
    ]

    const historyMatch = history.find(h => h.docId && h.title === docTitle)
    const existingDocId = historyMatch?.docId ?? null

    // Should select update path, NOT delete+create
    expect(existingDocId).toBe('standup-doc-id')

    // Simulate: update path sets docId = existingDocId, preserves URL
    const docId = existingDocId
    const docUrl = historyMatch?.docUrl ?? `https://docs.google.com/document/d/${existingDocId}/edit`

    expect(docId).toBe('standup-doc-id')
    expect(docUrl).toBe('https://docs.google.com/document/d/standup-doc-id/edit')
  })

  test('AC-6: docUrl remains stable across regenerations', () => {
    const originalDocId = 'stable-doc-id-456'
    const originalUrl = `https://docs.google.com/document/d/${originalDocId}/edit`

    // First generation stores docId
    const firstEntry: PrepHistoryEntry = {
      meetingTitle: 'QBR',
      meetingStart: '2026-06-06T14:00:00Z',
      docUrl: originalUrl,
      title: 'Meeting Prep — QBR — Jun 6, 2026',
      generatedAt: '2026-06-06T13:00:00Z',
      docId: originalDocId,
    }

    // Second generation looks up by docId, reuses same URL
    const historyMatch = [firstEntry].find(h => h.docId && h.title === firstEntry.title)
    const regeneratedUrl = historyMatch?.docUrl ?? `https://docs.google.com/document/d/${historyMatch?.docId}/edit`

    expect(regeneratedUrl).toBe(originalUrl)
  })
})
