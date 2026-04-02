import { z } from 'zod'

export const AESchema = z.object({
  name: z.string(),
  driveFolderId: z.string(),
  sfReportId: z.string(),
  tableauTerritories: z.array(z.string()),
  supportableSheetId: z.string(),
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
  aeName: z.string(),
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
