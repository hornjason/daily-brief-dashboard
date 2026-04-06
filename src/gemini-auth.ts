/**
 * Shared Gemini authentication helper — BKL-MC02
 *
 * Single source of truth for `getGeminiToken()`.
 * Replaces 5 identical private copies across product-intelligence.ts,
 * product-feature-radar.ts, product-release-radar.ts,
 * customer-product-intel.ts, and account-intelligence.ts.
 */

import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'

export async function getGeminiToken(): Promise<string> {
  const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
  if (saKeyB64) {
    let keyData: { client_email?: string; private_key?: string }
    try {
      keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
    } catch {
      throw new Error('GEMINI_SERVICE_ACCOUNT_KEY is not valid base64-encoded JSON')
    }
    if (!keyData.client_email || !keyData.private_key) {
      throw new Error('GEMINI_SERVICE_ACCOUNT_KEY is missing client_email or private_key')
    }
    const jwtAuth = new google.auth.JWT({
      email:  keyData.client_email,
      key:    keyData.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const token = (await jwtAuth.getAccessToken()).token
    if (!token) throw new Error('Failed to get access token from service account key')
    return token
  }
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const token = (await auth.getAccessToken()).token
  if (!token) throw new Error('Failed to get access token for Gemini — set GEMINI_SERVICE_ACCOUNT_KEY in .env')
  return token
}
