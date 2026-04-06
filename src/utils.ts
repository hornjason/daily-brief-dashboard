// src/utils.ts — Shared utility functions (no imports from other src/ modules)

/** Strip internal file paths and cap length before returning error strings to clients.
 * BKL-G30 Gap 5: maps Playwright DNS/network patterns to user-friendly messages. */
export function sanitizeErr(e: any): string {
  const raw = String(e?.message ?? e)
  // Map Playwright/DNS error patterns to user-friendly messages before truncation
  if (/ERR_NAME_NOT_RESOLVED/i.test(raw)) return 'Host not reachable — check VPN connection'
  if (/ERR_CONNECTION_REFUSED/i.test(raw)) return 'Connection refused — service may be down or VPN required'
  if (/ERR_TIMED_OUT|ETIMEDOUT/i.test(raw)) return 'Connection timed out — check VPN or network'
  if (/ERR_INTERNET_DISCONNECTED/i.test(raw)) return 'No internet connection'
  if (/net::ERR_/i.test(raw)) return 'Network error — check VPN connection'
  return raw.slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')
}

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
 * Sanitize a customer-supplied string before injection into AI prompts.
 * Strips prompt-injection patterns (instruction overrides, role impersonation, HTML/XML)
 * and caps length. BKL-S12.
 */
export function sanitizePromptInput(value: string, maxLen = 500): string {
  if (typeof value !== 'string') return ''
  // Strip zero-width chars that can break word-boundary detection
  let cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, '')
  // Strip HTML/XML tags
  cleaned = cleaned.replace(/<[^>]*>/g, ' ')
  // Strip instruction-override patterns
  cleaned = cleaned.replace(
    /\b(ignore|disregard|forget|override|bypass)\s+(previous|prior|all|above|the)\s+(instructions?|rules?|prompt|directives?|context)/gi,
    '[removed]'
  )
  // Strip role-impersonation patterns
  cleaned = cleaned.replace(
    /\b(you\s+are\s+now|act\s+as|pretend\s+(you\s+are|to\s+be)|roleplay\s+as)\b/gi,
    '[removed]'
  )
  // Strip bare SYSTEM/USER/ASSISTANT role markers that could hijack prompt structure
  cleaned = cleaned.replace(/^\s*(SYSTEM|USER|ASSISTANT)\s*:/gim, '[removed]:')
  // Collapse excessive whitespace
  cleaned = cleaned.replace(/\s{3,}/g, ' ').trim()
  return cleaned.slice(0, maxLen)
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
