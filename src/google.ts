import { google } from 'googleapis'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { EmailHighlight, DriveFile, CalendarEvent, Customer } from './types.ts'

// Shared config path — uses CONFIG_DIR env var (container) or local config/ dir
const CONFIG_DIR_PATH = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const OAUTH_KEYS_PATH    = process.env.GOOGLE_OAUTH_KEYS  ?? resolve(CONFIG_DIR_PATH, 'gcp-oauth.keys.json')
const GMAIL_TOKEN_PATH   = process.env.GMAIL_TOKEN         ?? resolve(CONFIG_DIR_PATH, '.gmail-token.json')
const GDRIVE_TOKEN_PATH  = process.env.GDRIVE_TOKEN        ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')
const GCAL_TOKEN_PATH    = process.env.GCAL_TOKEN          ?? resolve(CONFIG_DIR_PATH, '.calendar-token.json')

const GOOGLE_UNIFIED_TOKEN_PATH = resolve(CONFIG_DIR_PATH, '.google-token.json')

export { GOOGLE_UNIFIED_TOKEN_PATH, OAUTH_KEYS_PATH }

function is429(e: any): boolean {
  return e?.code === 429 || e?.status === 429 ||
    (e?.message ?? '').includes('RESOURCE_EXHAUSTED') ||
    (e?.message ?? '').includes('rateLimitExceeded')
}

/**
 * Wrap a Sheets/Drive API call with one quota-429 retry after 61 seconds.
 * Non-429 errors are rethrown immediately without waiting.
 */
export async function withQuotaRetry<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  try {
    return await fn()
  } catch (e: any) {
    if (!is429(e)) throw e
    console.warn(`[sheets] quota 429 — waiting 61s before retry${label ? ` (${label})` : ''}`)
    await new Promise<void>((res) => setTimeout(res, 61_000))
    return fn()
  }
}

export function makeAuth(tokenPath: string) {
  if (!existsSync(OAUTH_KEYS_PATH)) throw new Error(`OAuth keys not found: ${OAUTH_KEYS_PATH}`)
  // Use unified browser-OAuth token if available, fall back to individual token file
  const resolvedPath = existsSync(GOOGLE_UNIFIED_TOKEN_PATH) ? GOOGLE_UNIFIED_TOKEN_PATH : tokenPath
  if (!existsSync(resolvedPath)) throw new Error(`Token not found: ${resolvedPath} — complete OAuth setup at /dashboard/setup`)
  const keys = JSON.parse(readFileSync(OAUTH_KEYS_PATH, 'utf-8'))
  const { client_id, client_secret } = keys.installed ?? keys.web
  const auth = new google.auth.OAuth2(client_id, client_secret)
  auth.setCredentials(JSON.parse(readFileSync(resolvedPath, 'utf-8')))
  return auth
}

function extractDomain(email: string): string {
  return email.match(/@([^>\s,]+)/)?.[1]?.toLowerCase() ?? ''
}

function isCustomerEmail(from: string, subject: string, customers: Customer[]): boolean {
  const fromDomain = extractDomain(from)
  // Match customer domain in From field
  if (fromDomain && customers.some((c) => c.domain && fromDomain.includes(c.domain))) return true
  // Match customer name in Subject
  if (customers.some((c) => c.name && subject.toLowerCase().includes(c.name.toLowerCase()))) return true
  return false
}

export async function fetchEmail(customers: Customer[]): Promise<EmailHighlight[]> {
  const auth = makeAuth(GMAIL_TOKEN_PATH)
  const gmail = google.gmail({ version: 'v1', auth })

  // 48-hour window
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const afterStr = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `is:unread after:${afterStr}`,
    maxResults: 50,
  })

  const messages = list.data.messages ?? []
  if (messages.length === 0) return []

  // Fetch headers in parallel
  const details = await Promise.all(
    messages.slice(0, 30).map((msg) =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      })
    )
  )

  const results: EmailHighlight[] = []
  for (const { data } of details) {
    const h = data.payload?.headers ?? []
    const get = (name: string) => h.find((x) => x.name === name)?.value ?? ''
    const from = get('From')
    const subject = get('Subject')
    const date = get('Date')

    if (!isCustomerEmail(from, subject, customers)) continue

    // Derive customer label from matching customer name or from-domain
    const matchedCustomer = customers.find(
      (c) =>
        (c.domain && extractDomain(from).includes(c.domain)) ||
        (c.name && subject.toLowerCase().includes(c.name.toLowerCase()))
    )
    const customer = matchedCustomer?.name ?? extractDomain(from).split('.').slice(-2, -1)[0] ?? 'Unknown'

    results.push({
      customer,
      subject,
      from,
      date,
      snippet: data.snippet ?? '',
      actionRequired: /requirements?|action|urgent|asap|follow.?up|need|waiting|deadline/i.test(
        subject + ' ' + (data.snippet ?? '')
      ),
    })
  }

  return results
}

export async function fetchCalendar(customers: Customer[], includeAll = false): Promise<CalendarEvent[]> {
  const auth = makeAuth(GCAL_TOKEN_PATH)
  const calendar = google.calendar({ version: 'v3', auth })

  const now     = new Date()
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: weekOut.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  })

  const items = res.data.items ?? []

  // Unique AE names and first names for organizer matching
  const aeNames = [...new Set(customers.map((c) => c.ae).filter(Boolean))] as string[]
  const aeFirstNames = aeNames.map((ae) => ae.split(' ')[0].toLowerCase())

  return items
    .map((ev) => {
      const rawAttendees = ev.attendees ?? []
      const solo = rawAttendees.length === 0 || rawAttendees.every((a) => a.self)
      const attendees = rawAttendees
        .filter((a) => !a.self)
        .map((a) => a.email ?? '')
        .filter(Boolean)

      const externalAttendees = attendees.filter((email) => !email.endsWith('@redhat.com'))

      // Customers present: match attendee domain or event title
      const title = ev.summary ?? ''

      // Normalize a string to alphanumeric-only lowercase for fuzzy comparison
      const normAlpha = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

      // Extract company part of an email domain (strip TLD(s))
      // e.g. "shutterfly.com" → "shutterfly", "a10networks.com" → "a10networks", "fredhutch.org" → "fredhutch"
      const domainCompany = (email: string) => {
        const domain = email.split('@')[1] ?? ''
        const parts  = domain.split('.')
        return normAlpha(parts.length >= 2 ? parts.slice(0, -1).join('') : domain)
      }

      // Significant words from customer name (> 3 chars, no legal suffixes)
      const custKeywords = (name: string) =>
        name.toLowerCase()
          .replace(/\b(inc|llc|corp|ltd|co|corporation|incorporated|u\.s|us)\b\.?/g, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2)

      const matchedCustomers = customers
        .filter((c) => {
          // 1. Explicit domain config (exact suffix match)
          if (c.domain && externalAttendees.some((e) => e.endsWith(c.domain!))) return true

          // 2. Auto domain: company part of attendee email appears in customer name (or vice versa)
          const normCust = normAlpha(c.name)
          const autoDomainMatch = externalAttendees.some((e) => {
            const co = domainCompany(e)
            return co.length > 3 && (normCust.includes(co) || co.includes(normAlpha(c.name.split(/[\s,]/)[0])))
          })
          if (autoDomainMatch) return true

          // 3. Title: any significant keyword from customer name appears as a whole word in the title
          const keywords = custKeywords(c.name)
          const titleNorm = title.toLowerCase()
          if (keywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(titleNorm))) return true

          // 4. Aliases: check title against aliases too
          if (c.aliases?.some(alias => custKeywords(alias).some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(titleNorm)))) return true

          return false
        })
        .map((c) => c.name)

      // Organizer: check if organized by an AE (by display name or email first-name match)
      const organizerName = ev.organizer?.displayName ?? ''
      const organizerEmail = ev.organizer?.email ?? ''
      const matchedAe = aeNames.find((ae) => {
        const firstName = ae.split(' ')[0].toLowerCase()
        return (
          organizerName.toLowerCase().includes(firstName) ||
          organizerEmail.toLowerCase().includes(firstName)
        )
      })

      // Include if: has customer match OR organized by an AE (or includeAll)
      if (!includeAll && matchedCustomers.length === 0 && !matchedAe) return null

      const needsPrep = externalAttendees.length > 0 || matchedCustomers.length > 0

      // Conference / join link — Google Meet, conferenceData, then scan location + description
      const rawDesc = ev.description ?? ''
      const rawLocation = ev.location ?? ''
      const searchText = `${rawLocation} ${rawDesc}`

      let joinUrl: string | undefined =
        (ev as any).hangoutLink ??
        (ev as any).conferenceData?.entryPoints?.find((ep: any) => ep.entryPointType === 'video')?.uri

      if (!joinUrl) {
        const webexMatch  = searchText.match(/https:\/\/[a-z0-9.-]*webex\.com\/[^\s"<]+/)
        const zoomMatch   = searchText.match(/https:\/\/[a-z0-9.-]*zoom\.us\/[^\s"<]+/)
        const teamsMatch  = searchText.match(/https:\/\/teams\.microsoft\.com\/[^\s"<]+/)
        joinUrl = webexMatch?.[0] ?? zoomMatch?.[0] ?? teamsMatch?.[0]
      }

      // First Google Doc link in description (notes)
      const notesMatch = rawDesc.match(/https:\/\/docs\.google\.com\/[^\s"<]+/)
      const notesUrl = notesMatch?.[0]

      // Clean description — strip HTML tags, trim, cap at 300 chars
      const plainDesc = rawDesc
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300) || undefined

      return {
        title,
        start:     ev.start?.dateTime ?? ev.start?.date ?? '',
        end:       ev.end?.dateTime   ?? ev.end?.date   ?? '',
        attendees: externalAttendees,
        needsPrep,
        customers: matchedCustomers.length ? matchedCustomers : undefined,
        organizer: matchedCustomers.length === 0 && matchedAe ? matchedAe : undefined,
        joinUrl,
        description: plainDesc,
        notesUrl,
        solo: solo && matchedCustomers.length === 0,
      } satisfies CalendarEvent
    })
    .filter((ev): ev is CalendarEvent => ev !== null)
}

export async function fetchDrive(customers: Customer[]): Promise<DriveFile[]> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  const parentId = process.env.AE_PARENT_FOLDER_ID
  if (!parentId) throw new Error('AE_PARENT_FOLDER_ID not set in .env')

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const customerNames = customers.flatMap((c) => [c.name, ...(c.aliases ?? [])].map(n => n.toLowerCase()))

  // 1. List all AE folders under the parent
  const aeFoldersRes = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 50,
  })
  const aeFolders = aeFoldersRes.data.files ?? []

  // 2. For each AE folder, list customer subfolders and match case-insensitively
  const allCustomerFolders: Array<{ id: string; name: string }> = []
  await Promise.all(
    aeFolders.map(async (aeFolder) => {
      const res = await drive.files.list({
        q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)',
        pageSize: 100,
      })
      for (const folder of res.data.files ?? []) {
        const folderLower = folder.name?.toLowerCase() ?? ''
        const matched = customerNames.some(
          (name) => folderLower.includes(name) || name.includes(folderLower)
        )
        if (matched && folder.id) allCustomerFolders.push({ id: folder.id, name: folder.name ?? '' })
      }
    })
  )

  if (allCustomerFolders.length === 0) return []

  // 3. For each matched customer folder, find files modified in last 7 days
  const perCustomer = await Promise.all(
    allCustomerFolders.map(async (folder) => {
      const res = await drive.files.list({
        q: `'${folder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and modifiedTime > '${weekAgo}' and trashed = false`,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 10,
      })
      return (res.data.files ?? []).map((f) => ({
        name: f.name ?? '',
        mimeType: f.mimeType ?? '',
        modifiedTime: f.modifiedTime ?? undefined,
        webViewLink: f.webViewLink ?? undefined,
        customer: folder.name,
      }))
    })
  )

  return perCustomer
    .flat()
    .sort((a, b) => new Date(b.modifiedTime ?? 0).getTime() - new Date(a.modifiedTime ?? 0).getTime())
}
