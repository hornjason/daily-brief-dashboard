// dashboard/src/lib/connection-state.ts
//
// Connection state derivation — pure functions, no React, no app imports.
// Two-axis state model: separate session validity from data freshness so a
// stale CCSP scrape does not flip the Tableau card to "Stale" while the
// SSO session is still valid, and a single SF sync failure does not flip
// the SF card to "Expired".
//
// See ARCHITECTURE.md and the connection redesign brief for rationale.

export type SessionState = 'none' | 'authenticating' | 'active' | 'aging' | 'expired'
export type DataState    = 'never' | 'syncing' | 'fresh' | 'stale' | 'failed'

export interface CardState {
  sessionState: SessionState
  dataState:    DataState
  label:        string          // primary text on the card
  secondaryLabel: string | null // e.g. "Last sync: 2h ago"
  dotColor:     'gray' | 'blue' | 'green' | 'amber' | 'red'
  dotPulse:     boolean
  countsAsConnected: boolean    // whether this connection increments the header counter
}

export interface RhRawStatus {
  hasSession:     boolean
  sessionExpired: boolean
  lastScraped:    string | null
  loginInProgress?: boolean
  liveReachable?: boolean | null
  lastAuthenticatedAt?: string | null
}

export interface SfRawStatus {
  hasSession:      boolean
  sessionExpired?: boolean
  syncError?:      string | null
  lastSync?:       string | null
  loginInProgress?: boolean
  lastAuthenticatedAt?: string | null
}

export interface TableauRawStatus {
  sessionValid: boolean
  reachable:    boolean
}

export interface CcspRawStatus {
  state:      string | null   // 'running' | 'failed' | 'stale' | null
  lastScrape: string | null
  lastError:  string | null
  running?:   boolean
}

const AGING_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function isAging(lastAuthenticatedAt: string | null | undefined): boolean {
  if (!lastAuthenticatedAt) return false
  return Date.now() - new Date(lastAuthenticatedAt).getTime() > AGING_THRESHOLD_MS
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function deriveRhCard(rh: RhRawStatus, scraperRunning: boolean): CardState {
  if (rh.loginInProgress && !rh.hasSession) {
    return { sessionState: 'authenticating', dataState: 'never', label: 'Logging in…', secondaryLabel: null, dotColor: 'blue', dotPulse: true, countsAsConnected: false }
  }
  if (rh.sessionExpired) {
    return { sessionState: 'expired', dataState: rh.lastScraped ? 'stale' : 'never', label: 'Session expired', secondaryLabel: null, dotColor: 'red', dotPulse: false, countsAsConnected: false }
  }
  if (!rh.hasSession || rh.liveReachable === false) {
    return { sessionState: 'none', dataState: 'never', label: 'Not connected', secondaryLabel: null, dotColor: 'gray', dotPulse: false, countsAsConnected: false }
  }
  // Session is active
  const aging = isAging(rh.lastAuthenticatedAt)
  const sessionState: SessionState = aging ? 'aging' : 'active'
  if (scraperRunning) {
    return { sessionState, dataState: 'syncing', label: 'Syncing…', secondaryLabel: null, dotColor: 'blue', dotPulse: true, countsAsConnected: true }
  }
  if (!rh.lastScraped) {
    return { sessionState, dataState: 'never', label: 'Connected — first sync…', secondaryLabel: null, dotColor: 'blue', dotPulse: true, countsAsConnected: true }
  }
  const secondary = aging ? 'Re-auth soon' : `Last sync: ${timeAgo(rh.lastScraped)}`
  const label = aging ? 'Connected — re-auth soon' : 'Connected'
  return { sessionState, dataState: 'fresh', label, secondaryLabel: secondary, dotColor: aging ? 'amber' : 'green', dotPulse: false, countsAsConnected: true }
}

export function deriveSfCard(sf: SfRawStatus, scraperRunning: boolean): CardState {
  if (sf.loginInProgress && !sf.hasSession) {
    return { sessionState: 'authenticating', dataState: 'never', label: 'Logging in…', secondaryLabel: null, dotColor: 'blue', dotPulse: true, countsAsConnected: false }
  }
  const expired = sf.sessionExpired || (!!sf.syncError && sf.syncError.toLowerCase().includes('session expired'))
  if (expired) {
    return { sessionState: 'expired', dataState: sf.lastSync ? 'stale' : 'never', label: 'Session expired', secondaryLabel: 'Salesforce session expired — please reconnect', dotColor: 'red', dotPulse: false, countsAsConnected: false }
  }
  if (!sf.hasSession) {
    return { sessionState: 'none', dataState: 'never', label: 'Not connected', secondaryLabel: null, dotColor: 'gray', dotPulse: false, countsAsConnected: false }
  }
  const aging = isAging(sf.lastAuthenticatedAt)
  const sessionState: SessionState = aging ? 'aging' : 'active'
  if (scraperRunning) {
    return { sessionState, dataState: 'syncing', label: 'Syncing…', secondaryLabel: null, dotColor: 'blue', dotPulse: true, countsAsConnected: true }
  }
  if (sf.syncError) {
    return { sessionState, dataState: 'failed', label: 'Connected — sync failed', secondaryLabel: sf.syncError, dotColor: 'amber', dotPulse: false, countsAsConnected: true }
  }
  if (!sf.lastSync) {
    return { sessionState, dataState: 'never', label: 'Connected — first sync…', secondaryLabel: null, dotColor: 'blue', dotPulse: true, countsAsConnected: true }
  }
  const secondary = aging ? 'Re-auth soon' : `Last sync: ${timeAgo(sf.lastSync)}`
  const label = aging ? 'Connected — re-auth soon' : 'Connected'
  return { sessionState, dataState: 'fresh', label, secondaryLabel: secondary, dotColor: aging ? 'amber' : 'green', dotPulse: false, countsAsConnected: true }
}

export function deriveTableauCard(
  tableau: TableauRawStatus | null,
  ccsp: CcspRawStatus | null,
  connecting: boolean,
  lastAuthenticatedAt?: string | null,
): CardState {
  if (connecting) {
    return { sessionState: 'authenticating', dataState: 'never', label: 'Logging in…', secondaryLabel: null, dotColor: 'blue', dotPulse: true, countsAsConnected: false }
  }
  if (!tableau) {
    return { sessionState: 'none', dataState: 'never', label: 'Checking…', secondaryLabel: null, dotColor: 'gray', dotPulse: true, countsAsConnected: false }
  }
  if (!tableau.reachable || !tableau.sessionValid) {
    return { sessionState: 'none', dataState: 'never', label: 'Not connected', secondaryLabel: null, dotColor: 'gray', dotPulse: false, countsAsConnected: false }
  }
  // Session is valid
  const aging = isAging(lastAuthenticatedAt)
  const sessionState: SessionState = aging ? 'aging' : 'active'
  // Data state from CCSP scraper
  let dataState: DataState = 'never'
  let dataLabel = 'Connected — first sync…'
  let dotColor: CardState['dotColor'] = 'blue'
  let dotPulse = true
  let secondaryLabel: string | null = null

  if (ccsp?.running) {
    dataState = 'syncing'
    dataLabel = 'Syncing…'
    dotColor = 'blue'
    dotPulse = true
  } else if (ccsp?.lastError) {
    dataState = 'failed'
    dataLabel = aging ? 'Connected — sync failed, re-auth soon' : 'Connected — sync failed'
    dotColor = 'amber'
    dotPulse = false
    secondaryLabel = ccsp.lastError
  } else if (ccsp?.state === 'stale') {
    dataState = 'stale'
    dataLabel = aging ? 'Connected — refreshing, re-auth soon' : 'Connected — refreshing'
    dotColor = 'green'
    dotPulse = false
    secondaryLabel = ccsp.lastScrape ? `Last sync: ${timeAgo(ccsp.lastScrape)}` : null
  } else if (ccsp?.lastScrape) {
    dataState = 'fresh'
    dataLabel = aging ? 'Connected — re-auth soon' : 'Connected'
    dotColor = aging ? 'amber' : 'green'
    dotPulse = false
    secondaryLabel = aging ? 'Re-auth soon' : `Last sync: ${timeAgo(ccsp.lastScrape)}`
  }
  // else: dataState stays 'never', label stays 'Connected — first sync…'

  // Only count as connected after at least one successful CCSP download.
  // Cookie freshness alone is not sufficient — seeded/old cookies may be present
  // without ever having successfully downloaded CCSP data.
  const hasVerifiedDownload = !!(ccsp?.lastScrape)
  if (!hasVerifiedDownload && !ccsp?.running && !ccsp?.lastError) {
    return {
      sessionState,
      dataState: 'never',
      label: 'Session active — verifying CCSP…',
      secondaryLabel: null,
      dotColor: 'amber',
      dotPulse: false,
      countsAsConnected: false,
    }
  }

  return { sessionState, dataState, label: dataLabel, secondaryLabel, dotColor, dotPulse, countsAsConnected: hasVerifiedDownload }
}
