export interface Customer {
  name: string
  domain?: string
  accountNumbers?: string[]
  ae?: string
  segment?: string
  region?: string
  sheetTab?: string      // override when customer name doesn't match sheet tab (e.g. REI → "RECREATIONAL EQUIPMENT")
  aliases?: string[]     // known subsidiaries / former names that map to this account
  supportableFileId?: string  // Google Sheets file ID of the AE's Supportable file
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
