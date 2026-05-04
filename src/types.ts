/**
 * Per-AE configuration — stored in data/config/aes.json.
 * tableauUrl: full Tableau dashboard URL; territory extracted automatically.
 * Sheet IDs are written back by scrapers after first creation.
 */
export interface AE {
  name: string
  driveFolderId: string         // Google Drive folder where AE sheets live
  parentFolderId?: string       // Drive folder ID of the parent containing this AE's folder
  sfReportId?: string           // Salesforce report ID for pipeline scrape
  tableauTerritories?: string[] // Account Territory filter values, e.g. ["WEST_COMM_CORP_NORTHWEST_TERR01"]
  tableauUrl?: string           // Full Tableau dashboard URL; territory extracted automatically
  subscriptionSheetId?: string   // Written back after first subscription (SF bookings) sheet sync
  pipelineSheetId?: string      // Written back after first SF pipeline scrape
  ccspSheetId?: string          // Written back after first CCSP scrape
  accounts?: string[]           // Pre-loaded account baseline from territory mapping sheet
}

export interface Customer {
  name: string
  supportableName?: string  // override search name when Supportable uses a different name than the territory sheet
  domain?: string
  accountNumbers?: string[]
  ae?: string
  segment?: string
  region?: string
  sheetTab?: string      // override when customer name doesn't match sheet tab (e.g. REI → "RECREATIONAL EQUIPMENT")
  aliases?: string[]     // known subsidiaries / former names that map to this account
  aliasDomains?: string[] // email domains for aliases (e.g. ["lifetouch.com"] for Shutterfly)
  skipAccountDiscovery?: boolean  // true = no RH account, skip portal discovery
  driveFolderId?: string  // Google Drive subfolder for this customer under the AE folder
  domainOverride?: string  // BKL-F05: customer-specific domain that bypasses the global blocklist (e.g. workday.com for Workday Inc)
  supportableFileId?: string  // Supportable Google Sheet file ID for this customer
  notebookId?: string    // BKL-AI11: NotebookLM notebook ID (set after notebook is created)
  notebookUrl?: string   // BKL-AI11: NotebookLM notebook URL for dashboard linking
  importedFrom?: string  // provenance tag: "territory-sheet", "manual", etc.
  inactive?: boolean     // true = AE removed but customer preserved (has account numbers or Drive folder)
  ccspCustomer?: boolean // true = customer appears in SF sheet only via CCSP opportunities
  discoveryFailures?: number        // BKL-RH-PERF-01: count of consecutive failed discovery attempts
  discoveryStatus?: 'unresolvable'  // BKL-RH-PERF-01: set after 3 failures
  discoverySkippedUntil?: string    // BKL-RH-PERF-01: ISO timestamp — skip discovery until this date
  needsManualDomain?: boolean       // BKL-DOM-INF-13: set when all inference tiers return null; cleared once a domain resolves
}

export interface CustomerSubscription {
  subscriptionNumber: string
  productName: string
  quantity: number
  endDate: string
  daysLeft: number
  status: string
}

export interface EmailHighlight {
  customer: string
  subject: string
  from: string
  date: string
  snippet: string
  actionRequired: boolean
}

export interface SupportCase {
  caseNumber: string
  summary: string
  status: string
  severity: string
  accountNumber: string
  daysOpen: number
  product?: string
  /** 'name_match' = found via company name search; 'account_number' = found via direct account number scrape */
  casesSource?: 'name_match' | 'account_number'
  customerName?: string  // BKL-UX55: resolved at scrape time from accountNumber → customer map
}

export interface Renewal {
  subscriptionNumber: string
  subscriptionName?: string
  customerName?: string
  endDate: string
  daysLeft: number
  quantity: number
  status: string
  portalUrl: string
}

export interface DriveFile {
  id?: string         // Drive fileId — needed for ADR-013 Tier 3 content-addressed cache
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
  customer?: string   // folder name the file lives under
  content?: string    // plain-text export of Google Docs/Slides (capped at 3000 chars)
}

export interface SheetRow {
  [column: string]: string
}

export interface ProductSubscription {
  sku: string
  productDescription: string
  quantity: number
  status: string
  startDate?: string
  endDate?: string
}

export interface CalendarEvent {
  title: string
  start: string
  end: string
  attendees?: string[]
  needsPrep: boolean
  customers?: string[]
  organizer?: string   // set when event is organized by an AE (no customer match)
  joinUrl?: string     // Google Meet / Zoom / Teams link
  description?: string // event description / agenda (plain text, first 300 chars)
  notesUrl?: string    // first Google Doc link found in description
  solo?: boolean       // true when only the calendar owner is on the event
}
