import { google } from 'googleapis'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { Customer, CalendarEvent, EmailHighlight, DriveFile, SupportCase, CustomerSubscription, ProductSubscription } from './types.ts'
import type { PipelineRecord } from './pipeline.ts'
import type { CCSPRecord } from './sheets.ts'
import { readLatestBriefCache, readBriefCache, readEmailCache, writeEmailCache, readMeetingCache, writeMeetingCache, toSlug, MS_PER_DAY } from './cache-layer.ts'
import { fetchCustomerDocsImpl as _fetchCustomerDocsImpl } from './customer/docs-fetcher.ts'
import { escapeXml } from './customer/signals/xml-utils.ts'
import { casesSource } from './customer/signals/cases.ts'
import { pipelineSource } from './customer/signals/pipeline.ts'
import { ccspSource } from './customer/signals/ccsp.ts'
import { meetingsSource } from './customer/signals/meetings.ts'
import { emailsSource } from './customer/signals/emails.ts'
import { docsSource } from './customer/signals/docs.ts'
import { subscriptionsSource } from './customer/signals/subscriptions.ts'
import { renderFailedSources } from './customer/signals/failed-sources.ts'
import { renderCustomerHeader, renderPreviousBrief, renderAccountIntelligence, renderProductIntelligence } from './customer/signals/extras.ts'
import type { RenderContext as SignalRenderContext, SignalBundle } from './customer/signals/types.ts'
import { isFreeOrTrial } from './health-score.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { fetchGeminiWithRetry } from './gemini-fetch.ts'
import { getAiConfig, getGeminiModel, getGeminiModelLite, getAutomationConfig } from './ai-config.ts'
import { rankItems, buildSynthesisPrompt } from './brief-pipeline.ts'
import { classifyDocs } from './doc-extraction.ts'
import { getStatus, type ScraperName } from './scraper-status-store.ts'
import { getCachedCustomerProductIntel } from './customer-product-intel.ts'
import { loadProductConfig } from './product-release-radar.ts'
import { extractEmailIntelligence } from './email-extraction.ts'
import { assembleMeetingPrep } from './calendar-extraction.ts'
import type { DocClassification } from './doc-extraction.ts'
import type { EmailIntelligence, SilentContact } from './email-extraction.ts'
import type { MeetingPrep } from './calendar-extraction.ts'
import { emitAIEvent } from './ai-events.ts'
import { detectFingerprintDelta, diffDocCorpus, shouldUseDeltaMode, type BriefInputBundle } from './ai-fingerprint.ts'

const CONFIG_DIR_PATH   = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const GMAIL_TOKEN_PATH  = process.env.GMAIL_TOKEN       ?? resolve(CONFIG_DIR_PATH, '.gmail-token.json')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN      ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')
const GCAL_TOKEN_PATH   = process.env.GCAL_TOKEN        ?? resolve(CONFIG_DIR_PATH, '.calendar-token.json')

// ── Calendar: meetings for this customer (next 30 days) ──────────────────────

export async function fetchCustomerMeetings(customer: Customer): Promise<CalendarEvent[]> {
  // ADR-013 Tier 2: serve from cache when fresh (2h TTL)
  const customerSlug = toSlug(customer.name)
  const cached = readMeetingCache(customerSlug)
  if (cached) {
    console.log(`[meetings] serving from cache for ${customer.name}`)
    return cached
  }

  const auth = makeAuth(GCAL_TOKEN_PATH)
  const calendar = google.calendar({ version: 'v3', auth })
  const now = new Date()
  const monthBack = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const monthOut  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: monthBack.toISOString(),
    timeMax: monthOut.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 100,
  })

  const items = res.data.items ?? []
  const meetings = items
    .filter((ev) => {
      const attendees = (ev.attendees ?? []).map((a) => a.email ?? '').join(' ')
      const title    = (ev.summary     ?? '').toLowerCase()
      const agenda   = (ev.description ?? '').toLowerCase()
      const nameTerms = [customer.name, ...(customer.aliases ?? [])].map((n) => n.toLowerCase())

      // 1. Domain match (highest confidence — attendee emails)
      const domains = [customer.domain, ...(customer.aliasDomains ?? [])].filter(Boolean) as string[]
      if (domains.some((d) => attendees.includes(d))) return true

      // 2. Title match
      if (nameTerms.some((n) => title.includes(n))) return true

      // 3. Agenda / description match
      if (nameTerms.some((n) => agenda.includes(n))) return true

      return false
    })
    .map((ev) => {
      const attendees = (ev.attendees ?? [])
        .filter((a) => !a.self && !a.email?.endsWith('@redhat.com'))
        .map((a) => a.email ?? '')
        .filter(Boolean)
      return {
        title: ev.summary ?? '',
        start: ev.start?.dateTime ?? ev.start?.date ?? '',
        end:   ev.end?.dateTime   ?? ev.end?.date   ?? '',
        attendees,
        needsPrep: true,
        customers: [customer.name],
      } satisfies CalendarEvent
    })

  writeMeetingCache(customerSlug, meetings)
  return meetings
}

// ── Gmail: emails from/about this customer (last 30 days) ───────────────────

export async function fetchCustomerEmails(customer: Customer): Promise<EmailHighlight[]> {
  // ADR-013 Tier 2: serve from cache when fresh (2h TTL)
  const customerSlug = toSlug(customer.name)
  const cached = readEmailCache(customerSlug)
  if (cached) {
    console.log(`[emails] serving from cache for ${customer.name}`)
    return cached
  }

  const auth = makeAuth(GMAIL_TOKEN_PATH)
  const gmail = google.gmail({ version: 'v1', auth })

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const afterStr = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`
  // BKL-DOMAIN-01: check all domains (primary + alias) — matches Calendar search pattern at line 78
  const allDomains = [customer.domain, ...(customer.aliasDomains ?? [])].filter(Boolean) as string[]
  const query = allDomains.length > 0
    ? `(${allDomains.map(d => `from:@${d} OR to:@${d}`).join(' OR ')} OR subject:"${customer.name}") after:${afterStr}`
    : `subject:"${customer.name}" after:${afterStr}`

  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 })
  const messages = list.data.messages ?? []
  if (messages.length === 0) {
    writeEmailCache(customerSlug, [])
    return []
  }

  const details = await Promise.all(
    messages.map((msg) =>
      gmail.users.messages.get({
        userId: 'me', id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      })
    )
  )

  const emails = details.map(({ data }) => {
    const h = data.payload?.headers ?? []
    const get = (name: string) => h.find((x) => x.name === name)?.value ?? ''
    return {
      customer: customer.name,
      subject: get('Subject'),
      from: get('From'),
      date: get('Date'),
      snippet: data.snippet ?? '',
      actionRequired: /requirements?|action|urgent|asap|follow.?up|need|waiting|deadline/i.test(
        get('Subject') + ' ' + (data.snippet ?? '')
      ),
    } satisfies EmailHighlight
  })

  writeEmailCache(customerSlug, emails)
  return emails
}

// ── Drive: docs in this customer's folder ───────────────────────────────────
// Implementation lives in src/customer/docs-fetcher.ts (BKL-ARCH-23).

const ACCT_INTEL_COMPANY_CAP  = 3_000  // chars of intel.company emitted to brief XML
const ACCT_INTEL_INDUSTRY_CAP = 2_000  // chars of intel.industry emitted to brief XML
export const ACCT_INTEL_TTL_MS = (Number(process.env.INTELLIGENCE_COMPANY_TTL_DAYS) || 14) * MS_PER_DAY
const FINGERPRINT_EMAIL_LIMIT   = 20  // most recent emails included in brief fingerprint
const FINGERPRINT_MEETING_LIMIT = 10  // most recent past meetings included in brief fingerprint


export async function fetchCustomerDocs(customer: Customer): Promise<DriveFile[]> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Drive fetch timed out after 30s')), 30_000)
  )
  return Promise.race([_fetchCustomerDocsImpl(customer), timeout])
}

// ── LLM — Gemini via Vertex AI ────────────────────────────────────────────────

export function getBriefProvider(): string { return 'gemini' }

export function isBriefConfigured(): boolean {
  return !!process.env.GOOGLE_CLOUD_PROJECT &&
    (!!process.env.GEMINI_SERVICE_ACCOUNT_KEY || existsSync(GOOGLE_UNIFIED_TOKEN_PATH))
}

// BKL-AI-FP-09: capture last LLM payload for test assertions (DISALLOW_GEMINI path only)
let _lastCapturedLLMPayload: string | null = null
export function getCapturedLLMPayload(): string | null { return _lastCapturedLLMPayload }

export async function callLLM(systemPrompt: string, userPrompt: string, callType = 'brief-synthesize', customerName = 'unknown', usageOut?: { tokensUsed?: number }): Promise<string> {
  // BKL-AI-FP-01: test environment bypass — skip Gemini call, return fixture
  if (process.env.DISALLOW_GEMINI === 'true') {
    _lastCapturedLLMPayload = userPrompt
    emitAIEvent({ type: 'cache:bypass', accountId: toSlug(customerName), flow: 'brief', source: 'l1' })
    return '[GEMINI_DISABLED: fixture response for testing]'
  }

  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModelLite()  // BKL-AI-COST-01: brief synthesis is high-volume, use lite model
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set in .env — required for Gemini via Vertex AI')

  // Prefer service account key (works without cloud-platform OAuth scope on the user token).
  // Fall back to user OAuth token (requires cloud-platform scope).
  async function getAccessToken(): Promise<string> {
    let t: string | null | undefined
    const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
    if (saKeyB64) {
      const keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
      const jwtAuth = new google.auth.JWT({
        email: keyData.client_email,
        key:   keyData.private_key,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      })
      t = (await jwtAuth.getAccessToken()).token
    } else {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      t = (await auth.getAccessToken()).token
    }
    if (!t) throw new Error('Failed to get access token for Gemini — set GEMINI_SERVICE_ACCOUNT_KEY in .env')
    return t
  }

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: getAiConfig().briefSynthesisTemperature, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },  // thinkingBudget=0: gemini-2.5-flash is a thinking model; thinking tokens consume output budget, leaving ~200 tokens for actual brief. Disable thinking for brief synthesis — creative writing task, not complex reasoning.
  })

  // BKL-TEST-P0-04c: shared 429-retry helper. Exhausted retries throw
  // "Gemini 429 after 4 retries — rate limited"; non-429 errors throw the
  // canonical "Gemini API error NNN (project=... location=... model=...)"
  // message with Bearer redaction.
  const res = await fetchGeminiWithRetry(url, getAccessToken, requestBody, {
    callType, customerName, model, project, location,
    logPrefix: '[brief] callLLM',
  })

  const json = await res.json() as any
  // BKL-M52: record token usage for cost tracking
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType,
      customerName,
      inputTokens:  usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
    if (usageOut) {
      usageOut.tokensUsed = (usage.totalTokenCount ?? ((usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0)))
    }
  }
  const finishReason = json.candidates?.[0]?.finishReason
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  if (finishReason === 'MAX_TOKENS') {
    console.warn(`[brief] callLLM: Gemini output truncated (finishReason=MAX_TOKENS, callType=${callType}, customer=${customerName}, chars=${text.length})`)
  }
  return text
}

// ── Structured extraction types & constants (R17) ────────────────────────────

interface ExtractedItem {
  category: string
  text: string
  source_type: string
  source_detail: string
  confidence: string
  urgency: string
  is_new_since_last_brief: boolean
}

interface ExtractionResult {
  customer_name: string
  extraction_date: string
  last_interaction: string
  items: ExtractedItem[]
  data_gaps: string[]
}

const EXTRACTION_PROMPT = `You are extracting structured intelligence signals from customer data sources.
For each source, identify items that are NEW or CHANGED since {last_interaction_date}.

Extract into these categories:
- RISKS: Items requiring urgent attention (cases, expiring renewals, declining spend)
- CHANGES: Things that are different since last interaction
- OPPORTUNITIES: Expansion signals, positive momentum
- ACTIONS: Items requiring the SA to do something specific
- COMPETITIVE: Any competitor mentions or evaluation signals
- STAKEHOLDER: Contact engagement patterns, new contacts, silent contacts

For each item:
- Cite the exact source type and specific data point
- Rate confidence: HIGH (directly stated in data) or MEDIUM (inferred from patterns)
- Rate urgency: CRITICAL (act today), HIGH (act this week), MEDIUM (awareness)

If a source contains nothing noteworthy, omit it. Do not fabricate items.`

const EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    customer_name: { type: 'string' as const },
    extraction_date: { type: 'string' as const },
    last_interaction: { type: 'string' as const },
    items: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          category: { type: 'string' as const, enum: ['RISK', 'CHANGE', 'OPPORTUNITY', 'ACTION', 'COMPETITIVE', 'STAKEHOLDER'] },
          text: { type: 'string' as const },
          source_type: { type: 'string' as const, enum: ['subscriptions', 'subscriptions_detailed', 'support_cases', 'calendar', 'emails', 'documents', 'pipeline', 'cloud_spend'] },
          source_detail: { type: 'string' as const },
          confidence: { type: 'string' as const, enum: ['HIGH', 'MEDIUM'] },
          urgency: { type: 'string' as const, enum: ['CRITICAL', 'HIGH', 'MEDIUM'] },
          is_new_since_last_brief: { type: 'boolean' as const },
        },
        required: ['category', 'text', 'source_type', 'source_detail', 'confidence', 'urgency', 'is_new_since_last_brief'],
      },
    },
    data_gaps: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['customer_name', 'extraction_date', 'items', 'data_gaps'],
}

// ── XML source builder (R17) ────────────────────────────────────────────────
// escapeXml lives in src/customer/signals/xml-utils.ts (BKL-ARCH-23)

export interface XmlEnrichment {
  docClassifications?: Map<string, DocClassification>
  emailClassifications?: Map<string, EmailIntelligence>
  silentContacts?: SilentContact[]
  meetingPreps?: MeetingPrep[]
}

export function buildXmlSources(
  customer: Customer,
  meetings: CalendarEvent[],
  emails: EmailHighlight[],
  docs: DriveFile[],
  cases: SupportCase[],
  subscriptions: CustomerSubscription[],
  products: ProductSubscription[],
  pipeline: PipelineRecord[],
  ccsp: CCSPRecord[],
  previousBrief: string | null,
  lastBriefDate: string | null,
  lastInteraction: string,
  enrichment?: XmlEnrichment,
  accountIntelligence?: { company?: string; industry?: string; cachedAt?: string } | null,
): string {
  // BKL-ARCH-23: composition over per-source signal modules.
  // collect() (synchronous calls only — pre-supplied data) → render() pipeline.
  const fmt = (iso: string) => {
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return iso }
  }

  const today = new Date().toISOString().split('T')[0]
  const now = Date.now()
  const STALE_24H = 24 * 60 * 60 * 1000
  const scraperStatus = getStatus()
  function sourceStatusAttr(scraperName: ScraperName): string {
    const entry = scraperStatus[scraperName]
    if (!entry) return ''
    if (entry.lastError || entry.state === 'failed') {
      return ` status="scraper_failed" last_success="${escapeXml(entry.lastSuccess ?? 'never')}"`
    }
    if (entry.lastSuccess && (now - new Date(entry.lastSuccess).getTime()) > STALE_24H) {
      return ` status="stale" last_success="${escapeXml(entry.lastSuccess)}"`
    }
    return ''
  }

  const ctx: SignalRenderContext = {
    escapeXml, fmt, today, sourceStatusAttr,
    emailLimit: getAutomationConfig().briefEmailsInPrompt,
  }

  // Build bundles in canonical source order (byte-significant — see brief).
  const subsBundle = (subscriptions.length || products.length)
    ? {
        kind: 'subscriptions' as const,
        status: { syncedDate: today, staleness: 'ok' as const, lastSuccess: null, lastError: null },
        summary: subscriptions,
        // detailed is pre-filtered by collect(); we mirror that here.
        detailed: products.filter(p => !isFreeOrTrial(p)),
      }
    : null
  const casesBundle = cases.length
    ? { kind: 'cases' as const, status: { syncedDate: today, staleness: 'ok' as const, lastSuccess: null, lastError: null }, items: cases }
    : null
  const upcomingMeetings = meetings.filter(m => new Date(m.start) >= new Date())
  const meetingsBundle = upcomingMeetings.length
    ? {
        kind: 'meetings' as const,
        status: { syncedDate: today, staleness: 'ok' as const, lastSuccess: null, lastError: null },
        items: upcomingMeetings,
        preps: new Map((enrichment?.meetingPreps ?? []).map(p => [`${p.meeting.title}|${p.meeting.start}`, p] as const)),
      }
    : null
  const emailsBundle = emails.length
    ? {
        kind: 'emails' as const,
        status: { syncedDate: today, staleness: 'ok' as const, lastSuccess: null, lastError: null },
        items: emails,
        classifications: enrichment?.emailClassifications ?? new Map(),
        silentContacts: enrichment?.silentContacts ?? [],
      }
    : null
  const docsBundle = docs.length
    ? {
        kind: 'docs' as const,
        status: { syncedDate: today, staleness: 'ok' as const, lastSuccess: null, lastError: null },
        items: docs,
        classifications: enrichment?.docClassifications ?? new Map(),
      }
    : null
  const pipelineBundle = pipeline.length
    ? { kind: 'pipeline' as const, status: { syncedDate: today, staleness: 'ok' as const, lastSuccess: null, lastError: null }, items: pipeline }
    : null
  const ccspBundle = ccsp.length
    ? { kind: 'ccsp' as const, status: { syncedDate: today, staleness: 'ok' as const, lastSuccess: null, lastError: null }, items: ccsp }
    : null

  const bundles: ReadonlyArray<SignalBundle | null> = [
    subsBundle, casesBundle, meetingsBundle, emailsBundle, docsBundle, pipelineBundle, ccspBundle,
  ]

  let xml = renderCustomerHeader(customer, lastInteraction, lastBriefDate, ctx)
  if (subsBundle)     xml += subscriptionsSource.render(subsBundle, ctx) + '\n\n'
  if (casesBundle)    xml += casesSource.render(casesBundle, ctx) + '\n\n'
  if (meetingsBundle) xml += meetingsSource.render(meetingsBundle, ctx) + '\n\n'
  if (emailsBundle)   xml += emailsSource.render(emailsBundle, ctx) + '\n\n'
  if (docsBundle)     xml += docsSource.render(docsBundle, ctx) + '\n\n'
  if (pipelineBundle) xml += pipelineSource.render(pipelineBundle, ctx) + '\n\n'
  if (ccspBundle)     xml += ccspSource.render(ccspBundle, ctx) + '\n\n'
  xml += renderFailedSources(bundles, scraperStatus, ctx)
  if (previousBrief) xml += renderPreviousBrief(previousBrief, lastBriefDate, ctx)
  xml += renderAccountIntelligence(customer, accountIntelligence, ctx)
  xml += renderProductIntelligence(customer, ctx)
  return xml
}


// ── Structured LLM call with responseSchema (R17) ───────────────────────────

export async function callLLMStructured<T = any>(systemPrompt: string, userPrompt: string, responseSchema: object, callType = 'brief-extract', customerName = 'unknown'): Promise<T> {
  // BKL-AI-FP-01: test environment bypass — skip Gemini call, return minimal valid fixture
  if (process.env.DISALLOW_GEMINI === 'true') {
    emitAIEvent({ type: 'cache:bypass', accountId: toSlug(customerName), flow: 'brief', source: 'l1' })
    return { items: [], data_gaps: ['GEMINI_DISABLED'] } as unknown as T
  }

  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModelLite()  // BKL-AI-COST-01: brief extraction is high-volume, use lite model
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set in .env — required for Gemini via Vertex AI')

  async function getAccessToken(): Promise<string> {
    let t: string | null | undefined
    const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
    if (saKeyB64) {
      const keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
      const jwtAuth = new google.auth.JWT({
        email: keyData.client_email,
        key:   keyData.private_key,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      })
      t = (await jwtAuth.getAccessToken()).token
    } else {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      t = (await auth.getAccessToken()).token
    }
    if (!t) throw new Error('Failed to get access token for Gemini — set GEMINI_SERVICE_ACCOUNT_KEY in .env')
    return t
  }

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: getAiConfig().briefSynthesisTemperature,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },  // gemini-2.5-flash thinking model: disable thinking so all output tokens go to structured JSON output
      responseMimeType: 'application/json',
      responseSchema,
    },
  })

  function parseStructured(json: any): any {
    const finishReason = json.candidates?.[0]?.finishReason
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    if (!text) {
      throw new Error(`Gemini structured call returned empty response (finishReason=${finishReason ?? 'none'}, callType=${callType}, customer=${customerName})`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Gemini structured response is not valid JSON (finishReason=${finishReason ?? 'none'}, callType=${callType}, customer=${customerName}): ${text.slice(0, 200)}`)
    }
  }

  // BKL-TEST-P0-04c: shared 429-retry helper. Exhausted retries throw
  // "Gemini 429 after 4 retries — rate limited"; non-429 errors throw the
  // canonical "Gemini API error NNN (project=... location=... model=...)"
  // message with Bearer redaction.
  const res = await fetchGeminiWithRetry(url, getAccessToken, requestBody, {
    callType, customerName, model, project, location,
    logPrefix: '[brief] callLLMStructured',
  })

  const json = await res.json() as any
  // BKL-M52: record token usage for cost tracking
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType,
      customerName,
      inputTokens:  usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
  }
  return parseStructured(json)
}

// ── BKL-AI-FP-09: Delta XML source builder ───────────────────────────────────

function buildDeltaXmlSources(
  customer: Customer,
  previousBrief: string,
  changedDocs: DriveFile[],
  newDocs: DriveFile[],
  removedDocIds: string[],
  meetings: CalendarEvent[],
  emails: EmailHighlight[],
  cases: SupportCase[],
  subscriptions: CustomerSubscription[],
  products: ProductSubscription[],
  pipeline: PipelineRecord[],
  ccsp: CCSPRecord[],
  lastInteraction: string,
): string {
  const today = new Date().toISOString().split('T')[0]

  const docXml = (docs: DriveFile[], label: string) =>
    docs.length === 0 ? '' :
    `<${label}>\n${docs.map(d =>
      `  <document name="${escapeXml(d.name)}">\n${escapeXml((d.content ?? '').slice(0, 3000))}\n  </document>`
    ).join('\n')}\n</${label}>\n\n`

  const removedXml = removedDocIds.length === 0 ? '' :
    `<removed_documents>\n${removedDocIds.map(id => `  <document file_id="${escapeXml(id)}"/>`).join('\n')}\n</removed_documents>\n\n`

  const upcomingCount = meetings.filter(m => new Date(m.start) >= new Date()).length
  const openCaseCount = cases.filter(c => !(c as any).isClosed).length

  const contextXml = `<customer_context synced="${today}">
  <name>${escapeXml(customer.name)}</name>
  <ae>${escapeXml(customer.ae ?? 'Unknown')}</ae>
  <last_interaction>${escapeXml(lastInteraction)}</last_interaction>
  <meeting_count>${upcomingCount} upcoming</meeting_count>
  <email_count>${emails.length} recent</email_count>
  <open_case_count>${openCaseCount}</open_case_count>
</customer_context>\n\n`

  return `<previous_brief>
${escapeXml(previousBrief)}
</previous_brief>

${docXml(changedDocs, 'modified_documents')}${docXml(newDocs, 'new_documents')}${removedXml}${contextXml}<instructions>
Update the brief in <previous_brief> to reflect the changes above. Preserve all content from the previous brief that is not contradicted or superseded by the modified and new documents. Pay particular attention to the new and modified documents — these represent updates since the last brief was generated. Remove any references to documents listed in <removed_documents>. Do not restructure or rewrite sections unaffected by the changes. Before writing, internally identify which sections are affected by the delta. Output only the updated brief — no preamble, no change log, no explanation.

Preserve all content not superseded by the delta. Focus your updates on what changed.
</instructions>`
}

// ── Signal extraction (R17 Step 1) ──────────────────────────────────────────

async function extractSignals(xmlSources: string, lastInteractionDate: string, customerName = 'unknown'): Promise<ExtractionResult> {
  const prompt = EXTRACTION_PROMPT.replace('{last_interaction_date}', lastInteractionDate)
  // Sources placed ABOVE instructions (research: 30% quality improvement per Anthropic)
  const fullPrompt = xmlSources + '\n\n' + prompt

  const systemPrompt = `You are a customer intelligence extraction system for a Red Hat Account Solution Architect.
Your job is to identify what changed, what's at risk, and what the SA should do next.

Rules:
- Only use information present in the provided data sources
- Every claim must reference a specific source
- If data is missing or stale, flag it explicitly
- Prefer 3 verified facts over 10 uncertain ones
- Never fabricate connections between sources
- Never include generic information the SA already knows`

  return callLLMStructured(systemPrompt, fullPrompt, EXTRACTION_SCHEMA, 'brief-extract', customerName) as Promise<ExtractionResult>
}

// ── Brief generation ──────────────────────────────────────────────────────────

export async function generateBrief(
  customer: Customer,
  meetings: CalendarEvent[],
  emails: EmailHighlight[],
  docs: DriveFile[],
  cases: SupportCase[] = [],
  subscriptions: CustomerSubscription[] = [],
  products: ProductSubscription[] = [],
  pipeline: PipelineRecord[] = [],
  ccsp: CCSPRecord[] = [],
): Promise<string> {
  const fmt = (iso: string) => {
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return iso }
  }

  // ── R17: Structured extraction (Step 1 of three-step pipeline) ────────────
  // R18: Three-step pipeline (extract → rank → synthesize) with fallback to single-pass
  // R26: Sub-pipeline enrichment (doc classification, email intelligence, meeting prep)
  try {
    // BKL-AI26-fix: use actual cached date, not hardcoded "yesterday"
    const previousBriefData = readLatestBriefCache(customer.name)
    const previousBrief = previousBriefData?.text ?? null
    const lastBriefDate = previousBriefData?.date ?? null

    // Compute lastInteractionDate once (reused by buildXmlSources and extractSignals)
    const pastMeetings = meetings
      .filter(m => new Date(m.start) < new Date())
      .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
    const sortedEmails = [...emails].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    const lastInteractionDate = [pastMeetings[0]?.start, sortedEmails[0]?.date]
      .filter(Boolean)
      .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? 'unknown'

    // BKL-AI-FP-03: compute fingerprint of brief inputs after emails + meetings assembled.
    // Short-circuit on fingerprint match to avoid enrichment + Gemini entirely.
    const recentCases = (cases ?? []).filter(c => {
      const age = Date.now() - new Date((c as any).createdDate ?? (c as any).openedAt ?? 0).getTime()
      return !(c as any).isClosed && age < 90 * MS_PER_DAY
    })
    const caseCounts: Record<string, number> = {}
    for (const c of recentCases) {
      const sev = String(c.severity ?? 'unknown')
      caseCounts[sev] = (caseCounts[sev] ?? 0) + 1
    }
    const inputBundle: BriefInputBundle = {
      emailTuples: sortedEmails.slice(0, FINGERPRINT_EMAIL_LIMIT).map(e => ({
        subject: e.subject ?? '',
        sender: (e as any).from ?? '',
        date: e.date ?? '',
      })),
      meetingTuples: pastMeetings.slice(0, FINGERPRINT_MEETING_LIMIT).map(m => ({
        title: m.title ?? (m as any).summary ?? '',
        attendees: m.attendees ?? [],
        date: m.start ?? '',
      })),
      ccspTier: null,       // not available at this call site — future enhancement
      pipelineStage: null,  // not available at this call site — future enhancement
      openCaseCounts: caseCounts,
      preferencesHash: '',  // user preferences not yet wired — future enhancement
    }
    const cachedBriefForFingerprint = readBriefCache(customer.name)
    const fingerprintResult = detectFingerprintDelta(cachedBriefForFingerprint?.inputFingerprint, inputBundle)

    if (cachedBriefForFingerprint && !fingerprintResult.changed) {
      // L1 cache hit — inputs unchanged, return cached brief without any Gemini calls
      emitAIEvent({ type: 'cache:hit', accountId: toSlug(customer.name), flow: 'brief', source: 'l1', fingerprintHash: fingerprintResult.newFingerprint })
      console.log(`[brief] fingerprint cache hit for ${customer.name} — returning cached brief (no Gemini calls)`)
      return cachedBriefForFingerprint.text
    }

    // BKL-AI-FP-09: build corpus snapshot from current docs for delta detection
    const currentCorpusSnapshot: Record<string, string> = {}
    for (const doc of docs) {
      if (doc.id) currentCorpusSnapshot[doc.id] = doc.modifiedTime ?? ''
    }
    const prevCorpusSnapshot = cachedBriefForFingerprint?.docCorpusSnapshot ?? {}
    const corpusDiff = diffDocCorpus(prevCorpusSnapshot, currentCorpusSnapshot)
    const useDelta = shouldUseDeltaMode(corpusDiff, !!previousBrief)
    if (useDelta) {
      console.log(`[brief] delta mode: ${corpusDiff.unchangedDocs.length} unchanged, ${corpusDiff.changedDocs.length} changed, ${corpusDiff.newDocs.length} new, ${corpusDiff.removedDocs.length} removed`)
    } else {
      console.log(`[brief] full-run: corpus unchanged=${corpusDiff.unchangedDocs.length} changed=${corpusDiff.changedDocs.length} new=${corpusDiff.newDocs.length} hasPrev=${!!previousBrief}`)
    }

    // ── R26: Sub-pipeline enrichment — run in parallel (independent of each other)
    const enrichment: XmlEnrichment = {}
    const [docResult, emailResult, prepResult] = await Promise.allSettled([
      // ADR-013: map DriveFile.id → fileId so classifyAndExtract can hit the classification cache.
      classifyDocs(docs.map(d => ({ fileId: d.id, name: d.name, modifiedTime: d.modifiedTime, content: d.content }))),
      extractEmailIntelligence(emails),
      Promise.resolve(assembleMeetingPrep(meetings, emails, cases, subscriptions)),
    ])
    if (docResult.status === 'fulfilled') {
      enrichment.docClassifications = docResult.value
      console.log(`[brief] R26 doc-extraction: classified ${docResult.value.size} docs for ${customer.name}`)
    } else {
      console.warn(`[brief] R26 doc-extraction failed for ${customer.name}, continuing without:`, (docResult.reason as any)?.message?.slice?.(0, 200) ?? 'unknown error')
    }
    if (emailResult.status === 'fulfilled') {
      enrichment.emailClassifications = emailResult.value.classifications
      enrichment.silentContacts = emailResult.value.silentContacts
      console.log(`[brief] R26 email-extraction: ${emailResult.value.classifications.size} classified, ${emailResult.value.silentContacts.length} silent contacts for ${customer.name}`)
    } else {
      console.warn(`[brief] R26 email-extraction failed for ${customer.name}, continuing without:`, (emailResult.reason as any)?.message?.slice?.(0, 200) ?? 'unknown error')
    }
    if (prepResult.status === 'fulfilled') {
      enrichment.meetingPreps = prepResult.value
      console.log(`[brief] R26 calendar-extraction: ${prepResult.value.length} meeting preps assembled for ${customer.name}`)
    } else {
      console.warn(`[brief] R26 calendar-extraction failed for ${customer.name}, continuing without:`, (prepResult.reason as any)?.message?.slice?.(0, 200) ?? 'unknown error')
    }

    // Read account intelligence ONCE — share between XML source emission and synthesis context.
    let accountIntelligence: { company?: string; industry?: string; cachedAt?: string } | null = null
    try {
      const intelligenceSlug = toSlug(customer.name)
      const intelligencePath = `${process.env.CACHE_DIR ?? resolve(import.meta.dir, '../data/cache')}/intelligence/${intelligenceSlug}.json`
      if (existsSync(intelligencePath)) {
        accountIntelligence = JSON.parse(readFileSync(intelligencePath, 'utf-8'))
      }
    } catch { /* intelligence cache missing — brief still generates */ }

    let brief: string

    if (useDelta) {
      // BKL-AI-FP-09: Delta mode — skip Steps 1+2, go directly to delta-aware synthesis
      const changedDocFiles = docs.filter(d => d.id && corpusDiff.changedDocs.includes(d.id))
      const newDocFiles = docs.filter(d => d.id && corpusDiff.newDocs.includes(d.id))
      const deltaXml = buildDeltaXmlSources(
        customer, previousBrief!, changedDocFiles, newDocFiles,
        corpusDiff.removedDocs,
        meetings, emails, cases, subscriptions, products, pipeline, ccsp, lastInteractionDate,
      )
      emitAIEvent({ type: 'generation:start', accountId: toSlug(customer.name), flow: 'brief', source: 'l1', fingerprintHash: fingerprintResult.newFingerprint })
      const generationStart = Date.now()
      const deltaUsage: { tokensUsed?: number } = {}
      brief = await callLLM(
        'You are a Red Hat Account Solution Architect AI assistant. Update customer intelligence briefs based on changed information.',
        deltaXml,
        'brief-delta-synthesize',
        customer.name,
        deltaUsage,
      )
      emitAIEvent({ type: 'generation:complete', accountId: toSlug(customer.name), flow: 'brief', source: 'l1', fingerprintHash: fingerprintResult.newFingerprint, durationMs: Date.now() - generationStart, deltaMode: true, unchangedDocCount: corpusDiff.unchangedDocs.length, tokensUsed: deltaUsage.tokensUsed })
      console.log(`[brief] delta synthesis complete: ${brief.length} chars`)
    } else {
      // Full-run: existing 3-step pipeline (extract → rank → synthesize)
      const xmlSources = buildXmlSources(customer, meetings, emails, docs, cases, subscriptions, products, pipeline, ccsp, previousBrief, lastBriefDate, lastInteractionDate, enrichment, accountIntelligence)

      // Step 1: EXTRACT
      const extraction = await extractSignals(xmlSources, lastInteractionDate, customer.name)
      console.log(`[brief] Step 1 EXTRACT for ${customer.name}: ${extraction.items.length} items, ${extraction.data_gaps.length} gaps`)

      // Step 2: RANK (deterministic)
      const ranked = rankItems(extraction.items)
      console.log(`[brief] Step 2 RANK: top item = ${ranked[0]?.text ?? 'none'} (score: ${ranked[0]?.score ?? 0})`)

      // Step 3: SYNTHESIZE — BKL-AI22: pass upcoming meetings for meeting-prep-first briefs
      const upcomingMeetingsFor7Days = meetings.filter(m => {
        const t = new Date(m.start).getTime()
        return t >= Date.now() && t <= Date.now() + 7 * 24 * 60 * 60 * 1000
      })

      // Pass intelligence context directly to synthesis — bypasses extraction ranking
      // so strategic context (company pivot, leadership changes) always reaches the brief.
      // Reuses the accountIntelligence object already read above to avoid a second disk read.
      let intelligenceContext: { company?: string; industry?: string } | undefined
      if (accountIntelligence && (accountIntelligence.company || accountIntelligence.industry)) {
        intelligenceContext = { company: accountIntelligence.company, industry: accountIntelligence.industry }
      }

      const synthesisPrompt = buildSynthesisPrompt(ranked, lastInteractionDate, extraction.data_gaps, upcomingMeetingsFor7Days, intelligenceContext)
      const generationStart = Date.now()
      emitAIEvent({ type: 'generation:start', accountId: toSlug(customer.name), flow: 'brief', source: 'l1', fingerprintHash: fingerprintResult.newFingerprint })
      const fullUsage: { tokensUsed?: number } = {}
      brief = await callLLM(
        'You are a Red Hat Account Solution Architect AI assistant. Generate concise, actionable customer intelligence briefs.',
        synthesisPrompt,
        'brief-synthesize',
        customer.name,
        fullUsage,
      )
      emitAIEvent({ type: 'generation:complete', accountId: toSlug(customer.name), flow: 'brief', source: 'l1', fingerprintHash: fingerprintResult.newFingerprint, durationMs: Date.now() - generationStart, deltaMode: false, unchangedDocCount: 0, tokensUsed: fullUsage.tokensUsed })
      console.log(`[brief] Step 3 SYNTHESIZE: ${brief.length} chars, 3-step pipeline complete`)
    }

    return brief
  } catch (e: any) {
    // BKL-G08: Structured error logging — identify which pipeline step failed
    const step = e.message?.includes('extract') ? 'extract'
      : e.message?.includes('rank') ? 'rank'
      : e.message?.includes('synth') ? 'synthesize'
      : 'unknown'
    console.error(`[brief] Three-step pipeline failed for ${customer.name} at step=${step}: ${e.message?.slice(0, 300)}`)
    console.warn(`[brief] Falling back to single-pass for ${customer.name}`)
  }

  // ── Single-pass synthesis (existing logic — serves as fallback, and primary synthesis until R18) ──

  // Upcoming meetings (next 14 days for per-meeting prep, next 30 days for awareness)
  const upcomingMeetings = meetings.filter((m) => new Date(m.start) >= new Date())
  const meetingPrepList = upcomingMeetings.slice(0, 5)  // up to 5 meetings get individual prep
  const futureMeetingLines = upcomingMeetings.length
    ? upcomingMeetings.map((m) => `- ${m.title} on ${fmt(m.start)}${m.attendees?.length ? ` (${m.attendees.slice(0, 10).join(', ')})` : ''}`).join('\n')
    : 'No upcoming meetings.'

  const emailLines = emails.length
    ? emails.slice(0, getAutomationConfig().briefEmailsInPrompt).map((e) => `- [${fmt(e.date)}] ${e.subject}${e.snippet ? ` — ${e.snippet.slice(0, 500)}` : ''}${e.actionRequired ? ' ⚡action needed' : ''}`).join('\n')
    : 'No recent emails.'

  // Documents: include content if available, otherwise just name
  const docLines = docs.length
    ? docs.map((d) => {
        const header = `- ${d.name}${d.modifiedTime ? ` (${fmt(d.modifiedTime)})` : ''}`
        return d.content ? `${header}\n  Content excerpt: ${d.content.slice(0, 3000)}` : header
      }).join('\n')
    : 'No account documents found.'

  const caseLines = cases.length
    ? cases.map((c) => `- Sev${c.severity} | ${c.caseNumber}: ${c.summary} — ${c.daysOpen}d open${c.product ? ` [${c.product}]` : ''}`).join('\n')
    : 'No open support cases.'

  const subLines = subscriptions.length
    ? subscriptions.map((s) => `- ${s.productName} (qty: ${s.quantity}, expires: ${fmt(s.endDate)}, ${s.daysLeft}d left)`).join('\n')
    : 'No subscription data available.'

  const sheetLines = products.length
    ? products.map((p) =>
        `- ${p.sku}: ${p.productDescription} | qty: ${p.quantity} | status: ${p.status}` +
        (p.endDate ? ` | ends: ${fmt(p.endDate)}` : '')
      ).join('\n')
    : null

  const meetingPrepInstructions = meetingPrepList.length
    ? `For each upcoming meeting below, write a "### [Meeting Title] — [Date]" subsection with 2-3 specific talking points drawn from the documents and emails above. Reference document names when relevant.

Meetings to prep:
${meetingPrepList.map((m) => `- "${m.title}" on ${fmt(m.start)}`).join('\n')}`
    : 'No upcoming meetings — omit the Upcoming Meetings section.'

  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  // Fallback path: single-pass synthesis (pipeline failed or not available)

  const prompt = `You are a Red Hat Account Solution Architect's AI assistant. Generate a customer intelligence brief for the following account. Use ONLY information present in the data below — do not invent details.

Customer: ${customer.name}
AE: ${customer.ae ?? 'Unknown'} | Segment: ${customer.segment ?? 'Unknown'} | Region: ${customer.region ?? 'Unknown'}
Brief date: ${today}

══ DATA ══

SUBSCRIPTIONS (active Red Hat products):
${subLines}
${sheetLines ? `\nDETAILED PRODUCT DATA (AE spreadsheet — authoritative):\n${sheetLines}` : ''}

OPEN SUPPORT CASES:
${caseLines}

UPCOMING MEETINGS:
${futureMeetingLines}

RECENT EMAILS (last 30 days):
${emailLines}

ACCOUNT DOCUMENTS (Drive — titles + content excerpts):
${docLines}

══ BRIEF FORMAT ══

Write the brief using EXACTLY these section headers (## markdown). Be specific — names, products, dates. Each section tight and scannable.
Every factual claim must cite its source as [Source: type] (e.g. [Source: email], [Source: support case], [Source: subscription]).

## Account Overview
2-3 sentences: who this customer is, their Red Hat relationship, and current account health. Flag any renewals within 120 days.

## Pipeline Opportunities
Based on the data above, identify 2-4 specific Red Hat product opportunities. Use this signal-to-product mapping as a guide:
- VMware/Broadcom cost shock or EoGS risk → OpenShift Virtualization (migration from VMware)
- CentOS/CentOS 7 EOL or Oracle Linux → RHEL + Convert2RHEL (in-place migration)
- Manual patching or no Linux patch mgmt → Red Hat Satellite + Ansible
- Puppet/Chef/SaltStack in use → Ansible Automation Platform (YAML-based migration)
- DIY Kubernetes or Docker Swarm → OpenShift (enterprise K8s platform)
- No automation / heavy scripting → Ansible Automation Platform + Event-Driven Ansible
- WebLogic/WebSphere app servers → JBoss EAP + Quarkus (modernization)
- Multi-cloud chaos or no governance → OpenShift + Advanced Cluster Management
- AI/ML workload growth or private LLM need → OpenShift AI + RHEL AI
- App modernization initiative → OpenShift + Migration Toolkit for Applications
Format each opportunity as: "**[Detected signal]** → [Red Hat product]: [1-sentence pitch]"
Only include opportunities with evidence in the data above. Omit if no signals detected.

## Key Insights from Documents
2-4 bullets synthesizing what the Drive documents reveal about this customer's priorities, initiatives, and strategic direction. Reference document names. Omit if no documents available.

## Upcoming Meetings
${meetingPrepInstructions}

## Open Support Cases
List cases with severity, days open, and product. Flag Sev1/Sev2 urgently. If none: "✅ No open support cases."

## Talking Points & Prep
4-6 account-level bullets for your next interaction. Include renewal timing, open risks, and strategic opportunities from Pipeline Opportunities above.

Keep total brief under 250 words.`

  try {
    return await callLLM(
      'You are a Red Hat Account Solution Architect AI assistant. Be specific, concise, and actionable. Always use ## markdown headers exactly as instructed.',
      prompt,
    )
  } catch (fallbackErr: any) {
    // BKL-G08: Both three-step pipeline AND single-pass fallback failed.
    // Return a minimal brief with available raw data instead of throwing HTTP 500.
    console.error(`[brief] Single-pass fallback also failed for ${customer.name}: ${fallbackErr.message?.slice(0, 300)}`)
    console.error(`[brief] Returning minimal brief with raw data for ${customer.name}`)

    const sections: string[] = []
    sections.push(`## Account Overview\n\n*Brief generation failed — showing available raw data for ${customer.name}.*\n`)

    if (cases.length) {
      sections.push(`## Open Support Cases\n\n${cases.map(c => `- Sev${c.severity} | ${c.caseNumber}: ${c.summary} — ${c.daysOpen}d open${c.product ? ` [${c.product}]` : ''}`).join('\n')}\n`)
    }

    if (subscriptions.length) {
      sections.push(`## Active Subscriptions\n\n${subscriptions.map(s => `- ${s.productName} (qty: ${s.quantity}, expires: ${fmt(s.endDate)})`).join('\n')}\n`)
    }

    const upcoming = meetings.filter(m => new Date(m.start) >= new Date())
    if (upcoming.length) {
      sections.push(`## Upcoming Meetings\n\n${upcoming.map(m => `- ${m.title} on ${fmt(m.start)}`).join('\n')}\n`)
    }

    return sections.join('\n') || `## Account Overview\n\n*Brief generation is temporarily unavailable for ${customer.name}. Please retry later.*`
  }
}
