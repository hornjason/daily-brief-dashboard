/**
 * Unit tests for startup health probe system (Issue #746, Slice 2)
 *
 * Tests the probe registry, execution engine, and built-in probes.
 */
import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test'

// Use dynamic imports to avoid ESM TDZ issues
let registerProbe: typeof import('../../src/startup-health-probe.ts').registerProbe
let runHealthProbes: typeof import('../../src/startup-health-probe.ts').runHealthProbes
let getHealthResults: typeof import('../../src/startup-health-probe.ts').getHealthResults
let _resetProbesForTesting: typeof import('../../src/startup-health-probe.ts')._resetProbesForTesting

beforeEach(async () => {
  const mod = await import('../../src/startup-health-probe.ts')
  registerProbe = mod.registerProbe
  runHealthProbes = mod.runHealthProbes
  getHealthResults = mod.getHealthResults
  _resetProbesForTesting = mod._resetProbesForTesting
  _resetProbesForTesting()
})

describe('startup-health-probe', () => {
  describe('registerProbe + runHealthProbes', () => {
    it('should register and run a passing probe', async () => {
      registerProbe({
        name: 'test-pass',
        category: 'info',
        test: async () => ({ passed: true, message: 'All good' }),
      })

      const results = await runHealthProbes()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('test-pass')
      expect(results[0].status).toBe('pass')
      expect(results[0].message).toBe('All good')
      expect(results[0].category).toBe('info')
      expect(results[0].timestamp).toBeTruthy()
    })

    it('should register and run a failing probe without heal', async () => {
      registerProbe({
        name: 'test-fail',
        category: 'critical',
        test: async () => ({ passed: false, message: 'Something broke' }),
      })

      const results = await runHealthProbes()
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('fail')
      expect(results[0].message).toBe('Something broke')
    })

    it('should auto-heal a failing probe when heal succeeds', async () => {
      registerProbe({
        name: 'test-healable',
        category: 'warning',
        test: async () => ({ passed: false, message: 'Stale data found' }),
        heal: async () => 'Deleted 3 stale files',
      })

      const results = await runHealthProbes()
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('healed')
      expect(results[0].message).toBe('Stale data found')
      expect(results[0].healAction).toBe('Deleted 3 stale files')
    })

    it('should mark fail when heal throws', async () => {
      registerProbe({
        name: 'test-heal-fail',
        category: 'critical',
        test: async () => ({ passed: false, message: 'Bad config' }),
        heal: async () => { throw new Error('Cannot fix') },
      })

      const results = await runHealthProbes()
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('fail')
      expect(results[0].message).toContain('Bad config')
      expect(results[0].message).toContain('heal failed')
      expect(results[0].message).toContain('Cannot fix')
    })

    it('should handle probe test() throwing', async () => {
      registerProbe({
        name: 'test-throw',
        category: 'critical',
        test: async () => { throw new Error('Probe exploded') },
      })

      const results = await runHealthProbes()
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('fail')
      expect(results[0].message).toBe('Probe exploded')
    })

    it('should run multiple probes in order', async () => {
      registerProbe({
        name: 'probe-a',
        category: 'info',
        test: async () => ({ passed: true, message: 'OK' }),
      })
      registerProbe({
        name: 'probe-b',
        category: 'warning',
        test: async () => ({ passed: false, message: 'Warn' }),
      })
      registerProbe({
        name: 'probe-c',
        category: 'critical',
        test: async () => ({ passed: true, message: 'Fine' }),
      })

      const results = await runHealthProbes()
      expect(results).toHaveLength(3)
      expect(results[0].name).toBe('probe-a')
      expect(results[1].name).toBe('probe-b')
      expect(results[2].name).toBe('probe-c')
    })
  })

  describe('getHealthResults', () => {
    it('should return empty array before any run', () => {
      const results = getHealthResults()
      expect(results).toEqual([])
    })

    it('should return last run results', async () => {
      registerProbe({
        name: 'cached-probe',
        category: 'info',
        test: async () => ({ passed: true, message: 'OK' }),
      })

      await runHealthProbes()
      const cached = getHealthResults()
      expect(cached).toHaveLength(1)
      expect(cached[0].name).toBe('cached-probe')
    })
  })

  describe('HealthResult shape', () => {
    it('should have all required fields on pass', async () => {
      registerProbe({
        name: 'shape-test',
        category: 'warning',
        test: async () => ({ passed: true, message: 'OK' }),
      })

      const [result] = await runHealthProbes()
      expect(result).toHaveProperty('name')
      expect(result).toHaveProperty('category')
      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('message')
      expect(result).toHaveProperty('timestamp')
      // healAction should not be present on pass
      expect(result.healAction).toBeUndefined()
    })

    it('should include healAction on healed', async () => {
      registerProbe({
        name: 'heal-shape',
        category: 'warning',
        test: async () => ({ passed: false, message: 'Bad' }),
        heal: async () => 'Fixed it',
      })

      const [result] = await runHealthProbes()
      expect(result.healAction).toBe('Fixed it')
    })
  })
})
