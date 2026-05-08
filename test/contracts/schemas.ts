import { z } from 'zod'

export const AESchema = z.object({
  name: z.string(),
  driveFolderId: z.string(),
  sfReportId: z.string(),
  tableauTerritories: z.array(z.string()),
  supportableSheetId: z.string().optional(),
  pipelineSheetId: z.string(),
  ccspSheetId: z.string(),
}).passthrough()

export const AEsResponseSchema = z.object({
  aes: z.array(AESchema),
}).passthrough()

export const CustomerSchema = z.object({
  name: z.string(),
  accountNumbers: z.array(z.string()),
  domain: z.string().optional(),
}).passthrough()

export const CustomersResponseSchema = z.object({
  customers: z.array(CustomerSchema),
}).passthrough()

export const BootstrapStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'error']).or(z.string()),
}).passthrough()

export const BootstrapStatusSchema = z.object({
  running: z.boolean(),
  steps: z.array(BootstrapStepSchema),
  aeName: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  resources: z.unknown(),
}).passthrough()

export const TableauSessionSchema = z.object({
  reachable: z.boolean(),
  sessionValid: z.boolean(),
}).passthrough()

export const CcspRowSchema = z.object({}).passthrough()

export const CcspResponseSchema = z.object({
  data: z.array(CcspRowSchema),
  sourceWarning: z.string().optional(),
}).passthrough()

export const PipelineOpportunitySchema = z.object({}).passthrough()

export const PipelineResponseSchema = z.object({
  opportunities: z.array(PipelineOpportunitySchema),
}).passthrough()

const ScrapeSourceSchema = z.object({
  lastSync: z.string().nullable(),
  lastError: z.string().nullable(),
  isRunning: z.boolean(),
  isStale: z.boolean(),
}).passthrough()

export const ScrapeStatusSchema = z.object({
  supportable: ScrapeSourceSchema,
  ccsp: ScrapeSourceSchema,
  rh: ScrapeSourceSchema,
  salesforce: ScrapeSourceSchema,
})

const CacheEntrySchema = z.object({
  lastModified: z.string().nullable(),
  bytes: z.number().nullable(),
}).passthrough()

export const CacheStatusSchema = z.object({
  ccsp: CacheEntrySchema,
  pipeline: CacheEntrySchema,
  rh_cases: CacheEntrySchema,
})

// ── New schemas for BKL-AI20/AI21/AI27/AI28 ─────────────────────────────────

export const BriefResponseSchema = z.object({
  text: z.string().optional(),
  fromCache: z.boolean(),
  cachedAt: z.string().optional(),
  error: z.string().optional(),
}).passthrough()

export const IntelligenceStatusSchema = z.object({
  status: z.enum(['pending', 'running', 'complete', 'error', 'none']).or(z.string()),
  step: z.string().optional(),
  companyDocUrl: z.string().optional(),
  industryDocUrl: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  message: z.string().optional(),
}).passthrough()

export const MorningSummarySchema = z.object({
  signals: z.array(z.object({
    customer: z.string(),
    type: z.string(),
    severity: z.string(),
    text: z.string(),
  }).passthrough()),
  summary: z.string().optional(),
  synthesis: z.string().optional(),
  customerCount: z.number().optional(),
}).passthrough()

export const PipelineCustomerSchema = z.object({
  totalAcv: z.number(),
  openCount: z.number(),
  opps: z.array(z.object({}).passthrough()),
  closedOpps: z.array(z.object({}).passthrough()),
}).passthrough()
