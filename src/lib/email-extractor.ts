import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'
import { JSDOM } from 'jsdom'
import { isGoogleDocUrl, extractFileId, extractMaterialContent } from './google-content-extractor.ts'

export interface EmailExtractResult {
  title: string
  content: string
  sourceLinks: Array<{ url: string; title: string; excerpt: string }>
}

export async function extractFromEmail(subject: string): Promise<EmailExtractResult> {
  if (!subject || !subject.trim()) {
    throw new Error('emailSubject is required — provide a search term for the email subject line')
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const gmail = google.gmail({ version: 'v1', auth })

  const query = `subject:${subject}`
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 5,
  })

  const messages = listRes.data.messages ?? []
  if (messages.length === 0) {
    throw new Error(`No emails found matching subject: "${subject}"`)
  }

  const msgId = messages[0].id!
  const msgRes = await gmail.users.messages.get({
    userId: 'me',
    id: msgId,
    format: 'full',
  })

  const headers = msgRes.data.payload?.headers ?? []
  const emailSubject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value ?? subject

  const htmlBody = extractHtmlBody(msgRes.data.payload)
  const plainBody = extractPlainBody(msgRes.data.payload)

  let bodyText: string
  let urls: Array<{ url: string; title: string }> = []

  if (htmlBody) {
    const parsed = parseHtmlBody(htmlBody)
    bodyText = parsed.text
    urls = parsed.links
  } else if (plainBody) {
    bodyText = plainBody
    urls = extractUrlsFromPlainText(plainBody)
  } else {
    bodyText = msgRes.data.snippet ?? ''
  }

  const sourceLinks = await fetchLinkedContent(urls)

  return {
    title: emailSubject,
    content: bodyText,
    sourceLinks,
  }
}

function extractHtmlBody(payload: any): string | null {
  if (!payload) return null

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractHtmlBody(part)
      if (result) return result
    }
  }
  return null
}

function extractPlainBody(payload: any): string | null {
  if (!payload) return null

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractPlainBody(part)
      if (result) return result
    }
  }
  return null
}

function parseHtmlBody(html: string): { text: string; links: Array<{ url: string; title: string }> } {
  const dom = new JSDOM(html)
  const doc = dom.window.document

  const links: Array<{ url: string; title: string }> = []
  const anchors = doc.querySelectorAll('a[href]')
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href')
    if (!href) continue
    if (href.startsWith('mailto:') || href.startsWith('#') || href.startsWith('tel:')) continue
    const linkText = anchor.textContent?.trim() || href
    if (!links.some(l => l.url === href)) {
      links.push({ url: href, title: linkText })
    }
  }

  const text = doc.body?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

  return { text, links }
}

function extractUrlsFromPlainText(text: string): Array<{ url: string; title: string }> {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g
  const matches = text.match(urlRegex) ?? []
  const seen = new Set<string>()
  const results: Array<{ url: string; title: string }> = []
  for (const url of matches) {
    const cleaned = url.replace(/[.,;:!?)]+$/, '')
    if (!seen.has(cleaned)) {
      seen.add(cleaned)
      results.push({ url: cleaned, title: cleaned })
    }
  }
  return results
}

async function fetchLinkedContent(
  links: Array<{ url: string; title: string }>,
): Promise<Array<{ url: string; title: string; excerpt: string }>> {
  const contentLinks = links.filter(l => {
    try {
      const u = new URL(l.url)
      const skip = ['accounts.google.com', 'mail.google.com', 'unsubscribe', 'manage-preferences']
      return !skip.some(s => u.hostname.includes(s) || u.pathname.includes(s))
    } catch {
      return false
    }
  }).slice(0, 10)

  const results = await Promise.allSettled(
    contentLinks.map(async (link) => {
      try {
        if (isGoogleDocUrl(link.url)) {
          const fileId = extractFileId(link.url)
          if (fileId) {
            const { title, content } = await extractMaterialContent(fileId)
            return { url: link.url, title, excerpt: content.substring(0, 500) }
          }
        }

        const resp = await fetch(link.url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PAI-EmailExtractor/1.0)' },
          redirect: 'follow',
        })
        if (!resp.ok) {
          return { url: link.url, title: link.title, excerpt: `[HTTP ${resp.status}]` }
        }
        const contentType = resp.headers.get('content-type') ?? ''
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
          return { url: link.url, title: link.title, excerpt: `[${contentType.split(';')[0]}]` }
        }
        const html = await resp.text()
        const dom = new JSDOM(html)
        const doc = dom.window.document

        const pageTitle = doc.querySelector('title')?.textContent?.trim() || link.title
        const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim()
        const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim()

        let excerpt = metaDesc || ogDesc || ''
        if (!excerpt) {
          const paragraphs = doc.querySelectorAll('p')
          for (const p of paragraphs) {
            const pText = p.textContent?.trim() ?? ''
            if (pText.length > 50) {
              excerpt = pText.substring(0, 500)
              break
            }
          }
        }

        return { url: link.url, title: pageTitle, excerpt: excerpt.substring(0, 500) }
      } catch (e: any) {
        return { url: link.url, title: link.title, excerpt: `[fetch failed: ${e.message?.substring(0, 80)}]` }
      }
    })
  )

  return results
    .filter((r): r is PromiseFulfilledResult<{ url: string; title: string; excerpt: string }> => r.status === 'fulfilled')
    .map(r => r.value)
}
