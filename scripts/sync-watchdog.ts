/**
 * scripts/sync-watchdog.ts
 *
 * Host-side watchdog — runs on Mac Mini via launchd every 10 minutes.
 * Checks if pai-sync-l3 container is running. Sends alert email if not.
 *
 * Requires CONFIG_DIR env var pointing to the data-sync config directory
 * so email-sender.ts can find .gmail-token.json.
 *
 * Launched by: ~/Library/LaunchAgents/com.pai.sync-watchdog.plist
 */

import { execSync } from 'node:child_process'
import { sendBriefEmail } from '../src/email-sender.ts'

const CONTAINER = 'pai-sync-l3'
const PODMAN = '/opt/homebrew/bin/podman'
const ALERT_TO = 'jhorn@redhat.com'

async function main(): Promise<void> {
  const now = new Date().toISOString()
  const dateStr = now.slice(0, 10)

  let status: string
  try {
    status = execSync(`${PODMAN} inspect ${CONTAINER} --format '{{.State.Status}}'`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    status = 'missing'
  }

  if (status === 'running') {
    console.log(`[sync-watchdog] OK — ${CONTAINER} is running (${now})`)
    return
  }

  console.warn(`[sync-watchdog] ALERT — ${CONTAINER} status: ${status}`)

  const subject = `L3 Sync Daemon ${status === 'missing' ? 'MISSING' : 'DOWN'} - ${dateStr}`
  const body = `<html><body>
    <p>Container <code>${CONTAINER}</code> is <strong>${status}</strong> on Mac Mini as of ${now}.</p>
    <p>Run <code>make sync-up</code> from <code>~/DailyBriefDashboard</code> to restart.</p>
  </body></html>`

  try {
    await sendBriefEmail(ALERT_TO, subject, body)
    console.log(`[sync-watchdog] alert email sent to ${ALERT_TO}`)
  } catch (e: any) {
    console.error(`[sync-watchdog] failed to send alert email: ${e.message}`)
  }
}

main().catch(err => {
  console.error('[sync-watchdog] fatal:', err)
  process.exit(1)
})
