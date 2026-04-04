import { google } from 'googleapis'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { Customer, CalendarEvent, EmailHighlight, DriveFile, SupportCase, CustomerSubscription, ProductSubscription } from './types.ts'
import type { PipelineRecord } from './pipeline.ts'
import type { CCSPRecord } from './sheets.ts'
import { aes } from './server-state.ts'
import { readLatestBriefCache } from './cache-layer.ts'
import { isFreeOrTrial } from './health-score.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { rankItems, buildSynthesisPrompt } from './brief-pipeline.ts'
import { classifyDocs } from './doc-extraction.ts'
import { extractEmailIntelligence } from './email-extraction.ts'
import { assembleMeetingPrep } from './calendar-extraction.ts'
import type { DocClassification } from './doc-extraction.ts'
import type { EmailIntelligence, SilentContact } from './email-extraction.ts'
import type { MeetingPrep } from './calendar-extraction.ts'

const CONFIG_DIR_PATH   = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const GMAIL_TOKEN_PATH  = process.env.GMAIL_TOKEN       ?? resolve(CONFIG_DIR_PATH, '.gmail-token.json')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN      ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')
const GCAL_TOKEN_PATH   = process.env.GCAL_TOKEN        ?? resolve(CONFIG_DIR_PATH, '.calendar-token.json')

// ── Calendar: meetings for this customer (next 30 days) ──────────────────────

export async function fetchCustomerMeetings(customer: Customer): Promise<CalendarEvent[]> {
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
  return items
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
}

// ── Gmail: emails from/about this customer (last 30 days) ───────────────────

export async function fetchCustomerEmails(customer: Customer): Promise<EmailHighlight[]> {
  const auth = makeAuth(GMAIL_TOKEN_PATH)
  const gmail = google.gmail({ version: 'v1', auth })

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const afterStr = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`
  const query = customer.domain
    ? `(from:@${customer.domain} OR to:@${customer.domain} OR subject:"${customer.name}") after:${afterStr}`
    : `subject:"${customer.name}" after:${afterStr}`

  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 })
  const messages = list.data.messages ?? []
  if (messages.length === 0) return []

  const details = await Promise.all(
    messages.map((msg) =>
      gmail.users.messages.get({
        userId: 'me', id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      })
    )
  )

  return details.map(({ data }) => {
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
}

// ── Drive: docs in this customer's folder ───────────────────────────────────

// MIME types that Drive can export as plain text
const EXPORTABLE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
])
const DOC_CONTENT_CAP   = 8_000   // chars per document (was 3K — too tight for meeting notes/POVs)
const TOTAL_CONTENT_CAP = 80_000  // chars per customer across all docs (was 20K — starved briefs of context)
const MAX_FILES_PER_CUSTOMER = 50
const DRIVE_SUBFOLDER_DEPTH  = 5

// Normalize name for fuzzy matching — strip legal suffixes, punctuation, lowercase
function normalizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s+(inc|llc|ltd|corp|corporation|incorporated|limited|co|group|holdings|international|technologies|logistics|solutions|services|foods|systems|global|networks|software|health sciences|cancer center|cancer research)\.?\s*$/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

function folderMatchScore(folderName: string, customerName: string): number {
  const fn = normalizeFolderName(folderName)
  const cn = normalizeFolderName(customerName)
  if (fn === cn) return 1
  if (fn.includes(cn) || cn.includes(fn)) return 0.9
  const fWords = new Set(fn.split(/\s+/).filter(w => w.length > 2))
  const cWords = cn.split(/\s+/).filter(w => w.length > 2)
  if (fWords.size === 0 || cWords.length === 0) return 0
  const overlap = cWords.filter(w => fWords.has(w)).length
  return overlap / Math.max(fWords.size, cWords.length)
}

function fuzzyFindCustomerFolder(
  folders: { id?: string | null; name?: string | null }[],
  customerName: string,
): { id: string; name: string } | undefined {
  let bestScore = 0
  let bestFolder: { id: string; name: string } | undefined
  for (const f of folders) {
    if (!f.id || !f.name) continue
    const score = folderMatchScore(f.name, customerName)
    if (score > bestScore) { bestScore = score; bestFolder = { id: f.id, name: f.name } }
  }
  return bestScore >= 0.5 ? bestFolder : undefined
}

async function _fetchCustomerDocsImpl(customer: Customer): Promise<DriveFile[]> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  let customerFolderId: string | undefined

  // ── Priority 1: Per-customer driveFolderId (exact, no search needed) ────────
  if (customer.driveFolderId) {
    customerFolderId = customer.driveFolderId
    console.log(`[drive] Using per-customer folder ID for ${customer.name}`)
  }

  // ── Priority 2: AE's driveFolderId → fuzzy-match customer subfolder ─────────
  if (!customerFolderId) {
    const ae = aes.find(a => a.name === customer.ae)
    const aeFolderId = ae?.driveFolderId
    if (aeFolderId) {
      const custFolders = await drive.files.list({
        q: `'${aeFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 200,
      })
      const folderList = custFolders.data.files ?? []
      const match = fuzzyFindCustomerFolder(folderList, customer.name)
      if (match) {
        customerFolderId = match.id
        console.log(`[drive] Matched folder "${match.name}" for ${customer.name} (under AE ${customer.ae})`)
      } else {
        // One level deeper: AE folder → subfolder (e.g. "Accounts") → customer
        for (const sub of (custFolders.data.files ?? []).slice(0, 10)) {
          if (!sub.id) continue
          const deeper = await drive.files.list({
            q: `'${sub.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id,name)', pageSize: 100,
          })
          const deepMatch = fuzzyFindCustomerFolder(deeper.data.files ?? [], customer.name)
          if (deepMatch) {
            customerFolderId = deepMatch.id
            console.log(`[drive] Matched folder "${deepMatch.name}" for ${customer.name} (under ${sub.name}/${customer.ae})`)
            break
          }
        }
      }
    }
  }

  // ── Priority 3: Global AE_PARENT_FOLDER_ID fallback (legacy) ───────────────
  if (!customerFolderId) {
    const parentId = process.env.AE_PARENT_FOLDER_ID
    if (!parentId) {
      console.warn('[drive] No folder source for', customer.name, '— no per-customer/AE folder ID and AE_PARENT_FOLDER_ID not set')
      return []
    }
    // Scan parent → AE → customer (old path)
    const level1Res = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 50,
    })
    for (const aeCandidate of level1Res.data.files ?? []) {
      if (!aeCandidate.id) continue
      const custRes = await drive.files.list({
        q: `'${aeCandidate.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 100,
      })
      const match = fuzzyFindCustomerFolder(custRes.data.files ?? [], customer.name)
      if (match) {
        customerFolderId = match.id
        console.log(`[drive] Matched folder "${match.name}" for ${customer.name} via parent scan`)
        break
      }
    }
  }

  if (!customerFolderId) {
    console.warn('[drive] No customer folder found for', customer.name, 'under AE', customer.ae)
    return []
  }

  // BFS: collect all files from customer folder + all subfolders (depth-limited)
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
  const allFiles: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }> = []
  const queue: Array<{ id: string; depth: number }> = [{ id: customerFolderId, depth: 0 }]

  while (queue.length > 0 && allFiles.length < MAX_FILES_PER_CUSTOMER) {
    const { id: folderId, depth } = queue.shift()!

    // List files in this folder
    const filesRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and modifiedTime > '${sixMonthsAgo}' and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: Math.min(50, MAX_FILES_PER_CUSTOMER - allFiles.length),
    })
    for (const f of filesRes.data.files ?? []) {
      allFiles.push({
        id: f.id ?? '',
        name: f.name ?? '',
        mimeType: f.mimeType ?? '',
        modifiedTime: f.modifiedTime ?? undefined,
        webViewLink: f.webViewLink ?? undefined,
      })
    }

    // Queue subfolders if within depth limit
    if (depth < DRIVE_SUBFOLDER_DEPTH) {
      const subRes = await drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 20,
      })
      for (const sub of subRes.data.files ?? []) {
        if (sub.id) queue.push({ id: sub.id, depth: depth + 1 })
      }
    }
  }

  // Export text content for Google Docs/Slides; cap per-doc and total
  let totalChars = 0
  const results: DriveFile[] = []

  for (const f of allFiles) {
    const file: DriveFile = {
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      customer: customer.name,
    }

    if (EXPORTABLE_MIME_TYPES.has(f.mimeType) && totalChars < TOTAL_CONTENT_CAP && f.id) {
      try {
        const exportRes = await drive.files.export(
          { fileId: f.id, mimeType: 'text/plain' },
          { responseType: 'text' },
        )
        const raw = String(exportRes.data ?? '').replace(/\s+/g, ' ').trim()
        const capped = raw.slice(0, DOC_CONTENT_CAP)
        if (capped.length > 50) {  // skip near-empty docs
          file.content = capped
          totalChars += capped.length
        }
      } catch {
        // Export failed (permissions, unsupported format) — use name only
      }
    }

    results.push(file)
  }

  return results
}

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

async function callLLM(systemPrompt: string, userPrompt: string, callType = 'brief-synthesize', customerName = 'unknown'): Promise<string> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set in .env — required for Gemini via Vertex AI')

  // Prefer service account key (works without cloud-platform OAuth scope on the user token).
  // Fall back to user OAuth token (requires cloud-platform scope).
  let token: string | null | undefined
  const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
  if (saKeyB64) {
    const keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
    const jwtAuth = new google.auth.JWT({
      email: keyData.client_email,
      key:   keyData.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    token = (await jwtAuth.getAccessToken()).token
  } else {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    token = (await auth.getAccessToken()).token
  }
  if (!token) throw new Error('Failed to get access token for Gemini — set GEMINI_SERVICE_ACCOUNT_KEY in .env')

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status} (project=${project} location=${location} model=${model}): ${err.slice(0, 300)}`)
  }
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
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
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
          source_type: { type: 'string' as const, enum: ['subscriptions', 'support_cases', 'calendar', 'emails', 'documents', 'pipeline', 'cloud_spend'] },
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

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface XmlEnrichment {
  docClassifications?: Map<string, DocClassification>
  emailClassifications?: Map<string, EmailIntelligence>
  silentContacts?: SilentContact[]
  meetingPreps?: MeetingPrep[]
}

function buildXmlSources(
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
): string {
  const fmt = (iso: string) => {
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return iso }
  }

  const today = new Date().toISOString().split('T')[0]

  let xml = `<customer>
  <name>${escapeXml(customer.name)}</name>
  <ae>${escapeXml(customer.ae ?? 'Unknown')}</ae>
  <segment>${escapeXml(customer.segment ?? 'Unknown')}</segment>
  <last_interaction>${escapeXml(lastInteraction)}</last_interaction>
  <last_brief_date>${escapeXml(lastBriefDate ?? 'none')}</last_brief_date>
</customer>\n\n`

  // Subscriptions from Supportable (CustomerSubscription)
  if (subscriptions.length) {
    xml += `<source type="subscriptions" synced="${today}" count="${subscriptions.length}">\n`
    for (const sub of subscriptions) {
      xml += `${escapeXml(sub.productName)} | qty: ${sub.quantity} | expires: ${fmt(sub.endDate)} | ${sub.daysLeft}d left | status: ${escapeXml(sub.status)}\n`
    }
    xml += `</source>\n\n`
  }

  // Detailed product data from AE spreadsheet (ProductSubscription)
  // BKL-M45: exclude free/trial/beta subs entirely — they distort intelligence signal
  const paidProducts = products.filter(p => !isFreeOrTrial(p))
  if (paidProducts.length) {
    xml += `<source type="subscriptions_detailed" synced="${today}" count="${paidProducts.length}">\n`
    for (const p of paidProducts) {
      xml += `${escapeXml(p.sku)}: ${escapeXml(p.productDescription)} | qty: ${p.quantity} | status: ${escapeXml(p.status)}${p.endDate ? ` | ends: ${fmt(p.endDate)}` : ''}\n`
    }
    xml += `</source>\n\n`
  }

  // Support cases
  if (cases.length) {
    xml += `<source type="support_cases" synced="${today}" count="${cases.length}">\n`
    for (const c of cases) {
      xml += `Sev${c.severity} | ${escapeXml(c.caseNumber)}: ${escapeXml(c.summary)} — ${c.daysOpen}d open${c.product ? ` [${escapeXml(c.product)}]` : ''}\n`
    }
    xml += `</source>\n\n`
  }

  // Calendar — upcoming meetings (enriched with meeting prep when available)
  const upcomingMeetings = meetings.filter(m => new Date(m.start) >= new Date())
  if (upcomingMeetings.length) {
    xml += `<source type="calendar" window="next_30_days" count="${upcomingMeetings.length}">\n`
    for (const m of upcomingMeetings) {
      xml += `${escapeXml(m.title)} on ${fmt(m.start)}${m.attendees?.length ? ` (${m.attendees.slice(0, 10).map(escapeXml).join(', ')})` : ''}\n`
      // Enrich with meeting prep data if available
      const prep = enrichment?.meetingPreps?.find(p => p.meeting.title === m.title && p.meeting.start === m.start)
      if (prep) {
        if (prep.attendeeContext.length) {
          xml += `  <attendee_context>\n`
          for (const ac of prep.attendeeContext) {
            xml += `    ${escapeXml(ac.name)}: last interaction ${escapeXml(ac.lastInteraction ?? 'unknown')}, frequency: ${escapeXml(ac.emailFrequency ?? 'unknown')}\n`
          }
          xml += `  </attendee_context>\n`
        }
        xml += `  <health_signals cases="${escapeXml(prep.healthSignals.cases)}" renewals="${escapeXml(prep.healthSignals.renewals)}" />\n`
        if (prep.competitiveContext.length) {
          xml += `  <competitive_context>${prep.competitiveContext.map(escapeXml).join('; ')}</competitive_context>\n`
        }
        if (prep.stakeholderCoverage.silent.length) {
          xml += `  <silent_attendees>${prep.stakeholderCoverage.silent.map(escapeXml).join(', ')}</silent_attendees>\n`
        }
        if (prep.stakeholderCoverage.missing.length) {
          xml += `  <missing_stakeholders>${prep.stakeholderCoverage.missing.map(escapeXml).join(', ')}</missing_stakeholders>\n`
        }
      }
    }
    xml += `</source>\n\n`
  }

  // Emails (enriched with classification when available)
  if (emails.length) {
    xml += `<source type="emails" window="last_30_days" count="${emails.length}">\n`
    for (const e of emails.slice(0, 20)) {
      const emailKey = `${e.from}|${e.subject}|${e.date}`
      const intel = enrichment?.emailClassifications?.get(emailKey)
      const classTag = intel ? ` [${intel.classification}]` : (e.actionRequired ? ' [ACTION REQUIRED]' : '')
      xml += `[${fmt(e.date)}] ${escapeXml(e.subject)}${e.snippet ? ` — ${escapeXml(e.snippet.slice(0, 500))}` : ''}${classTag}\n`
      if (intel?.competitive_mentions?.length) {
        for (const cm of intel.competitive_mentions) {
          xml += `  ⚠ Competitive: ${escapeXml(cm.competitor)} (${cm.risk_level}) — ${escapeXml(cm.context.slice(0, 120))}\n`
        }
      }
      if (intel?.action_items?.length) {
        for (const ai of intel.action_items) {
          xml += `  → Action: ${escapeXml(ai.text)}${ai.deadline ? ` (by ${escapeXml(ai.deadline)})` : ''}\n`
        }
      }
    }
    // Silent contacts section
    if (enrichment?.silentContacts?.length) {
      xml += `  <silent_contacts>\n`
      for (const sc of enrichment.silentContacts) {
        xml += `    ${escapeXml(sc.name ?? sc.email)}: ${sc.daysSilent}d silent (was ${sc.previousFrequency}/mo, now ${sc.currentFrequency}/mo)\n`
      }
      xml += `  </silent_contacts>\n`
    }
    xml += `</source>\n\n`
  }

  // Documents (enriched with classification when available)
  // BKL-AI08: Account Intelligence docs (company brief, industry analysis) in the
  // "Account Intelligence" subfolder are automatically picked up here by fetchCustomerDocs()
  // which uses BFS with DRIVE_SUBFOLDER_DEPTH=5. No explicit wiring needed — done by design.
  if (docs.length) {
    xml += `<source type="documents" synced="${today}" count="${docs.length}">\n`
    for (const d of docs) {
      const cls = enrichment?.docClassifications?.get(d.name)
      const typeTag = cls && cls.type !== 'OTHER' ? ` [${cls.type}]` : ''
      const header = `${escapeXml(d.name)}${d.modifiedTime ? ` (${fmt(d.modifiedTime)})` : ''}${typeTag}`
      xml += d.content ? `${header}\n  Content excerpt: ${escapeXml(d.content.slice(0, 3000))}\n` : `${header}\n`
      if (cls) {
        if (cls.action_items.length) {
          xml += `  <action_items>\n`
          for (const ai of cls.action_items) {
            xml += `    ${escapeXml(ai.text)}${ai.owner ? ` (owner: ${escapeXml(ai.owner)})` : ''}${ai.deadline ? ` (by ${escapeXml(ai.deadline)})` : ''}\n`
          }
          xml += `  </action_items>\n`
        }
        if (cls.decisions.length) {
          xml += `  <decisions>\n`
          for (const dec of cls.decisions) {
            xml += `    ${escapeXml(dec.text)}\n`
          }
          xml += `  </decisions>\n`
        }
        if (cls.stakeholders_mentioned.length) {
          xml += `  <stakeholders>\n`
          for (const sh of cls.stakeholders_mentioned) {
            xml += `    ${escapeXml(sh.name)}${sh.role ? ` (${escapeXml(sh.role)})` : ''}${sh.sentiment ? ` — ${escapeXml(sh.sentiment)}` : ''}\n`
          }
          xml += `  </stakeholders>\n`
        }
        if (cls.competitive_mentions.length) {
          xml += `  <competitive_mentions>\n`
          for (const cm of cls.competitive_mentions) {
            xml += `    ${escapeXml(cm.competitor)}: ${escapeXml(cm.context)}\n`
          }
          xml += `  </competitive_mentions>\n`
        }
        if (cls.strategic_signals?.length &&
            (cls.type === 'COMPANY_INTELLIGENCE' || cls.type === 'INDUSTRY_ANALYSIS')) {
          xml += `  <strategic_signals priority="high">\n`
          for (const ss of cls.strategic_signals) {
            xml += `    [${ss.signal_type.toUpperCase()}] ${escapeXml(ss.text)}${ss.significance ? ` — significance: ${escapeXml(ss.significance)}` : ''}\n`
          }
          xml += `  </strategic_signals>\n`
        }
      }
    }
    xml += `</source>\n\n`
  }

  // Pipeline opportunities
  if (pipeline.length) {
    xml += `<source type="pipeline" synced="${today}" count="${pipeline.length}">\n`
    for (const opp of pipeline) {
      xml += `${escapeXml(opp.oppName)} | stage: ${escapeXml(opp.forecastCategory)} | amount: $${opp.acv} | close: ${escapeXml(opp.closeDate)}\n`
    }
    xml += `</source>\n\n`
  }

  // Cloud spend (CCSP)
  if (ccsp.length) {
    xml += `<source type="cloud_spend" synced="${today}" count="${ccsp.length}">\n`
    for (const row of ccsp) {
      xml += `${escapeXml(row.cloudPartner)} | ${escapeXml(row.quarter)} | ACV+: $${row.acvPlus} | close: ${escapeXml(row.closeDate)}\n`
    }
    xml += `</source>\n\n`
  }

  // Previous brief for delta detection
  if (previousBrief) {
    xml += `<source type="previous_brief" date="${escapeXml(lastBriefDate ?? 'unknown')}">\n${previousBrief}\n</source>\n\n`
  }

  // Account intelligence (ADR-008 dual-write cache)
  const intelligenceSlug = customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const intelligencePath = `${process.env.CACHE_DIR ?? resolve(import.meta.dir, '../data/cache')}/intelligence/${intelligenceSlug}.json`
  try {
    if (existsSync(intelligencePath)) {
      const intel = JSON.parse(readFileSync(intelligencePath, 'utf-8'))
      if (intel.company || intel.industry) {
        xml += `<source type="account_intelligence" cached="${intel.cachedAt}">\n`
        if (intel.company) xml += `[Company Intelligence]\n${escapeXml(String(intel.company).slice(0, 3000))}\n`
        if (intel.industry) xml += `\n[Industry Analysis]\n${escapeXml(String(intel.industry).slice(0, 2000))}\n`
        xml += `</source>\n\n`
      }
    }
  } catch { /* intelligence cache missing */ }

  return xml
}

// ── Structured LLM call with responseSchema (R17) ───────────────────────────

async function callLLMStructured(systemPrompt: string, userPrompt: string, responseSchema: object, callType = 'brief-extract', customerName = 'unknown'): Promise<any> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set in .env — required for Gemini via Vertex AI')

  let token: string | null | undefined
  const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
  if (saKeyB64) {
    const keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
    const jwtAuth = new google.auth.JWT({
      email: keyData.client_email,
      key:   keyData.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    token = (await jwtAuth.getAccessToken()).token
  } else {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    token = (await auth.getAccessToken()).token
  }
  if (!token) throw new Error('Failed to get access token for Gemini — set GEMINI_SERVICE_ACCOUNT_KEY in .env')

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema,
      },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status} (structured, project=${project} location=${location} model=${model}): ${err.slice(0, 300)}`)
  }
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
  const finishReason = json.candidates?.[0]?.finishReason
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  if (!text) {
    throw new Error(`Gemini structured call returned empty response (finishReason=${finishReason ?? 'none'}, callType=${callType}, customer=${customerName})`)
  }
  try {
    return JSON.parse(text)
  } catch (parseErr: any) {
    throw new Error(`Gemini structured response is not valid JSON (finishReason=${finishReason ?? 'none'}, callType=${callType}, customer=${customerName}): ${text.slice(0, 200)}`)
  }
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

// ── Previous brief lookup (R17) ─────────────────────────────────────────────

function findPreviousBrief(customerName: string): string | null {
  // Brief cache files are date-stamped: {slug}-{YYYY-MM-DD}.json
  // Look for yesterday's brief
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const dateStr = yesterday.toLocaleDateString('en-CA') // YYYY-MM-DD
  const slug = customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')
  const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../data/cache')
  const path = `${CACHE_DIR}/${slug}-${dateStr}.json`
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      return data.text ?? null
    }
  } catch {
    // Previous brief not found — that's fine
  }
  return null
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

    // ── R26: Sub-pipeline enrichment — run in parallel (independent of each other)
    const enrichment: XmlEnrichment = {}
    const [docResult, emailResult, prepResult] = await Promise.allSettled([
      classifyDocs(docs),
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

    const xmlSources = buildXmlSources(customer, meetings, emails, docs, cases, subscriptions, products, pipeline, ccsp, previousBrief, lastBriefDate, lastInteractionDate, enrichment)

    // Step 1: EXTRACT
    const extraction = await extractSignals(xmlSources, lastInteractionDate, customer.name)
    console.log(`[brief] Step 1 EXTRACT for ${customer.name}: ${extraction.items.length} items, ${extraction.data_gaps.length} gaps`)

    // Step 2: RANK (deterministic)
    const ranked = rankItems(extraction.items)
    console.log(`[brief] Step 2 RANK: top item = ${ranked[0]?.text ?? 'none'} (score: ${ranked[0]?.score ?? 0})`)

    // Step 3: SYNTHESIZE
    const synthesisPrompt = buildSynthesisPrompt(ranked, lastInteractionDate, extraction.data_gaps)
    const brief = await callLLM(
      'You are a Red Hat Account Solution Architect AI assistant. Generate concise, actionable customer intelligence briefs.',
      synthesisPrompt,
      'brief-synthesize',
      customer.name,
    )
    console.log(`[brief] Step 3 SYNTHESIZE: ${brief.length} chars, 3-step pipeline complete`)

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
    ? emails.slice(0, 20).map((e) => `- [${fmt(e.date)}] ${e.subject}${e.snippet ? ` — ${e.snippet.slice(0, 500)}` : ''}${e.actionRequired ? ' ⚡action needed' : ''}`).join('\n')
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
