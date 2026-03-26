/**
 * One-time auth flow for Google Calendar.
 * Run: bun scripts/auth-calendar.ts
 * Opens a browser URL, catches the redirect, saves the token.
 */
import { google } from 'googleapis'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { createServer } from 'http'

const CONFIG      = resolve(import.meta.dir, '../config')
const KEYS_PATH   = `${CONFIG}/gcp-oauth.keys.json`
const TOKEN_PATH  = `${CONFIG}/.calendar-token.json`

const REDIRECT_PORT = 9000
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}`
const SCOPE         = 'https://www.googleapis.com/auth/calendar.readonly'

const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf-8'))
const { client_id, client_secret } = keys.installed ?? keys.web

const auth = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI)

const url = auth.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPE,
  prompt: 'consent',
})

console.log('\n📅  Google Calendar — one-time auth\n')
console.log('1. Open this URL in your browser:\n')
console.log(`   ${url}\n`)
console.log('2. Approve access, then wait for the redirect…\n')

const server = createServer(async (req, res) => {
  const parsed = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`)
  const code   = parsed.searchParams.get('code')
  const error  = parsed.searchParams.get('error')

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end(`<h2>Auth failed: ${error ?? 'no code returned'}</h2>`)
    server.close()
    process.exit(1)
  }

  try {
    const { tokens } = await auth.getToken(code)
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h2 style="font-family:sans-serif">✅ Calendar authorized — you can close this tab.</h2>')
    console.log(`✅ Token saved → ${TOKEN_PATH}`)
    console.log('   Restart the dashboard: bun dev\n')
    server.close()
    process.exit(0)
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'text/html' })
    res.end(`<h2>Error: ${err.message}</h2>`)
    server.close()
    process.exit(1)
  }
})

server.listen(REDIRECT_PORT, () => {
  console.log(`   Listening for redirect on port ${REDIRECT_PORT}…\n`)
})
