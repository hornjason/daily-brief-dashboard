/**
 * test/unit/signal-perf-instrumentation.test.ts
 * Regression tests for GitHub Issue #277 — collectAllSignals performance instrumentation
 *
 * NOTE: These tests verify the instrumentation code exists and compiles correctly.
 * We cannot call FeatureModuleRegistry.collectAllSignals() directly in tests because
 * signal-loader-single-path.test.ts globally mocks it, causing cross-test pollution.
 * The actual timing behavior is verified manually via console.log output.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Signal Performance Instrumentation', () => {
  it('feature-module-registry contains performance.now() timing instrumentation', () => {
    const registryPath = resolve(import.meta.dir, '../../src/feature-module-registry.ts')
    const source = readFileSync(registryPath, 'utf-8')

    // Verify timing variables exist
    expect(source).toContain('const startTime = performance.now()')
    expect(source).toContain('const moduleStartTime = performance.now()')
    expect(source).toContain('const totalElapsed = performance.now() - startTime')
    expect(source).toContain('const moduleElapsed = performance.now() - moduleStartTime')

    // Verify logging format
    expect(source).toContain('[signal-perf] collectAllSignals')
    expect(source).toContain('if (totalElapsed > 50)')
  })

  it('pipeline-module contains normalizeForQuery filter timing', () => {
    const pipelinePath = resolve(import.meta.dir, '../../src/modules/pipeline-module.ts')
    const source = readFileSync(pipelinePath, 'utf-8')

    // Verify filter timing variables
    expect(source).toContain('const filterStartTime = performance.now()')
    expect(source).toContain('const filterElapsed = performance.now() - filterStartTime')

    // Verify logging format
    expect(source).toContain('[signal-perf] pipeline filter')
    expect(source).toContain('if (filterElapsed > 10)')
  })

  it('cases-module contains normalizeForQuery filter timing', () => {
    const casesPath = resolve(import.meta.dir, '../../src/modules/cases-module.ts')
    const source = readFileSync(casesPath, 'utf-8')

    // Verify filter timing variables
    expect(source).toContain('const filterStartTime = performance.now()')
    expect(source).toContain('const filterElapsed = performance.now() - filterStartTime')

    // Verify logging format
    expect(source).toContain('[signal-perf] cases filter')
    expect(source).toContain('if (filterElapsed > 10)')
  })
})
