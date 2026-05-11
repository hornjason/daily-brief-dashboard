import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Setup Page — Step0RegionAccess removal (GitHub #92)', () => {
  test('SetupPage.tsx does NOT import or render Step0RegionAccess', () => {
    // Read the actual source file
    const setupPagePath = resolve(__dirname, '../../dashboard/src/pages/SetupPage.tsx')
    const source = readFileSync(setupPagePath, 'utf-8')

    // Verify Step0RegionAccess is NOT present anywhere in the file
    // This catches both import statements and JSX usage
    expect(source).not.toContain('Step0RegionAccess')
  })

  test('SetupPage.tsx does NOT reference step0 state variables', () => {
    const setupPagePath = resolve(__dirname, '../../dashboard/src/pages/SetupPage.tsx')
    const source = readFileSync(setupPagePath, 'utf-8')

    // Verify all step0-prefixed state variables are gone
    expect(source).not.toContain('step0Loaded')
    expect(source).not.toContain('step0FirstBoot')
    expect(source).not.toContain('step0EnabledRegions')
    expect(source).not.toContain('step0EnabledPods')
  })
})
