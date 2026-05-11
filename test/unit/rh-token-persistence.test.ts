import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

describe('RH Token Persistence (Issue #87)', () => {
  test('setup-routes.ts has POST /rh-token endpoint', () => {
    const routesPath = resolve(process.cwd(), 'src/setup-routes.ts')
    const content = readFileSync(routesPath, 'utf-8')

    // Verify the endpoint exists
    expect(content).toContain("router.post('/api/setup/rh-token'")

    // Verify it writes to /data/config/.rh-token
    expect(content).toContain('.rh-token')
    expect(content).toMatch(/writeFileSyncRaw\(tokenPath/)
  })

  test('entrypoint.sh sources .rh-token if it exists', () => {
    const entrypointPath = resolve(process.cwd(), 'entrypoint.sh')
    const content = readFileSync(entrypointPath, 'utf-8')

    // Verify entrypoint checks for and sources the token file
    expect(content).toContain('.rh-token')
    expect(content).toContain('REDHAT_OFFLINE_TOKEN')

    // Should conditionally export only if file exists
    expect(content).toMatch(/if.*\[.*-f.*\.rh-token.*\]/)
  })
})
