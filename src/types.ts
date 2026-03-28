/**
 * Per-AE configuration — stored in data/config/aes.json.
 * tableauUrl: full Tableau dashboard URL; territory extracted automatically.
 * Sheet IDs are written back by scrapers after first creation.
 */
export interface AE {
  name: string
  driveFolderId: string         // Google Drive folder where AE sheets live
  sfReportId?: string           // Salesforce report ID for pipeline scrape
  tableauTerritories?: string[] // Account Territory filter values, e.g. ["WEST_COMM_CORP_NORTHWEST_TERR01"]
  supportableSheetId?: string   // Written back after first Supportable scrape
  pipelineSheetId?: string      // Written back after first SF pipeline scrape
  ccspSheetId?: string          // Written back after first CCSP scrape
}

export interface Customer {
  name: string
  domain?: string
  accountNumbers?: string[]
  ae?: string
  segment?: string
  region?: string
  sheetTab?: string      // override when customer name doesn't match sheet tab (e.g. REI → "RECREATIONAL EQUIPMENT")
  aliases?: string[]     // known subsidiaries / former names that map to this account
  aliasDomains?: string[] // email domains for aliases (e.g. ["lifetouch.com"] for Shutterfly)
  skipAccountDiscovery?: boolean  // true = no RH account, skip portal discovery
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
