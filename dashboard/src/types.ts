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
  confidenceScore?: number | null
  attentionScore?: number
  attentionReasons?: string[]
  needsManualDomain?: boolean  // BKL-DOM-INF-13: true when bootstrap could not resolve a domain
}

export interface PodInfo {
  id: string
  name: string
  aeNames: string[]
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
  casesSource?: 'name_match' | 'account_number'
}

export interface CalendarEvent {
  title: string
  start: string
  end: string
  attendees?: string[]
  attendeeDetails?: Array<{ email: string; displayName?: string }>
  needsPrep: boolean
  customers?: string[]
  organizer?: string
  joinUrl?: string
  description?: string
  notesUrl?: string
  solo?: boolean
}

export interface CCSPCustomer {
  name: string
  acv: number
  partners: CCSPPartner[]
}

export interface CCSPQuarter {
  quarter: string
  acv: number
}

export interface CCSPPartner {
  partner: string
  acv: number
}

export interface CCSPByAE {
  ae: string
  acv: number
  byQuarter: CCSPQuarter[]
  topAccounts: { name: string; acv: number }[]
}

export interface CCSPSummary {
  totalAcv: number
  cachedAt: string | null
  sourceWarning?: boolean
  byCustomer: CCSPCustomer[]
  byQuarter: CCSPQuarter[]
  byPartner: CCSPPartner[]
  byAE?: CCSPByAE[]
}

export interface PipelineOpp {
  oppNumber: string
  oppId?: string
  accountName: string
  oppName: string
  acv: number
  closeDate: string
  forecastCategory: string
  owner: string
  renewal: boolean
  offeringGroup: string
  probability: number
  products: string[]
}

export interface PipelineByStage {
  stage: string
  acv: number
  count: number
}

export interface PipelineByQuarterStage {
  quarter: string
  commit: number
  bestCase: number
  pipeline: number
}

export interface PipelineByOwner {
  owner: string
  acv: number
  count: number
}

export interface PipelineSummary {
  totalAcv: number
  openCount: number
  renewalAcv: number
  newAcv: number
  byStage: PipelineByStage[]
  byOwner: PipelineByOwner[]
  byQuarterStage: PipelineByQuarterStage[]
  topOpps: PipelineOpp[]
  closedOpps: PipelineOpp[]
  techWinsNeeded: PipelineOpp[]
  cachedAt: string | null
  sourceWarning?: boolean
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
