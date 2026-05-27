import { google } from 'googleapis'
import type { calendar_v3 } from 'googleapis'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { EmailHighlight, DriveFile, CalendarEvent, Customer } from './types.ts'
import { GOOGLE_OAUTH_CLIENT } from './google-oauth-config.ts'
import { CONFIG_DIR } from './lib/paths.ts'

// Shared config path — uses CONFIG_DIR env var (container) or local config/ dir
// import.meta.dir is Bun-only; fall back to process.cwd() when undefined (e.g. Playwright test runner)
const CONFIG_DIR_PATH = CONFIG_DIR
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
  // Use unified browser-OAuth token if available, fall back to individual token file
  const resolvedPath = existsSync(GOOGLE_UNIFIED_TOKEN_PATH) ? GOOGLE_UNIFIED_TOKEN_PATH : tokenPath
  if (!existsSync(resolvedPath)) throw new Error(`Token not found: ${resolvedPath} — complete OAuth setup at /dashboard/setup`)
  // Use bundled OAuth config (Issue #109) — falls back to file if .env override not set
  const { client_id, client_secret } = GOOGLE_OAUTH_CLIENT
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

  // Start from today (weekdays) or upcoming Monday (weekends), show 2 weeks forward
  const weekStart = new Date()
  weekStart.setHours(0, 0, 0, 0)
  const dow = weekStart.getDay() // 0=Sun, 1=Mon...6=Sat
  if (dow === 0) weekStart.setDate(weekStart.getDate() + 1) // Sun → next Mon
  else if (dow === 6) weekStart.setDate(weekStart.getDate() + 2) // Sat → next Mon
  const weekOut = new Date(weekStart.getTime() + 14 * 24 * 60 * 60 * 1000)

  // Fetch only the authenticated user's primary calendar — no subscribed/shared calendars
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: weekStart.toISOString(),
    timeMax: weekOut.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 200,
  }).catch(() => ({ data: { items: [] } }))

  // BKL-CAL-01: filter out proposed/declined events before processing
  // Only drop events the user explicitly declined or that are "[Proposed Time]" placeholders.
  // Keep 'needsAction' (default for most meetings) and 'tentative' — these are real calendar entries.
  const items = (res.data.items ?? []).filter(ev => {
    if (/^\[proposed time\]/i.test(ev.summary ?? '')) return false
    const selfAttendee = (ev.attendees ?? []).find((a: calendar_v3.Schema$EventAttendee) => a.self)
    if (selfAttendee && selfAttendee.responseStatus === 'declined') return false
    return true
  })

  // Unique AE names and first names for organizer matching
  const aeNames = [...new Set(customers.map((c) => c.ae).filter(Boolean))] as string[]
  const aeFirstNames = aeNames.map((ae) => ae.split(' ')[0].toLowerCase())

  return items
    .map((ev) => {
      const rawAttendees: calendar_v3.Schema$EventAttendee[] = ev.attendees ?? []
      const solo = rawAttendees.length === 0 || rawAttendees.every((a: calendar_v3.Schema$EventAttendee) => a.self)
      const attendees = rawAttendees
        .filter((a: calendar_v3.Schema$EventAttendee) => !a.self)
        .map((a: calendar_v3.Schema$EventAttendee) => a.email ?? '')
        .filter(Boolean)

      const attendeeDetails = rawAttendees
        .filter((a: calendar_v3.Schema$EventAttendee) => !a.self)
        .map((a: calendar_v3.Schema$EventAttendee) => ({
          email: a.email ?? '',
          displayName: a.displayName ?? undefined,
        }))
        .filter(a => a.email)

      const externalAttendees = attendees.filter((email: string) => !email.endsWith('@redhat.com'))

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

      // Escape regex metacharacters in keyword strings (Rook F2: prevents DoS from malformed customer names)
      const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

      // Significant words from customer name (> 3 chars, no legal suffixes or generic words)
      const TITLE_STOPWORDS = new Set([
        'office', 'services', 'service', 'systems', 'system', 'solutions', 'solution',
        'group', 'national', 'international', 'company', 'management', 'global',
        'the', 'and', 'for', 'new', 'one', 'power', 'electric', 'energy', 'capital',
        'technology', 'technologies', 'health', 'financial', 'insurance',
        // Directional / generic geography — too ambiguous for single-keyword corroboration
        'west', 'east', 'north', 'south', 'central', 'mid', 'pacific', 'american', 'america',
        'western', 'eastern', 'northern', 'southern',
        // Other high-frequency false-positive triggers
        'corp', 'enterprise', 'enterprises', 'digital', 'data', 'cloud', 'net', 'connect',
      ])
      const custKeywords = (name: string) =>
        name.toLowerCase()
          .replace(/\b(inc|llc|corp|ltd|co|corporation|incorporated|u\.s|us)\b\.?/g, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w))

      // Match a customer keyword against title text — exact word boundary OR prefix match (≥4 chars).
      // "hutch" in title matches "hutchinson" in customer name. Minimum 4 chars prevents
      // false positives from short prefixes like "red" matching "redmond".
      const kwMatchesTitle = (kw: string, titleText: string) => {
        if (new RegExp(`\\b${escRe(kw)}\\b`, 'i').test(titleText)) return true
        const titleWords = titleText.toLowerCase().split(/\s+/)
        return titleWords.some(tw => tw.length >= 4 && kw.length >= 4 && kw.startsWith(tw))
      }

      const matchedCustomers = customers
        .filter((c) => {
          // BKL-CAL-06: domain-only matches require corroboration to prevent false positives.
          // A single external attendee from a customer domain is insufficient — require either
          // 2+ attendees from that domain OR title corroboration from the customer name.
          //
          // titleCorroboration uses the SAME ≥2-keyword threshold as the title-only path (step 3).
          // Using .some() (any keyword) caused false positives: "red" in "Red Hat Summit" wrongly
          // corroborated "Red Robin"; "northwest" in "Northwest Corporate Call" wrongly
          // corroborated "Northwest Natural". Single common words are not meaningful corroboration.
          const titleCorroboration = (name: string) => {
            const kws = custKeywords(name)
            const matchingKws = kws.filter(kw => kwMatchesTitle(kw, title))
            return kws.length >= 2 ? matchingKws.length >= 2 : matchingKws.length >= 1
          }

          // 1. Explicit domain config (exact suffix match — includes aliasDomains)
          const allDomains = [c.domain, ...(c.aliasDomains ?? [])].filter(Boolean) as string[]
          const domainMatchAttendees = externalAttendees.filter(e => allDomains.some(d => e.endsWith(d)))
          if (domainMatchAttendees.length > 0) {
            if (domainMatchAttendees.length >= 2 || titleCorroboration(c.name)) return true
            // Single attendee from explicitly configured domain — still match
            // Both primary domain and aliasDomains are explicit config, so trust them
            return true
          }

          // 2. Auto domain: company part of attendee email appears in customer name (or vice versa)
          const normCust = normAlpha(c.name)
          const firstWord = normAlpha(c.name.split(/[\s,]/)[0])
          const autoDomainAttendees = externalAttendees.filter((e) => {
            const co = domainCompany(e)
            // BKL-CAL-07: firstWord must be > 2 chars — single-char initials (e.g. "U" in "U S Epson")
            // normalize to "u" which substring-matches inside unrelated domains (e.g. "illumio")
            return co.length > 3 && (normCust.includes(co) || (firstWord.length > 2 && co.includes(firstWord)))
          })
          if (autoDomainAttendees.length > 0) {
            if (autoDomainAttendees.length >= 2 || titleCorroboration(c.name)) return true
            return false
          }

          // 3. Title: require ≥2 significant keywords from customer name in the title (or all, if only 1 keyword)
          // Single-keyword matches cause too many false positives ("Dental" → "Delta Dental of California")
          const keywords = custKeywords(c.name)
          const titleNorm = title.toLowerCase()
          const matchingKws = keywords.filter(kw => kwMatchesTitle(kw, titleNorm))
          if (keywords.length >= 2 ? matchingKws.length >= 2 : matchingKws.length >= 1) return true

          // 4. Aliases: check title against aliases with same ≥2-keyword threshold
          if (c.aliases?.some(alias => {
            const aliasKws = custKeywords(alias)
            const aliasMatching = aliasKws.filter(kw => kwMatchesTitle(kw, titleNorm))
            return aliasKws.length >= 2 ? aliasMatching.length >= 2 : aliasMatching.length >= 1
          })) return true

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
        attendeeDetails,
        needsPrep,
        customers: matchedCustomers.length ? matchedCustomers : undefined,
        organizer: matchedCustomers.length === 0 && matchedAe ? matchedAe : undefined,
        joinUrl,
        description: plainDesc,
        notesUrl,
        solo: solo && matchedCustomers.length === 0,
        recurringEventId: ev.recurringEventId ?? undefined, // #269
      } satisfies CalendarEvent
    })
    .filter((ev) => ev !== null) as CalendarEvent[]
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
