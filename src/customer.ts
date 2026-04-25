import { google } from 'googleapis'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import { extractText as extractPdfText } from 'unpdf'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { Customer, CalendarEvent, EmailHighlight, DriveFile, SupportCase, CustomerSubscription, ProductSubscription } from './types.ts'
import type { PipelineRecord } from './pipeline.ts'
import type { CCSPRecord } from './sheets.ts'
import { aes } from './server-state.ts'
import { readLatestBriefCache, readBriefCache, readDocContentCache, writeDocContentCache, readEmailCache, writeEmailCache, readMeetingCache, writeMeetingCache, toSlug, MS_PER_DAY } from './cache-layer.ts'
import { isFreeOrTrial } from './health-score.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { fetchGeminiWithRetry } from './gemini-fetch.ts'
import { getAiConfig, getGeminiModel, getGeminiModelLite, getAutomationConfig } from './settings-api.ts'
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
  const query = customer.domain
    ? `(from:@${customer.domain} OR to:@${customer.domain} OR subject:"${customer.name}") after:${afterStr}`
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

// MIME types that Drive can export as plain text
const EXPORTABLE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
])
const DOC_CONTENT_CAP   = 8_000   // chars per document (was 3K — too tight for meeting notes/POVs)
const TOTAL_CONTENT_CAP = 80_000  // chars per customer across all docs (was 20K — starved briefs of context)
const ACCT_INTEL_COMPANY_CAP  = 3_000  // chars of intel.company emitted to brief XML
const ACCT_INTEL_INDUSTRY_CAP = 2_000  // chars of intel.industry emitted to brief XML
const MAX_FILES_PER_CUSTOMER = 50
const DRIVE_SUBFOLDER_DEPTH  = 5
export const ACCT_INTEL_TTL_MS = (Number(process.env.INTELLIGENCE_COMPANY_TTL_DAYS) || 14) * MS_PER_DAY
const FINGERPRINT_EMAIL_LIMIT   = 20  // most recent emails included in brief fingerprint
const FINGERPRINT_MEETING_LIMIT = 10  // most recent past meetings included in brief fingerprint

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
      // Try primary name first, then aliases as fallback
      const namesToTry = [customer.name, ...(customer.aliases ?? [])]
      for (const tryName of namesToTry) {
        const match = fuzzyFindCustomerFolder(folderList, tryName)
        if (match) {
          customerFolderId = match.id
          const aliasNote = tryName !== customer.name ? ` (via alias "${tryName}")` : ''
          console.log(`[drive] Matched folder "${match.name}" for ${customer.name}${aliasNote} (under AE ${customer.ae})`)
          break
        }
      }
      if (!customerFolderId) {
        // One level deeper: AE folder → subfolder (e.g. "Accounts") → customer
        for (const sub of (custFolders.data.files ?? []).slice(0, 10)) {
          if (!sub.id) continue
          const deeper = await drive.files.list({
            q: `'${sub.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id,name)', pageSize: 100,
          })
          for (const tryName of namesToTry) {
            const deepMatch = fuzzyFindCustomerFolder(deeper.data.files ?? [], tryName)
            if (deepMatch) {
              customerFolderId = deepMatch.id
              const aliasNote = tryName !== customer.name ? ` (via alias "${tryName}")` : ''
              console.log(`[drive] Matched folder "${deepMatch.name}" for ${customer.name}${aliasNote} (under ${sub.name}/${customer.ae})`)
              break
            }
          }
          if (customerFolderId) break
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
    const legacyNamesToTry = [customer.name, ...(customer.aliases ?? [])]
    for (const aeCandidate of level1Res.data.files ?? []) {
      if (!aeCandidate.id) continue
      const custRes = await drive.files.list({
        q: `'${aeCandidate.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 100,
      })
      for (const tryName of legacyNamesToTry) {
        const match = fuzzyFindCustomerFolder(custRes.data.files ?? [], tryName)
        if (match) {
          customerFolderId = match.id
          const aliasNote = tryName !== customer.name ? ` (via alias "${tryName}")` : ''
          console.log(`[drive] Matched folder "${match.name}" for ${customer.name}${aliasNote} via parent scan`)
          break
        }
      }
      if (customerFolderId) break
    }
  }

  if (!customerFolderId) {
    console.warn('[drive] No customer folder found for', customer.name, 'under AE', customer.ae)
    return []
  }

  // BFS: collect all files from customer folder + all subfolders (depth-limited)
  // BKL-DRIVE-01: follow folder shortcuts into targets; dedup files by Drive fileId
  // (a file reachable both directly and via shortcut is only collected once) and
  // dedup folders/shortcut targets by folderId (prevents circular/duplicate traversal).
  const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString()
  const allFiles: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }> = []
  const seenFileIds = new Set<string>()                              // dedup files across all folders/shortcut targets
  const visitedFolderIds = new Set<string>([customerFolderId])       // dedup folders + shortcut targets (circular guard)
  const FOLDER_MIME = 'application/vnd.google-apps.folder'
  const queue: Array<{ id: string; depth: number }> = [{ id: customerFolderId, depth: 0 }]

  while (queue.length > 0 && allFiles.length < MAX_FILES_PER_CUSTOMER) {
    const { id: folderId, depth } = queue.shift()!

    // List files in this folder — exclude folders AND shortcuts (shortcuts are handled separately below)
    const filesRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/vnd.google-apps.shortcut' and modifiedTime > '${twoYearsAgo}' and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: Math.min(50, MAX_FILES_PER_CUSTOMER - allFiles.length),
    })
    for (const f of filesRes.data.files ?? []) {
      if (!f.id || seenFileIds.has(f.id)) continue  // skip duplicates (already collected via another path)
      seenFileIds.add(f.id)
      allFiles.push({
        id: f.id,
        name: f.name ?? '',
        mimeType: f.mimeType ?? '',
        modifiedTime: f.modifiedTime ?? undefined,
        webViewLink: f.webViewLink ?? undefined,
      })
    }

    // Queue real subfolders + folder-shortcut targets if within depth limit
    if (depth < DRIVE_SUBFOLDER_DEPTH) {
      const [subRes, shortcutRes] = await Promise.all([
        drive.files.list({
          q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id,name)',
          pageSize: 20,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        drive.files.list({
          q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
          fields: 'files(id,name,shortcutDetails(targetId,targetMimeType))',
          pageSize: 20,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      ])
      for (const sub of subRes.data.files ?? []) {
        if (!sub.id || visitedFolderIds.has(sub.id)) continue
        visitedFolderIds.add(sub.id)
        queue.push({ id: sub.id, depth: depth + 1 })
      }
      for (const sc of shortcutRes.data.files ?? []) {
        const targetId = sc.shortcutDetails?.targetId
        const targetMime = (sc.shortcutDetails as any)?.targetMimeType
        if (!targetId || targetMime !== FOLDER_MIME) continue  // only follow shortcuts to folders
        if (visitedFolderIds.has(targetId)) continue            // circular / already queued
        visitedFolderIds.add(targetId)
        queue.push({ id: targetId, depth: depth + 1 })          // treat as same-depth as a real subfolder
        console.log(`[drive-bfs] following shortcut "${sc.name}" -> ${targetId}`)
      }
    }
  }

  // BKL-AI18a: Export text content in parallel (was sequential); cap applied after collection
  const EXPORT_CONCURRENCY = 5

  // Helper: export a single file's content (returns extracted text or null)
  // ADR-013 Tier 3: content-addressed cache by (fileId, modifiedTime).
  async function exportFileContent(f: { id: string; name: string; mimeType: string; modifiedTime?: string }): Promise<string | null> {
    if (EXPORTABLE_MIME_TYPES.has(f.mimeType) && f.id) {
      // Cache hit short-circuits Drive export
      if (f.modifiedTime) {
        const cached = readDocContentCache(f.id, f.modifiedTime)
        if (cached !== null) return cached
      }
      try {
        const exportRes = await drive.files.export(
          { fileId: f.id, mimeType: 'text/plain' },
          { responseType: 'text' },
        )
        const raw = String(exportRes.data ?? '').replace(/\s+/g, ' ').trim()
        const capped = raw.slice(0, DOC_CONTENT_CAP)
        const content = capped.length > 50 ? capped : null
        if (content !== null && f.modifiedTime) {
          writeDocContentCache(f.id, f.modifiedTime, content)
        }
        return content
      } catch {
        return null
      }
    }
    return null
  }

  // Phase 1: Fire all exportable file fetches in parallel (concurrency-limited batches)
  const exportableFiles = allFiles.filter(f => EXPORTABLE_MIME_TYPES.has(f.mimeType) && f.id)
  const exportResultMap = new Map<string, string>()

  for (let i = 0; i < exportableFiles.length; i += EXPORT_CONCURRENCY) {
    const batch = exportableFiles.slice(i, i + EXPORT_CONCURRENCY)
    const settled = await Promise.allSettled(batch.map(f => exportFileContent(f)))
    for (let j = 0; j < batch.length; j++) {
      const r = settled[j]
      if (r.status === 'fulfilled' && r.value) {
        exportResultMap.set(batch[j].id, r.value)
      }
    }
  }

  // Phase 2: Assemble results sequentially, enforcing totalChars cap
  let totalChars = 0
  const results: DriveFile[] = []

  for (const f of allFiles) {
    const file: DriveFile = {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      customer: customer.name,
    }

    const preExported = exportResultMap.get(f.id)
    if (preExported && totalChars < TOTAL_CONTENT_CAP) {
      file.content = preExported
      totalChars += preExported.length
    }
    // BKL-R25b: PDF extraction — local-first, multimodal fallback
    // ADR-013 Tier 3: content-addressed cache by (fileId, modifiedTime) short-circuits both unpdf and multimodal paths.
    else if (f.mimeType === 'application/pdf' && totalChars < TOTAL_CONTENT_CAP && f.id) {
      if (f.modifiedTime) {
        const cachedPdf = readDocContentCache(f.id, f.modifiedTime)
        if (cachedPdf !== null) {
          file.content = cachedPdf
          totalChars += cachedPdf.length
          results.push(file)
          continue
        }
      }
      try {
        const pdfRes = await drive.files.get(
          { fileId: f.id, alt: 'media' },
          { responseType: 'arraybuffer' },
        )
        const pdfBytes = Buffer.from(pdfRes.data as ArrayBuffer)
        // Skip PDFs over 15MB to avoid memory pressure and Gemini inlineData limits
        if (pdfBytes.length > 15_000_000) {
          console.warn(`[docs] PDF too large to extract (${Math.round(pdfBytes.length / 1e6)}MB): ${f.name}`)
          results.push(file)
          continue
        }

        // Step 1: Attempt local text extraction with unpdf (zero token cost)
        let localText = ''
        try {
          const u8 = new Uint8Array(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength)
          const { text } = await extractPdfText(u8, { mergePages: true })
          localText = (text as string).replace(/\s+/g, ' ').trim()
        } catch {
          // Local extraction unsupported for this PDF — fall through to multimodal
        }

        if (localText.length >= 50) {
          // Local extraction succeeded — use text directly as content.
          // classifyAndExtract will call Gemini for classification; no need to
          // pre-summarize here (adds latency, risks timeout, redundant LLM call).
          console.log(`[docs] PDF ${f.name}: local extraction (${localText.length} chars), using text path`)
          const capped = localText.slice(0, DOC_CONTENT_CAP)
          file.content = capped
          totalChars += capped.length
          if (f.modifiedTime) writeDocContentCache(f.id, f.modifiedTime, capped)
        } else {
          // Step 2: Local extraction failed/empty — fall back to multimodal inlineData path
          console.log(`[docs] PDF ${f.name}: local extraction (${localText.length} chars), using multimodal fallback`)
          const b64 = pdfBytes.toString('base64')

          const project  = process.env.GOOGLE_CLOUD_PROJECT
          const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
          const model    = getGeminiModelLite()  // BKL-AI-COST-01: PDF text extraction is high-volume, use lite model

          if (project && b64.length > 0) {
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

            if (token) {
              const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
              const geminiRes = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{
                    role: 'user',
                    parts: [
                      { inlineData: { mimeType: 'application/pdf', data: b64 } },
                      { text: 'Extract the text content from this PDF document. Return only the extracted text, no commentary or formatting.' },
                    ],
                  }],
                  generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
                }),
              })
              if (geminiRes.ok) {
                const json = await geminiRes.json() as any
                const extracted = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
                const capped = extracted.replace(/\s+/g, ' ').trim().slice(0, DOC_CONTENT_CAP)
                if (capped.length > 50) {
                  file.content = capped
                  totalChars += capped.length
                  if (f.modifiedTime) writeDocContentCache(f.id, f.modifiedTime, capped)
                }
              }
            }
          }
        }
      } catch (e: any) {
        const safeName = String(f.name ?? '').replace(/[\r\n]/g, ' ').slice(0, 200)
        console.warn(`[docs] PDF extraction failed for ${safeName}: ${e?.message?.slice?.(0, 100) ?? 'unknown'}`)
        // PDF stays in results with name-only — content extraction is best-effort
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
  accountIntelligence?: { company?: string; industry?: string; cachedAt?: string } | null,
): string {
  const fmt = (iso: string) => {
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return iso }
  }

  const today = new Date().toISOString().split('T')[0]
  const now = Date.now()
  const STALE_24H = 24 * 60 * 60 * 1000

  // BKL-AI18c: scraper status for failure/staleness injection into XML
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

  let xml = `<customer>
  <name>${escapeXml(customer.name)}</name>
  <ae>${escapeXml(customer.ae ?? 'Unknown')}</ae>
  <segment>${escapeXml(customer.segment ?? 'Unknown')}</segment>
  <last_interaction>${escapeXml(lastInteraction)}</last_interaction>
  <last_brief_date>${escapeXml(lastBriefDate ?? 'none')}</last_brief_date>
</customer>\n\n`

  // Subscriptions from Supportable (CustomerSubscription)
  if (subscriptions.length) {
    xml += `<source type="subscriptions"${sourceStatusAttr('supportable')} synced="${today}" count="${subscriptions.length}">\n`
    for (const sub of subscriptions) {
      xml += `${escapeXml(sub.productName)} | qty: ${sub.quantity} | expires: ${fmt(sub.endDate)} | ${sub.daysLeft}d left | status: ${escapeXml(sub.status)}\n`
    }
    xml += `</source>\n\n`
  }

  // Detailed product data from AE spreadsheet (ProductSubscription)
  // BKL-M45: exclude free/trial/beta subs entirely — they distort intelligence signal
  const paidProducts = products.filter(p => !isFreeOrTrial(p))
  if (paidProducts.length) {
    xml += `<source type="subscriptions_detailed"${sourceStatusAttr('supportable')} synced="${today}" count="${paidProducts.length}">\n`
    for (const p of paidProducts) {
      xml += `${escapeXml(p.sku)}: ${escapeXml(p.productDescription)} | qty: ${p.quantity} | status: ${escapeXml(p.status)}${p.endDate ? ` | ends: ${fmt(p.endDate)}` : ''}\n`
    }
    xml += `</source>\n\n`
  }

  // Support cases
  if (cases.length) {
    xml += `<source type="support_cases"${sourceStatusAttr('rh-cases')} synced="${today}" count="${cases.length}">\n`
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
    for (const e of emails.slice(0, getAutomationConfig().briefEmailsInPrompt)) {
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
    xml += `<source type="pipeline"${sourceStatusAttr('sf-pipeline')} synced="${today}" count="${pipeline.length}">\n`
    for (const opp of pipeline) {
      xml += `${escapeXml(opp.oppName)} | stage: ${escapeXml(opp.forecastCategory)} | amount: $${opp.acv} | close: ${escapeXml(opp.closeDate)}\n`
    }
    xml += `</source>\n\n`
  }

  // Cloud spend (CCSP)
  if (ccsp.length) {
    xml += `<source type="cloud_spend"${sourceStatusAttr('ccsp')} synced="${today}" count="${ccsp.length}">\n`
    for (const row of ccsp) {
      xml += `${escapeXml(row.cloudPartner)} | ${escapeXml(row.quarter)} | ACV+: $${row.acvPlus} | close: ${escapeXml(row.closeDate)}\n`
    }
    xml += `</source>\n\n`
  }

  // BKL-AI18c: Emit empty source tags for failed scrapers with no data, so Gemini knows data is missing
  const failedSourceMap: [ScraperName, string, boolean][] = [
    ['supportable', 'subscriptions', subscriptions.length > 0],
    ['rh-cases', 'support_cases', cases.length > 0],
    ['sf-pipeline', 'pipeline', pipeline.length > 0],
    ['ccsp', 'cloud_spend', ccsp.length > 0],
  ]
  for (const [scraper, sourceType, hasData] of failedSourceMap) {
    if (!hasData) {
      const entry = scraperStatus[scraper]
      if (entry && (entry.lastError || entry.state === 'failed')) {
        xml += `<source type="${sourceType}" status="scraper_failed" last_success="${escapeXml(entry.lastSuccess ?? 'never')}" count="0" />\n\n`
      }
    }
  }

  // Previous brief for delta detection
  if (previousBrief) {
    xml += `<source type="previous_brief" date="${escapeXml(lastBriefDate ?? 'unknown')}">\n${previousBrief}\n</source>\n\n`
  }

  // Account intelligence (ADR-008 dual-write cache)
  // Prefer caller-provided intelligence object; fall back to disk read for backward compat.
  const intelligenceSlug = toSlug(customer.name)
  let intel: { company?: string; industry?: string; cachedAt?: string } | null = null
  if (accountIntelligence !== undefined) {
    intel = accountIntelligence
  } else {
    const intelligencePath = `${process.env.CACHE_DIR ?? resolve(import.meta.dir, '../data/cache')}/intelligence/${intelligenceSlug}.json`
    try {
      if (existsSync(intelligencePath)) {
        intel = JSON.parse(readFileSync(intelligencePath, 'utf-8'))
      }
    } catch { /* intelligence cache missing */ }
  }
  if (intel && (intel.company || intel.industry)) {
    const age = intel.cachedAt ? Date.now() - new Date(intel.cachedAt).getTime() : Infinity
    if (age >= ACCT_INTEL_TTL_MS) {
      const ageDays = Math.round(age / MS_PER_DAY)
      xml += `<source type="account_intelligence" status="stale" cached="${intel.cachedAt}">Account intelligence is stale (${ageDays}d old) — regeneration pending.</source>\n\n`
      emitAIEvent({ type: 'cache:stale', flow: 'brief', source: 'l4', accountId: intelligenceSlug })
    } else {
      xml += `<source type="account_intelligence" status="fresh" cached="${intel.cachedAt}">\n`
      if (intel.company) xml += `[Company Intelligence]\n${escapeXml(String(intel.company).slice(0, ACCT_INTEL_COMPANY_CAP))}\n`
      if (intel.industry) xml += `\n[Industry Analysis]\n${escapeXml(String(intel.industry).slice(0, ACCT_INTEL_INDUSTRY_CAP))}\n`
      xml += `</source>\n\n`
    }
  }

  // Product intelligence — per-product SA talking points (Wave 4 Phase 2c)
  const customerSlug = customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  try {
    const productConfigs = loadProductConfig()
    for (const productCfg of productConfigs) {
      const intel = getCachedCustomerProductIntel(productCfg.slug, customerSlug)
      if (!intel || intel.relevanceScore === 'NONE') continue
      xml += `<source type="product_intelligence" product="${escapeXml(productCfg.slug)}" relevance="${escapeXml(intel.relevanceScore)}" generated="${escapeXml(intel.generatedAt)}">\n`
      xml += `[Priority Action]\n${escapeXml(intel.priorityAction)}\n\n`
      if (intel.roadmapRelevance.length) {
        xml += `[Roadmap Talking Points]\n`
        for (const r of intel.roadmapRelevance) {
          xml += `- ${escapeXml(r.feature)}: ${escapeXml(r.talkingPoint)}\n`
        }
        xml += '\n'
      }
      if (intel.expansionOpportunities.length) {
        xml += `[Expansion Opportunities]\n`
        for (const e of intel.expansionOpportunities) {
          xml += `- ${escapeXml(e.gap)} → ${escapeXml(e.product)}: ${escapeXml(e.rationale)}\n`
        }
        xml += '\n'
      }
      if (intel.caseAlignment.length) {
        xml += `[Case Alignment]\n`
        for (const ca of intel.caseAlignment) {
          xml += `- Case ${escapeXml(ca.caseNumber)}: ${escapeXml(ca.roadmapFix)} (${escapeXml(ca.timeline)})\n`
        }
        xml += '\n'
      }
      if (intel.competitiveAngle) {
        xml += `[Competitive Angle]\n${escapeXml(intel.competitiveAngle)}\n\n`
      }
      xml += `</source>\n\n`
    }
  } catch { /* product intel cache missing or config unreadable */ }

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
