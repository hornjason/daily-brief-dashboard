/**
 * Newsletter Events Extraction — GitHub Issue #316
 *
 * Parses Cloud Marketplace newsletter HTML for event-type content:
 * - Office hours dates with calendar links
 * - Recordings of past sessions (Drive links)
 * - Announcements (summit, webinar, podcast)
 *
 * These feed into the signal stack alongside existing event sources.
 */

export type NewsletterEventType = 'office-hours' | 'recording' | 'announcement'

export interface NewsletterEvent {
  title: string
  eventType: NewsletterEventType
  source: 'cloud-marketplace-newsletter'
  date?: string
  url?: string
  detail?: string
}

const OFFICE_HOURS_RE = /(?:office\s+hours)[^.]*?(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*\w+)?)/gi
const CALENDAR_LINK_RE = /href="(https?:\/\/calendar\.google\.com\/[^"]+)"/gi
const DRIVE_RECORDING_RE = /(?:recording|watch)[^.]*?href="(https?:\/\/drive\.google\.com\/[^"]+)"/gi
const WEBINAR_RE = /(?:webinar|upcoming\s+webinar)[:\s]+([^<]+?)(?:<|$)/gi
const SUMMIT_RE = /(?:summit\s+connect|red\s+hat\s+summit)[^.]*?(?:will\s+be\s+held|on|–)\s+([^.<]+)/gi
const PODCAST_RE = /(?:podcast|power5)[:\s]+([^<]+?)(?:<|$)/gi
const EVENT_LINK_RE = /href="(https?:\/\/(?:events\.redhat\.com|podcast\.redhat\.com)[^"]+)"/gi
const REGISTER_LINK_RE = /href="(https?:\/\/events\.redhat\.com\/[^"]+)"/gi

function extractUrls(html: string, pattern: RegExp): string[] {
  const urls: string[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(pattern.source, pattern.flags)
  while ((m = re.exec(html)) !== null) {
    urls.push(m[1])
  }
  return urls
}

function cleanText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

export function extractNewsletterEvents(html: string): NewsletterEvent[] {
  const events: NewsletterEvent[] = []
  const seen = new Set<string>()

  // 1. Office hours
  let m: RegExpExecArray | null
  const ohRe = new RegExp(OFFICE_HOURS_RE.source, OFFICE_HOURS_RE.flags)
  while ((m = ohRe.exec(html)) !== null) {
    const dateStr = m[1]?.trim()
    const calLinks = extractUrls(html, CALENDAR_LINK_RE)
    const key = `oh:${dateStr}`
    if (!seen.has(key)) {
      seen.add(key)
      events.push({
        title: `Cloud Marketplace Office Hours`,
        eventType: 'office-hours',
        source: 'cloud-marketplace-newsletter',
        date: dateStr,
        url: calLinks[0],
        detail: `Office hours session${dateStr ? ` on ${dateStr}` : ''}`,
      })
    }
  }

  // 2. Recordings (Drive links in context of "recording" or "watch")
  const recRe = new RegExp(DRIVE_RECORDING_RE.source, DRIVE_RECORDING_RE.flags)
  while ((m = recRe.exec(html)) !== null) {
    const url = m[1]
    const key = `rec:${url}`
    if (!seen.has(key)) {
      seen.add(key)
      events.push({
        title: 'Cloud Marketplace Session Recording',
        eventType: 'recording',
        source: 'cloud-marketplace-newsletter',
        url,
        detail: 'Recording of past Cloud Marketplace session',
      })
    }
  }

  // 3. Announcements — webinars, summit, podcast
  const webRe = new RegExp(WEBINAR_RE.source, WEBINAR_RE.flags)
  while ((m = webRe.exec(html)) !== null) {
    const title = cleanText(m[1])
    if (title.length < 5) continue
    const key = `ann:webinar:${title.slice(0, 40)}`
    if (!seen.has(key)) {
      seen.add(key)
      const regLinks = extractUrls(html, REGISTER_LINK_RE)
      events.push({
        title: title.length > 80 ? title.slice(0, 77) + '...' : title,
        eventType: 'announcement',
        source: 'cloud-marketplace-newsletter',
        url: regLinks[0],
        detail: `Webinar: ${title}`,
      })
    }
  }

  const summitRe = new RegExp(SUMMIT_RE.source, SUMMIT_RE.flags)
  while ((m = summitRe.exec(html)) !== null) {
    const detail = cleanText(m[1])
    const key = `ann:summit:${detail.slice(0, 40)}`
    if (!seen.has(key)) {
      seen.add(key)
      events.push({
        title: 'Red Hat Summit Connect 2026',
        eventType: 'announcement',
        source: 'cloud-marketplace-newsletter',
        detail: `Summit: ${detail}`,
      })
    }
  }

  const podRe = new RegExp(PODCAST_RE.source, PODCAST_RE.flags)
  while ((m = podRe.exec(html)) !== null) {
    const title = cleanText(m[1])
    if (title.length < 5) continue
    const key = `ann:podcast:${title.slice(0, 40)}`
    if (!seen.has(key)) {
      seen.add(key)
      const podLinks = extractUrls(html, EVENT_LINK_RE)
      events.push({
        title: title.length > 80 ? title.slice(0, 77) + '...' : title,
        eventType: 'announcement',
        source: 'cloud-marketplace-newsletter',
        url: podLinks.find(u => u.includes('podcast')) ?? podLinks[0],
        detail: `Podcast: ${title}`,
      })
    }
  }

  return events
}
