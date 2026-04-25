// src/oauth-scopes.ts
// Default auth always uses full (bootstrap) scopes.
// NORMAL_SCOPES exists only for the manual "Reduce Permissions" flow.

export const NORMAL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  // Vertex AI (Gemini) — eliminates need for a separate service account key
  'https://www.googleapis.com/auth/cloud-platform',
] as const

export const BOOTSTRAP_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  // Vertex AI (Gemini) — eliminates need for a separate service account key
  'https://www.googleapis.com/auth/cloud-platform',
] as const

export interface StoredToken {
  access_token?: string
  refresh_token?: string
  scope?: string
  token_type?: string
  expiry_date?: number
  configuredAt?: string
  scopeLevel?: 'normal' | 'bootstrap'
}

/** Returns the scope level for display purposes */
export function getScopeLevel(token: StoredToken): 'normal' | 'bootstrap' | 'unknown' {
  if (token.scopeLevel) return token.scopeLevel
  if (!token.scope) return 'unknown'
  const granted = token.scope.split(' ')
  return granted.includes('https://www.googleapis.com/auth/drive') &&
    !granted.includes('https://www.googleapis.com/auth/drive.readonly')
    ? 'bootstrap' : 'normal'
}
