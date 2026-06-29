import { describe, expect, it } from 'bun:test'

/**
 * Regression test for #914: buildPhaseName and filterTopTacticsPerTdp
 * must normalize old TDP aliases to canonical names.
 *
 * We can't import buildPhaseName/filterTopTacticsPerTdp directly (not exported),
 * so we test via the exported normalizeTdp and verify the integration pattern
 * by simulating the exact logic used in motion-builder.ts.
 */
import { normalizeTdp } from '../../src/lib/tdp-domains.ts'

describe('#914 — buildPhaseName uses canonical TDP names', () => {
  // Simulate buildPhaseName's logic (line 634 of motion-builder.ts)
  function buildPhaseName(prefix: string, tactics: Array<{ parentTdp: string }>): string {
    const uniqueTdps = [...new Set(tactics.map(t => normalizeTdp(t.parentTdp)).filter(t => t && t.trim()))]
    return uniqueTdps.length > 0 ? `${prefix}: ${uniqueTdps.join(' + ')}` : prefix
  }

  it('normalizes "Server/Cloud OS" to "Server and Cloud Computing"', () => {
    const tactics = [{ parentTdp: 'Server/Cloud OS' }]
    const name = buildPhaseName('Anchor: Protect', tactics)
    expect(name).toBe('Anchor: Protect: Server and Cloud Computing')
    expect(name).not.toContain('Server/Cloud OS')
  })

  it('normalizes "Container Mgmt" to "Container Management"', () => {
    const tactics = [{ parentTdp: 'Container Mgmt' }]
    const name = buildPhaseName('Expand', tactics)
    expect(name).toBe('Expand: Container Management')
    expect(name).not.toContain('Container Mgmt')
  })

  it('normalizes "AI" to "AI Platform"', () => {
    const tactics = [{ parentTdp: 'AI' }]
    const name = buildPhaseName('Transform', tactics)
    expect(name).toBe('Transform: AI Platform')
  })

  it('normalizes "App Platform" to "Application Development"', () => {
    const tactics = [{ parentTdp: 'App Platform' }]
    const name = buildPhaseName('Expand', tactics)
    expect(name).toBe('Expand: Application Development')
  })

  it('passes through already-canonical names unchanged', () => {
    const tactics = [{ parentTdp: 'Automation' }, { parentTdp: 'Virtualization' }]
    const name = buildPhaseName('Anchor: Protect', tactics)
    expect(name).toBe('Anchor: Protect: Automation + Virtualization')
  })

  it('deduplicates when alias and canonical resolve to the same domain', () => {
    const tactics = [
      { parentTdp: 'Container Mgmt' },
      { parentTdp: 'Container Management' },
    ]
    const name = buildPhaseName('Expand', tactics)
    expect(name).toBe('Expand: Container Management')
  })

  it('handles empty parentTdp gracefully', () => {
    const tactics = [{ parentTdp: '' }, { parentTdp: 'Automation' }]
    const name = buildPhaseName('Anchor: Protect', tactics)
    expect(name).toBe('Anchor: Protect: Automation')
  })
})

describe('#914 — filterTopTacticsPerTdp groups aliases with canonical names', () => {
  // Simulate filterTopTacticsPerTdp's grouping logic (lines 607-609 of motion-builder.ts)
  function groupByTdp(tactics: Array<{ parentTdp: string; name: string }>): Map<string, string[]> {
    const byTdp = new Map<string, string[]>()
    for (const t of tactics.filter(t => t.parentTdp && t.parentTdp.trim())) {
      const key = normalizeTdp(t.parentTdp)
      const list = byTdp.get(key) ?? []
      list.push(t.name)
      byTdp.set(key, list)
    }
    return byTdp
  }

  it('merges "Container Mgmt" and "Container Management" into one group', () => {
    const tactics = [
      { parentTdp: 'Container Mgmt', name: 'Tactic A' },
      { parentTdp: 'Container Management', name: 'Tactic B' },
    ]
    const groups = groupByTdp(tactics)
    expect(groups.size).toBe(1)
    expect(groups.has('Container Management')).toBe(true)
    expect(groups.get('Container Management')!.length).toBe(2)
  })

  it('merges "Server/Cloud OS" and "Server and Cloud Computing" into one group', () => {
    const tactics = [
      { parentTdp: 'Server/Cloud OS', name: 'Tactic X' },
      { parentTdp: 'Server and Cloud Computing', name: 'Tactic Y' },
    ]
    const groups = groupByTdp(tactics)
    expect(groups.size).toBe(1)
    expect(groups.has('Server and Cloud Computing')).toBe(true)
    expect(groups.get('Server and Cloud Computing')!.length).toBe(2)
  })

  it('keeps distinct TDP domains as separate groups', () => {
    const tactics = [
      { parentTdp: 'Automation', name: 'Tactic 1' },
      { parentTdp: 'Container Mgmt', name: 'Tactic 2' },
      { parentTdp: 'Server/Cloud OS', name: 'Tactic 3' },
    ]
    const groups = groupByTdp(tactics)
    expect(groups.size).toBe(3)
    expect(groups.has('Automation')).toBe(true)
    expect(groups.has('Container Management')).toBe(true)
    expect(groups.has('Server and Cloud Computing')).toBe(true)
  })
})
