import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Critical API endpoint regression guard', () => {
  const routesFile = readFileSync(resolve(import.meta.dir, '../../src/feature-module-routes.ts'), 'utf-8')

  test('/api/modules/compliance endpoint exists', () => {
    expect(routesFile).toContain("'/api/modules/compliance'")
  })

  test('/api/admin/scheduler-status endpoint exists', () => {
    expect(routesFile).toContain("'/api/admin/scheduler-status'")
  })

  test('/api/modules/status endpoint exists', () => {
    expect(routesFile).toContain("'/api/modules/status'")
  })

  test('/api/modules/health endpoint exists', () => {
    expect(routesFile).toContain("'/api/modules/health'")
  })

  test('scheduler-registry import exists', () => {
    expect(routesFile).toContain('scheduler-registry')
  })
})

describe('Server.ts does not import deleted schedule functions', () => {
  const serverFile = readFileSync(resolve(import.meta.dir, '../../server.ts'), 'utf-8')

  test('does not import scheduleProductIntelRefresh', () => {
    expect(serverFile).not.toContain('scheduleProductIntelRefresh')
  })

  test('does not import scheduleNewsRadarRefresh', () => {
    expect(serverFile).not.toContain('scheduleNewsRadarRefresh')
  })

  test('does not import scheduleRSSRefresh', () => {
    expect(serverFile).not.toContain('scheduleRSSRefresh')
  })
})

describe('Paths.ts respects container environment', () => {
  const pathsFile = readFileSync(resolve(import.meta.dir, '../../src/lib/paths.ts'), 'utf-8')

  test('DATA_CONFIG_DIR uses CONFIG_DIR env var', () => {
    expect(pathsFile).toContain('process.env.CONFIG_DIR')
  })
})
