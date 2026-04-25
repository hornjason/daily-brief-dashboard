// BKL-AI-FP-02: Pure fingerprint detection for brief cache invalidation
// Deterministic SHA-256 hash of brief inputs — cache hit when unchanged, miss on any delta.

import { createHash } from 'crypto'

export interface BriefInputBundle {
  emailTuples: Array<{ subject: string; sender: string; date: string }>
  meetingTuples: Array<{ title: string; attendees: string[]; date: string }>
  ccspTier: string | null
  pipelineStage: string | null
  openCaseCounts: Record<string, number>  // severity → count, last-90d only
  preferencesHash: string
}

export interface FingerprintDelta {
  changed: boolean
  newFingerprint: string
  delta?: string[]  // human-readable list of what changed (for logging/SSE payload)
}

const FINGERPRINT_HEX_LENGTH = 32

export function computeBriefFingerprint(bundle: BriefInputBundle): string {
  // Sort email tuples by date desc for determinism
  const sortedEmails = [...bundle.emailTuples]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(e => `${e.subject}|${e.sender}|${e.date}`)

  // Sort meeting tuples by date desc
  const sortedMeetings = [...bundle.meetingTuples]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(m => `${m.title}|${[...m.attendees].sort().join(',')}|${m.date}`)

  return createHash('sha256')
    .update(JSON.stringify(sortedEmails))
    .update(JSON.stringify(sortedMeetings))
    .update(bundle.ccspTier ?? 'null')
    .update(bundle.pipelineStage ?? 'null')
    .update(JSON.stringify(bundle.openCaseCounts))
    .update(bundle.preferencesHash)
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_LENGTH)
}

export function detectFingerprintDelta(
  previousFingerprint: string | null | undefined,
  bundle: BriefInputBundle,
): FingerprintDelta {
  const newFingerprint = computeBriefFingerprint(bundle)
  if (!previousFingerprint) {
    return { changed: true, newFingerprint, delta: ['cold-cache'] }
  }
  if (previousFingerprint === newFingerprint) {
    return { changed: false, newFingerprint }
  }
  return { changed: true, newFingerprint, delta: ['input-changed'] }
}

// ── BKL-AI-FP-09: Corpus delta detection ────────────────────────────────────

export interface DocCorpusDiff {
  newDocs: string[]       // fileIds in curr but not prev
  changedDocs: string[]   // fileIds in both with different modifiedTime
  removedDocs: string[]   // fileIds in prev but not curr
  unchangedDocs: string[] // fileIds in both with same modifiedTime
}

export function diffDocCorpus(
  prev: Record<string, string>,  // fileId → modifiedTime
  curr: Record<string, string>,
): DocCorpusDiff {
  const newDocs: string[] = []
  const changedDocs: string[] = []
  const removedDocs: string[] = []
  const unchangedDocs: string[] = []

  for (const [id, modTime] of Object.entries(curr)) {
    if (!(id in prev)) newDocs.push(id)
    else if (prev[id] !== modTime) changedDocs.push(id)
    else unchangedDocs.push(id)
  }
  for (const id of Object.keys(prev)) {
    if (!(id in curr)) removedDocs.push(id)
  }
  return { newDocs, changedDocs, removedDocs, unchangedDocs }
}

export function shouldUseDeltaMode(diff: DocCorpusDiff, hasPreviousBrief: boolean): boolean {
  return hasPreviousBrief
    && diff.unchangedDocs.length >= 3
    && (diff.newDocs.length + diff.changedDocs.length) >= 1
}
