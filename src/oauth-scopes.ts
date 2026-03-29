// src/oauth-scopes.ts

export const NORMAL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
] as const

export const BOOTSTRAP_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
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

/** Returns true if the token was granted full drive (not drive.readonly) */
export function hasBootstrapScopes(token: StoredToken): boolean {
  if (!token.scope) return false
  const granted = token.scope.split(' ')
  return granted.includes('https://www.googleapis.com/auth/drive') &&
    !granted.includes('https://www.googleapis.com/auth/drive.readonly')
}

/** Returns the scope level, falling back to checking the actual granted scopes */
export function getScopeLevel(token: StoredToken): 'normal' | 'bootstrap' | 'unknown' {
  if (token.scopeLevel) return token.scopeLevel
  if (!token.scope) return 'unknown'
  return hasBootstrapScopes(token) ? 'bootstrap' : 'normal'
}
