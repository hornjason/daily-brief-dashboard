import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

test.describe('REG-DOMAIN-SWEEP-01: Domain inference fires after AE save (no-pod path)', () => {
  const SCHEDULER = resolve(import.meta.dirname!, '..', '..', 'src', 'background-scheduler.ts')
  const SERVER = resolve(import.meta.dirname!, '..', '..', 'server.ts')

  test('scheduleDomainInferenceSweep is exported from background-scheduler.ts', () => {
    const src = readFileSync(SCHEDULER, 'utf-8')
    expect(src).toContain('export function scheduleDomainInferenceSweep(')
  })

  test('initBackgroundScheduler calls scheduleDomainInferenceSweep on startup', () => {
    const src = readFileSync(SCHEDULER, 'utf-8')
    const initStart = src.indexOf('function initBackgroundScheduler')
    expect(initStart, 'initBackgroundScheduler must exist').toBeGreaterThan(-1)
    const initBlock = src.slice(initStart, initStart + 4000)
    expect(initBlock).toContain('scheduleDomainInferenceSweep(')
  })

  test('POST /api/aes handler calls scheduleDomainInferenceSweep after save', () => {
    const src = readFileSync(SERVER, 'utf-8')
    const handlerStart = src.indexOf("app.post('/api/aes'")
    expect(handlerStart, "POST /api/aes route must exist").toBeGreaterThan(-1)
    const nextRoute = src.indexOf("app.post('/api/aes/validate-folder'", handlerStart)
    const handlerBlock = src.slice(handlerStart, nextRoute > handlerStart ? nextRoute : handlerStart + 8000)
    expect(handlerBlock).toContain('scheduleDomainInferenceSweep(')
  })

  test('domain sweep processes customers without domains in batches of 3', () => {
    const src = readFileSync(SCHEDULER, 'utf-8')
    expect(src).toContain('slice(i, i + 3)')
  })
})
