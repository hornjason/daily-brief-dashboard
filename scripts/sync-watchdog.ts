#!/usr/bin/env bun
/**
 * scripts/sync-watchdog.ts — Health watchdog for pai-sync-l3 container.
 * Runs every 10 min via LaunchAgent. Checks container is running, restarts if not.
 */
import { execSync } from 'node:child_process'

const PODMAN = '/opt/homebrew/bin/podman'  // LaunchAgent PATH doesn't include homebrew
const CONTAINER = 'pai-sync-l3'
const PROJECT_DIR = '/Users/jasonhorn/DailyBriefDashboard'

try {
  const output = execSync(`${PODMAN} ps --filter name=${CONTAINER} --format '{{.Names}}'`, { encoding: 'utf-8' }).trim()
  if (output.includes(CONTAINER)) {
    console.log(`[watchdog] ${new Date().toISOString()} — ${CONTAINER} running`)
  } else {
    console.warn(`[watchdog] ${new Date().toISOString()} — ${CONTAINER} not running — starting via make sync-up`)
    execSync(`PATH=/opt/homebrew/bin:/Users/jasonhorn/.bun/bin:$PATH make -C ${PROJECT_DIR} sync-up`, { encoding: 'utf-8', timeout: 120_000 })
    console.log(`[watchdog] ${new Date().toISOString()} — ${CONTAINER} started`)
  }
} catch (e: any) {
  console.error(`[watchdog] ${new Date().toISOString()} — error: ${e.message}`)
}
