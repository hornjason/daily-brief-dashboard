import { google } from 'googleapis'
// PAI inference — optional, only available when running with PAI installed locally
import { resolve } from 'path'
import { makeAuth } from './google.ts'
import type { Customer, CalendarEvent, EmailHighlight, DriveFile, SupportCase, CustomerSubscription, ProductSubscription } from './types.ts'

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
      const title = (ev.summary ?? '').toLowerCase()
      const attendees = (ev.attendees ?? []).map((a) => a.email ?? '').join(' ')
      const nameMatch = title.includes(customer.name.toLowerCase())
      const domainMatch = customer.domain
        ? attendees.includes(customer.domain)
        : false
      return nameMatch || domainMatch
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

export async function fetchCustomerDocs(customer: Customer): Promise<DriveFile[]> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  const parentId = process.env.AE_PARENT_FOLDER_ID
  if (!parentId) return []

  // Find the AE folder for this customer using customer.ae
  const aeName = customer.ae
  const aeFoldersRes = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 50,
  })
  const aeFolder = aeName
    ? (aeFoldersRes.data.files ?? []).find((f) => f.name?.toLowerCase().includes(aeName.split(' ')[0]?.toLowerCase() ?? aeName.toLowerCase()))
    : aeFoldersRes.data.files?.[0]
  if (!aeFolder?.id) return []

  // Find this customer's subfolder — case-insensitive match
  const allFoldersRes = await drive.files.list({
    q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 100,
  })
  const customerFolder = (allFoldersRes.data.files ?? []).find((f) => {
    const folderName = f.name?.toLowerCase() ?? ''
    const custName = customer.name.toLowerCase()
    return folderName.includes(custName) || custName.includes(folderName)
  })
  if (!customerFolder?.id) return []

  // All files in this customer's folder (last 90 days)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const res = await drive.files.list({
    q: `'${customerFolder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and modifiedTime > '${ninetyDaysAgo}' and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: 20,
  })

  return (res.data.files ?? []).map((f) => ({
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    modifiedTime: f.modifiedTime ?? undefined,
    webViewLink: f.webViewLink ?? undefined,
    customer: customer.name,
  }))
}

// ── LLM provider routing ──────────────────────────────────────────────────────

export function getBriefProvider(): string {
  return (process.env.LLM_PROVIDER ?? 'pai').toLowerCase()
}

export function isBriefConfigured(): boolean {
  const p = getBriefProvider()
  if (p === 'pai')       return true  // PAI inference always available
  if (p === 'openai')      return !!process.env.OPENAI_API_KEY
  if (p === 'anthropic')   return !!process.env.ANTHROPIC_API_KEY
  if (p === 'claude-code') return Bun.which('claude') !== null
  if (p === 'gemini')      return false  // manual only — no API integration
  if (p === 'ollama')      return true   // Ollama assumed local, no key needed
  return false
}

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const provider = getBriefProvider()

  if (provider === 'openai' || provider === 'ollama') {
    const baseUrl = provider === 'ollama'
      ? (process.env.OLLAMA_URL ?? 'http://localhost:11434') + '/v1'
      : 'https://api.openai.com/v1'
    const model = provider === 'ollama'
      ? (process.env.OLLAMA_MODEL ?? 'llama3')
      : (process.env.OPENAI_MODEL ?? 'gpt-4o')
    const apiKey = provider === 'ollama' ? 'ollama' : process.env.OPENAI_API_KEY
    if (provider === 'openai' && !apiKey) throw new Error('OPENAI_API_KEY not set in .env')

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        max_tokens: 1200,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`${provider} API error ${res.status}: ${err.slice(0, 200)}`)
    }
    const json = await res.json() as any
    return json.choices?.[0]?.message?.content ?? ''
  }

  if (provider === 'claude-code') {
    const claudeBin = Bun.which('claude')
    if (!claudeBin) throw new Error('claude CLI not found. Install Claude Code from claude.ai/code and run `claude login`.')
    const proc = Bun.spawn([claudeBin, '-p', `${systemPrompt}\n\n${userPrompt}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`claude CLI error (exit ${exitCode}): ${err.slice(0, 200)}`)
    }
    return output.trim()
  }

  if (provider === 'gemini') {
    throw new Error('Gemini is configured as manual-only. Use the sample prompt from Setup → Step 3 to generate briefs in Gemini.')
  }

  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env')
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}`)
    const json = await res.json() as any
    return json.content?.[0]?.text ?? ''
  }

  // Default: PAI inference (dynamic import — graceful fail if PAI not installed)
  try {
    const { inference } = await import('../../../Tools/Inference.ts')
    const result = await inference({ systemPrompt, userPrompt, level: 'standard', timeout: 60000 })
    if (!result.success) throw new Error(result.error ?? 'PAI inference failed')
    return result.output
  } catch (e: any) {
    if (e.code === 'MODULE_NOT_FOUND' || e.message?.includes('Cannot find module')) {
      throw new Error('PAI inference not available. Set LLM_PROVIDER=anthropic, openai, or ollama in your .env file.')
    }
    throw e
  }
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
): Promise<string> {
  const fmt = (iso: string) => {
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return iso }
  }

  const meetingLines = meetings.length
    ? meetings.map((m) => `- ${m.title} on ${fmt(m.start)}${m.attendees?.length ? ` (${m.attendees.slice(0, 3).join(', ')})` : ''}`).join('\n')
    : 'No upcoming meetings in the next 30 days.'

  const emailLines = emails.length
    ? emails.slice(0, 10).map((e) => `- [${fmt(e.date)}] ${e.subject}${e.actionRequired ? ' ⚡action needed' : ''}`).join('\n')
    : 'No recent emails.'

  const docLines = docs.length
    ? docs.slice(0, 15).map((d) => `- ${d.name}${d.modifiedTime ? ` (${fmt(d.modifiedTime)})` : ''}`).join('\n')
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

  const prompt = `You are a Red Hat Account Solution Architect's AI assistant. Generate a comprehensive customer intelligence brief for:

Customer: ${customer.name}
AE: ${customer.ae ?? 'Unknown'} | Segment: ${customer.segment ?? 'Unknown'} | Region: ${customer.region ?? 'Unknown'}

══ DATA SOURCES ══

ACTIVE RED HAT SUBSCRIPTIONS (products currently in use):
${subLines}
${sheetLines ? `\nDETAILED SUBSCRIPTION DATA (from AE spreadsheet — authoritative product/count data):\n${sheetLines}` : ''}

OPEN SUPPORT CASES:
${caseLines}

UPCOMING MEETINGS (next 30 days):
${meetingLines}

RECENT EMAILS (last 30 days):
${emailLines}

ACCOUNT DOCUMENTS (last 90 days — titles reveal priorities, proposals, account plans):
${docLines}

══ BRIEF FORMAT ══

Write a structured customer intelligence brief using exactly these sections. Be specific — use real names, products, and dates from the data. Do not invent information not present in the data above.

**Account Overview**
2-3 sentences: who this customer is, their Red Hat relationship, and current account health.

**Red Hat Products & Solutions in Use**
Bullet list of active subscriptions/products. If subscription data is unavailable, infer from support cases and document titles.

**Customer Objectives & Priorities**
What this customer is trying to achieve based on meeting topics, email subjects, document names, and support case products. 3-5 bullets.

**Current Opportunities**
Active deals, proposals, POCs, or expansion conversations inferred from emails, docs (look for CBV, proposal, roadmap titles), and meeting patterns. Be specific if evidence exists.

**Open Support Cases**
List open cases with severity, days open, and product. Flag Sev1/Sev2 explicitly. If none, say so.

**Talking Points & Prep**
4-6 specific, actionable bullets for your next interaction based on all data above. Include renewal timing if within 120 days.

Keep each section tight and scannable. Total brief under 500 words.`

  return callLLM(
    'You are a Red Hat Account Solution Architect AI assistant. Be specific, concise, and actionable.',
    prompt,
  )
}
