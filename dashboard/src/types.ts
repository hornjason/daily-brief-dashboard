export interface ProductSubscription {
  sku: string
  productDescription: string
  quantity: number
  status: string
  startDate?: string
  endDate?: string
}

export interface AccountInfo {
  name: string
  domain: string
  accountNumbers: number[]
  ae: string
  segment: string
  products: ProductSubscription[]
  productCount: number
  totalLicenses: number
  cachedAt: string | null
}

export interface SupportCase {
  caseNumber: string
  summary: string
  status: string
  severity: string
  accountNumber: string
  daysOpen: number
  product?: string
  customerName?: string
}

export interface CalendarEvent {
  title: string
  start: string
  end: string
  attendees?: string[]
  needsPrep: boolean
  customers?: string[]
  organizer?: string
  joinUrl?: string
  description?: string
  notesUrl?: string
}

export interface KPIs {
  openCasesTotal: number
  sev1Count: number
  meetingsToday: number
  meetingsThisWeek: number
  renewalsWithin90Days: number
  totalAccounts: number
  totalProducts: number
  totalLicenses: number
}
