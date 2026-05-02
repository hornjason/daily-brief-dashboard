import { describe, test, expect, mock } from 'bun:test'

describe('BKL-UX-WIPE-CONN-RESET-01: clearSessionFiles after reset', () => {
  test('clearSessionFiles deletes RH and SF session files when they exist', async () => {
    const { mkdirSync, writeFileSync, existsSync, rmSync } = await import('fs')
    const { resolve } = await import('path')
    const tmpDir = `/tmp/test-clear-sessions-${Date.now()}`
    mkdirSync(tmpDir, { recursive: true })

    const rhPath = resolve(tmpDir, 'rh-session.json')
    const sfPath = resolve(tmpDir, 'sf-session.json')
    writeFileSync(rhPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))
    writeFileSync(sfPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))

    const { initScraperManager, clearSessionFiles } = await import('../../src/scraper-manager.ts')
    initScraperManager({
      rhSessionPath: rhPath,
      rhProfileDir: tmpDir,
      rhCasesCachePath: resolve(tmpDir, 'cases.json'),
      sfSessionPath: sfPath,
      sfReportId: 'test-report',
    })

    clearSessionFiles()

    expect(existsSync(rhPath)).toBe(false)
    expect(existsSync(sfPath)).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('clearSessionFiles is safe when session files do not exist', async () => {
    const { initScraperManager, clearSessionFiles } = await import('../../src/scraper-manager.ts')
    initScraperManager({
      rhSessionPath: '/tmp/nonexistent-rh-session.json',
      rhProfileDir: '/tmp',
      rhCasesCachePath: '/tmp/nonexistent-cases.json',
      sfSessionPath: '/tmp/nonexistent-sf-session.json',
      sfReportId: 'test-report',
    })
    expect(() => clearSessionFiles()).not.toThrow()
  })

  test('clearSessionFiles is safe when paths are empty strings (not yet initialized)', async () => {
    const { clearSessionFiles } = await import('../../src/scraper-manager.ts')
    expect(() => clearSessionFiles()).not.toThrow()
  })

  test('BKL-UX-WIPE-CONN-RESET-02: clearSessionFiles also deletes tableau and content-rh session files', async () => {
    const { mkdirSync, writeFileSync, existsSync, rmSync } = await import('fs')
    const { resolve } = await import('path')
    const tmpDir = `/tmp/test-clear-sessions-02-${Date.now()}`
    mkdirSync(tmpDir, { recursive: true })

    const tableauPath = resolve(tmpDir, 'tableau-session.json')
    const contentRhPath = resolve(tmpDir, 'content-rh-session.json')
    writeFileSync(tableauPath, JSON.stringify({ cookies: [], savedAt: new Date().toISOString() }))
    writeFileSync(contentRhPath, JSON.stringify({ sessionCookies: [], savedAt: new Date().toISOString() }))

    const { initScraperManager, clearSessionFiles } = await import('../../src/scraper-manager.ts')
    initScraperManager({
      rhSessionPath: resolve(tmpDir, 'rh-session.json'),
      rhProfileDir: tmpDir,
      rhCasesCachePath: resolve(tmpDir, 'cases.json'),
      sfSessionPath: resolve(tmpDir, 'sf-session.json'),
      sfReportId: 'test-report',
    })

    clearSessionFiles()

    expect(existsSync(tableauPath)).toBe(false)
    expect(existsSync(contentRhPath)).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('BKL-UX-WIPE-CONN-RESET-02: resetTableauStatusCache', () => {
  test('resetTableauStatusCache is exported and callable without throwing', async () => {
    const { resetTableauStatusCache } = await import('../../src/bootstrap-orchestrator.ts')
    expect(typeof resetTableauStatusCache).toBe('function')
    expect(() => resetTableauStatusCache()).not.toThrow()
  })
})
