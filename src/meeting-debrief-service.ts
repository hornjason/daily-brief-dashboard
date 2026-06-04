/**
 * Meeting Debrief Service — Domain Logic for Post-Meeting Debrief Capture
 *
 * Persists seller feedback from meetings into customer debrief files.
 * Debriefs are read by meeting-prep-intelligence.ts to enrich future preps
 * with "Last meeting notes: ..." context.
 *
 * GitHub Issue #611 — Post-meeting debrief capture
 *
 * Storage: {CACHE_DIR}/debriefs/{customerSlug}/{timestamp}.json
 * Each file is a single debrief entry.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { CACHE_DIR } from './lib/paths.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MeetingDebrief {
  customerSlug: string
  notes: string
  talkingPointsUsed?: string[]
  nextSteps?: string
  createdAt: string
}

export interface DebriefRequest {
  notes: string
  talkingPointsUsed?: string[]
  nextSteps?: string
}

// ── Paths ────────────────────────────────────────────────────────────────────

export function getDebriefDir(customerSlug: string): string {
  return resolve(CACHE_DIR, 'debriefs', customerSlug)
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Persist a meeting debrief for a customer.
 * Returns the debrief ID (timestamp-based filename).
 */
export function saveDebrief(
  customerSlug: string,
  req: DebriefRequest,
): { ok: true; debriefId: string } {
  const dir = getDebriefDir(customerSlug)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const now = new Date()
  const debriefId = now.toISOString().replace(/[:.]/g, '-')

  const debrief: MeetingDebrief = {
    customerSlug,
    notes: req.notes,
    talkingPointsUsed: req.talkingPointsUsed,
    nextSteps: req.nextSteps,
    createdAt: now.toISOString(),
  }

  const filePath = resolve(dir, `${debriefId}.json`)
  writeFileSync(filePath, JSON.stringify(debrief, null, 2), { mode: 0o600 })
  console.log(`[meeting-debrief] Saved debrief for ${customerSlug}: ${debriefId}`)

  return { ok: true, debriefId }
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read all debriefs for a customer, newest first, capped at limit.
 */
export function readDebriefs(
  customerSlug: string,
  limit: number = 10,
): MeetingDebrief[] {
  const dir = getDebriefDir(customerSlug)
  if (!existsSync(dir)) return []

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)

  const debriefs: MeetingDebrief[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(resolve(dir, file), 'utf-8')
      const parsed = JSON.parse(raw) as MeetingDebrief
      debriefs.push(parsed)
    } catch (e: any) {
      console.warn(`[meeting-debrief] Failed to read ${file}: ${e.message}`)
    }
  }

  return debriefs
}

/**
 * Read the most recent debrief for a customer, or null if none exist.
 * Used by meeting-prep-intelligence.ts to inject "Last meeting notes" context.
 */
export function readLatestDebrief(
  customerSlug: string,
): MeetingDebrief | null {
  const debriefs = readDebriefs(customerSlug, 1)
  return debriefs[0] ?? null
}
