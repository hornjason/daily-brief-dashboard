/**
 * Brief Orchestration Layer (BKL-REFACTOR-333)
 *
 * Centralizes brief generation data assembly and generation logic.
 * Used by both on-demand routes and background pre-generation.
 */

import { createHash } from 'crypto'
import type { Customer, CalendarEvent, EmailHighlight, DriveFile, SupportCase, CustomerSubscription, ProductSubscription } from './types.ts'
import type { PipelineRecord } from './pipeline.ts'
import type { CCSPRecord } from './sheets.ts'
import { fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief } from './customer.ts'
import { fetchCustomerCases, fetchCustomerSubscriptions } from './redhat.ts'
import { fetchCustomerSheetData } from './sheets.ts'
import { readSheetCache, readPipelineCache, readCCSPCache, toSlug } from './cache-layer.ts'
import { normalizeForQuery } from './utils.ts'
import { writeCustomerDocsCorpus } from './customer-docs-corpus.ts'

/**
 * All data sources needed for brief generation
 */
export interface BriefContext {
  meetings: CalendarEvent[]
  emails: EmailHighlight[]
  docs: DriveFile[]
  cases: SupportCase[]
  subscriptions: CustomerSubscription[]
  products: ProductSubscription[]
  pipeline: PipelineRecord[]
  ccsp: CCSPRecord[]
}

/**
 * Result of brief generation with metadata for caching
 */
export interface BriefResult {
  text: string
  inputFingerprint: string
  lastActivity?: Date
  corpusSnapshot: Record<string, string>
}

/**
 * Assemble all data sources needed for brief generation.
 * Runs fetches in parallel and handles errors gracefully.
 */
export async function assembleBriefContext(customer: Customer): Promise<BriefContext> {
  const cachedSheet = readSheetCache(customer.name)

  // Fetch all data sources in parallel
  const [meetings, emails, docs, cases, subscriptions, products] = await Promise.all([
    fetchCustomerMeetings(customer).catch(() => []),
    fetchCustomerEmails(customer).catch(() => []),
    fetchCustomerDocs(customer).catch(() => []),
    fetchCustomerCases(customer).catch(() => []),
    fetchCustomerSubscriptions(customer).catch(() => []),
    cachedSheet ? Promise.resolve(cachedSheet.rows) : fetchCustomerSheetData(customer).catch(() => []),
  ])

  // Cache customer Drive docs corpus for product intel use
  const customerSlug = toSlug(customer.name)
  writeCustomerDocsCorpus(customerSlug, docs)

  // Filter pipeline and CCSP records using the same normalization as customer-routes.ts
  const customerNeedle = normalizeForQuery(customer.name)
  const pipelineRecords = (readPipelineCache()?.records ?? []).filter(r =>
    normalizeForQuery(r.accountName).includes(customerNeedle) ||
    customerNeedle.includes(normalizeForQuery(r.accountName))
  )
  const ccspRecords = (readCCSPCache()?.records ?? []).filter(r =>
    normalizeForQuery(r.accountName).includes(customerNeedle) ||
    customerNeedle.includes(normalizeForQuery(r.accountName))
  )

  return {
    meetings,
    emails,
    docs,
    cases,
    subscriptions,
    products,
    pipeline: pipelineRecords,
    ccsp: ccspRecords,
  }
}

/**
 * Generate a brief for a customer with all data assembly and fingerprinting.
 * Returns the brief text and metadata needed for cache writes.
 */
export async function generateBriefForCustomer(customer: Customer): Promise<BriefResult> {
  // Assemble all data sources
  const context = await assembleBriefContext(customer)

  // Compute input fingerprint for cache validation
  const fingerprintSource = JSON.stringify({
    emails: context.emails.map(e => `${e.date}|${e.from}|${e.subject}`),
    meetings: context.meetings.map(m => `${m.start}|${m.title}`),
    docs: context.docs.map(d => d.id ?? `${d.name}|${d.modifiedTime ?? ''}`),
    cases: context.cases.map(r => r.caseNumber),
    subscriptions: context.subscriptions.map(s => `${s.subscriptionNumber}|${s.status}|${s.endDate}`),
    products: context.products.map(p => `${p.sku}|${p.status}|${p.endDate ?? ''}`),
    pipeline: context.pipeline.map(r => r.oppId ?? r.oppNumber ?? r.accountName),
    ccsp: context.ccsp.map(r => `${r.accountName}|${r.cloudPartner}|${r.quarter ?? ''}`),
  })
  const inputFingerprint = createHash('sha256').update(fingerprintSource).digest('hex')

  // Generate the brief
  const text = await generateBrief(
    customer,
    context.meetings,
    context.emails,
    context.docs,
    context.cases,
    context.subscriptions,
    context.products,
    context.pipeline,
    context.ccsp
  )

  // Compute last activity date
  const lastEmail = context.emails?.[0]?.date ? new Date(context.emails[0].date) : undefined
  const lastMeeting = context.meetings?.[0]?.start ? new Date(context.meetings[0].start) : undefined
  const lastActivity = [lastEmail, lastMeeting]
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0]

  // Build corpus snapshot for delta detection on next miss
  const corpusSnapshot: Record<string, string> = {}
  for (const d of context.docs) {
    if (d.id) corpusSnapshot[d.id] = d.modifiedTime ?? ''
  }

  return {
    text,
    inputFingerprint,
    lastActivity,
    corpusSnapshot,
  }
}
