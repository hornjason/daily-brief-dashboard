import { google } from 'googleapis'
// PAI inference — optional, only available when running with PAI installed locally
import { resolve } from 'path'
import { existsSync } from 'node:fs'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
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
])
const DOC_CONTENT_CAP   = 3_000   // chars per document
const TOTAL_CONTENT_CAP = 20_000  // chars per customer across all docs
const MAX_FILES_PER_CUSTOMER = 50
const DRIVE_SUBFOLDER_DEPTH  = 5

async function _fetchCustomerDocsImpl(customer: Customer): Promise<DriveFile[]> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  const parentId = process.env.AE_PARENT_FOLDER_ID
  if (!parentId) return []

  // Find the AE folder — check direct children first, then one level deeper.
  // Handles structures like: root → 2026 → Carolanne Farrell → [customer folders]
  const aeName = customer.ae
  const matchesAe = (name: string) => {
    if (!aeName) return true
    const n = name.toLowerCase()
    const first = aeName.split(' ')[0]?.toLowerCase() ?? ''
    const last  = (aeName.split(' ')[1] ?? '').toLowerCase()
    return n.includes(first) && (!last || n.includes(last))
  }

  const level1Res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 50,
  })
  const level1 = level1Res.data.files ?? []

  let aeFolder = aeName ? level1.find((f) => matchesAe(f.name ?? '')) : level1[0]

  if (!aeFolder) {
    // Check one level deeper (e.g., root → 2026 → AE Name)
    for (const subFolder of level1) {
      if (!subFolder.id) continue
      const level2Res = await drive.files.list({
        q: `'${subFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 50,
      })
      aeFolder = aeName
        ? (level2Res.data.files ?? []).find((f) => matchesAe(f.name ?? ''))
        : (level2Res.data.files ?? [])[0]
      if (aeFolder) break
    }
  }
  if (!aeFolder?.id) return []

  // Find the customer's subfolder — check direct children then one level deeper
  // (handles: AE folder → Accounts → Customer, or AE folder → Customer directly)
  const matchesCust = (name: string) => {
    const n = name.toLowerCase()
    const c = customer.name.toLowerCase()
    return n.includes(c) || c.includes(n)
  }

  const custLevel1Res = await drive.files.list({
    q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 100,
  })
  const custLevel1 = custLevel1Res.data.files ?? []
  let customerFolder = custLevel1.find((f) => matchesCust(f.name ?? ''))

  if (!customerFolder) {
    for (const sub of custLevel1) {
      if (!sub.id) continue
      const custLevel2Res = await drive.files.list({
        q: `'${sub.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 100,
      })
      customerFolder = (custLevel2Res.data.files ?? []).find((f) => matchesCust(f.name ?? ''))
      if (customerFolder) break
    }
  }
  if (!customerFolder?.id) return []

  // BFS: collect all files from customer folder + all subfolders (depth-limited)
  const allFiles: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }> = []
  const queue: Array<{ id: string; depth: number }> = [{ id: customerFolder.id, depth: 0 }]

  while (queue.length > 0 && allFiles.length < MAX_FILES_PER_CUSTOMER) {
    const { id: folderId, depth } = queue.shift()!

    // List files in this folder
    const filesRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
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
  if (p === 'gemini')      return !!process.env.GOOGLE_CLOUD_PROJECT && (!!process.env.GEMINI_SERVICE_ACCOUNT_KEY || existsSync(GOOGLE_UNIFIED_TOKEN_PATH))
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
    const project  = process.env.GOOGLE_CLOUD_PROJECT
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
    const model    = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
    if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set in .env — required for Gemini via Vertex AI')

    // Prefer service account key (works for any user, no cloud-platform OAuth scope needed).
    // Fall back to user OAuth token (requires cloud-platform scope on the user's token).
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
    return json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
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

  // Upcoming meetings (next 14 days for per-meeting prep, next 30 days for awareness)
  const upcomingMeetings = meetings.filter((m) => new Date(m.start) >= new Date())
  const meetingPrepList = upcomingMeetings.slice(0, 5)  // up to 5 meetings get individual prep
  const futureMeetingLines = upcomingMeetings.length
    ? upcomingMeetings.map((m) => `- ${m.title} on ${fmt(m.start)}${m.attendees?.length ? ` (${m.attendees.slice(0, 3).join(', ')})` : ''}`).join('\n')
    : 'No upcoming meetings.'

  const emailLines = emails.length
    ? emails.slice(0, 10).map((e) => `- [${fmt(e.date)}] ${e.subject}${e.snippet ? ` — ${e.snippet.slice(0, 120)}` : ''}${e.actionRequired ? ' ⚡action needed' : ''}`).join('\n')
    : 'No recent emails.'

  // Documents: include content if available, otherwise just name
  const docLines = docs.length
    ? docs.map((d) => {
        const header = `- ${d.name}${d.modifiedTime ? ` (${fmt(d.modifiedTime)})` : ''}`
        return d.content ? `${header}\n  Content excerpt: ${d.content.slice(0, 400)}` : header
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

## Account Overview
2-3 sentences: who this customer is, their Red Hat relationship, and current account health. Flag any renewals within 120 days.

## Company Profile
Extract from the documents and emails: approximate revenue band or company size, headcount if mentioned, industry vertical, recent acquisitions or funding rounds, fiscal year (if known), and current strategic priorities or digital transformation programs. 4-6 bullets. Omit entirely if no data is available in the documents/emails.

## Technology Landscape
Scan the documents and emails for any IT environment signals. Organize by category, prefix each confirmed item with ✓:
- Virtualization/Hypervisors: (VMware vSphere/ESXi, Hyper-V, Nutanix, KVM, etc.)
- Operating Systems: (RHEL, CentOS, Ubuntu, Windows Server, mix ratios)
- Containers/Kubernetes: (OpenShift, EKS, AKS, Docker, Rancher, adoption stage)
- Cloud: (AWS, Azure, GCP, hybrid, on-prem only)
- Automation/Config Mgmt: (Ansible, Puppet, Chef, SaltStack, scripts, none)
- Patch Management: (Satellite, SCCM, manual, Tanium, etc.)
- CI/CD: (Jenkins, GitHub Actions, GitLab CI, ArgoCD, etc.)
- Monitoring: (Datadog, Dynatrace, Splunk, Prometheus, SolarWinds, etc.)
- Security Tools: (CrowdStrike, Tanium, Qualys, CyberArk, etc.)
- Storage: (NetApp, Pure, Dell EMC, HPE, Ceph, etc.)
Omit any category for which no signals are found. Omit this section entirely if no IT environment signals are detected.

## Pipeline Opportunities
Based on the Technology Landscape and Company Profile above, identify 2-4 specific Red Hat product opportunities. Use this signal-to-product mapping as a guide:
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

Keep total brief under 900 words.`

  return callLLM(
    'You are a Red Hat Account Solution Architect AI assistant. Be specific, concise, and actionable. Always use ## markdown headers exactly as instructed.',
    prompt,
  )
}
