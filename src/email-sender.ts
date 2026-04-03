// src/email-sender.ts — Gmail API email sender for daily brief delivery (BKL-E02)

import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { sanitizeErr } from './utils.ts'

const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN
  ?? (process.env.CONFIG_DIR
    ? `${process.env.CONFIG_DIR}/.gmail-token.json`
    : `${import.meta.dir}/../config/.gmail-token.json`)

/**
 * Send an HTML email via the Gmail API.
 *
 * Builds a MIME multipart message, base64url encodes it, and POSTs to
 * https://gmail.googleapis.com/gmail/v1/users/me/messages/send
 *
 * Requires gmail.send scope on the OAuth token.
 */
export async function sendBriefEmail(to: string, subject: string, htmlBody: string): Promise<void> {
  const auth = makeAuth(GMAIL_TOKEN_PATH)

  // Ensure we have a fresh access token
  const { token } = await auth.getAccessToken()
  if (!token) throw new Error('Failed to obtain Gmail access token — check OAuth setup')

  // Sanitize headers to prevent CRLF injection
  const safeTo = to.replace(/[\r\n]/g, '')
  const safeSubject = subject.replace(/[\r\n]/g, '')

  // Build RFC 2822 MIME message
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const mimeMessage = [
    `MIME-Version: 1.0`,
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(htmlBody, 'utf-8').toString('base64'),
    ``,
    `--${boundary}--`,
  ].join('\r\n')

  // Base64url encode the entire MIME message (Gmail API requirement)
  const raw = Buffer.from(mimeMessage, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gmail send failed (${res.status}): ${sanitizeErr(body)}`)
  }

  console.log(`[email-sender] email sent to ${to}: "${subject}"`)
}
