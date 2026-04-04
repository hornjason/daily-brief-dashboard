// src/utils.ts — Shared utility functions (no imports from other src/ modules)

/** Strip internal file paths and cap length before returning error strings to clients. */
export const sanitizeErr = (e: any): string =>
  String(e?.message ?? e).slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')

/** Prefix formula-trigger characters with apostrophe to prevent injection */
export function sanitizeCell(value: string): string {
  if (typeof value !== 'string') return value
  if (/^[=+\-@]/.test(value) && !/^-?\d/.test(value)) return `'${value}`
  return value
}

/** Validate and trim a plain-text string. Rejects HTML tags, empty strings, and values over maxLen. */
export function sanitizeText(value: unknown, maxLen = 200): string | null {
  if (typeof value !== 'string') return null
  if (/<[^>]*>/.test(value)) return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLen) return null
  return trimmed
}

/**
 * Normalize an account/company name for fuzzy matching against Salesforce/pipeline records.
 * Strips common legal suffixes (Inc., LLC, Corp., etc.) so "Acme Corp" matches "Acme Corporation".
 * AI18-R1d: exported here so background-scheduler and customer-routes share the same logic.
 */
export function normalizeForQuery(s: string): string {
  return s.toLowerCase()
    .replace(/,?\s*(inc\.|llc|inc|corp|ltd|lp|co\.|u\.s\..*|life and safety.*|life & safety.*|digital media.*)$/i, '')
    .replace(/[,.]/g, '').trim()
}

/** Validate a Google Drive folder ID (alphanumeric + dash/underscore, min 10 chars). */
export function isValidDriveFolderId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{10,}$/.test(id)
}

// ── ntfy.sh push notification helper ─────────────────────────────────────────
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'asa-command-center'

/** Send a push notification via ntfy.sh. Silently swallows network errors. */
export async function notify(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'default'): Promise<void> {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Content-Type': 'text/plain' },
      body: message,
    })
  } catch (e: any) {
    console.warn('[ntfy] notification failed:', e?.message ?? e)
  }
}

// ── BKL-T04: Live session probe with 30s cache ──────────────────────────────
const _probeCache = new Map<string, { result: boolean; at: number }>()
const PROBE_TTL_MS = 30_000

/** Probe a URL and return true if reachable (status < 400). Results cached for PROBE_TTL_MS. */
export async function liveProbe(url: string, key: string, timeoutMs = 5000): Promise<boolean> {
  const cached = _probeCache.get(key)
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    // 2xx or 3xx redirect = alive; 401/403 = session expired
    const alive = res.status < 400
    _probeCache.set(key, { result: alive, at: Date.now() })
    return alive
  } catch {
    _probeCache.set(key, { result: false, at: Date.now() })
    return false
  }
}
