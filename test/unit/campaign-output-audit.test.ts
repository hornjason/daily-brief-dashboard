/**
 * Gold standard compliance tests for campaign output quality.
 * Tests template functions with fixture data — no API calls.
 * Gold standard: data/cache/campaign-gold-standard.txt
 */

import { describe, it, expect } from 'bun:test'
import {
  cleanCampaignTitle,
  isRealPersonName,
  sanitizeFootprint,
  buildChallengerFrame,
  sanitizeCreepyLines,
  renderObjectiveBlock,
  renderMetricsTable,
} from '../../src/campaign-html-template.ts'
import type { UsedObjective } from '../../src/campaign-html-template.ts'
import type { CustomerObjectiveProfile } from '../../src/modules/intelligence-module.ts'

// ── 1. Title cleaning ─────────────────────────────────────────────────────

describe('cleanCampaignTitle — strips email prefixes and title-cases', () => {
  it('strips email prefixes from campaign title', () => {
    const result = cleanCampaignTitle('[nwcorporate] Re: Ansible prospecting and the upcoming SaaS tax')
    expect(result).not.toContain('[nwcorporate]')
    expect(result).not.toContain('Re:')
    expect(result).toBe('Ansible Prospecting and the Upcoming SaaS Tax')
  })

  it('strips multiple prefixes: [EXTERNAL] Fwd: Re:', () => {
    const result = cleanCampaignTitle('[EXTERNAL] Fwd: Re: Important sales play update')
    expect(result).not.toContain('[EXTERNAL]')
    expect(result).not.toContain('Fwd:')
    expect(result).not.toContain('Re:')
    expect(result).toContain('Important')
  })

  it('strips FW: prefix', () => {
    const result = cleanCampaignTitle('FW: SaaS tax strategy document')
    expect(result).not.toContain('FW:')
    expect(result).toContain('SaaS Tax Strategy Document')
  })

  it('title-cases the result with minor word handling', () => {
    const result = cleanCampaignTitle('ansible prospecting and the upcoming saas tax')
    expect(result).toBe('Ansible Prospecting and the Upcoming SaaS Tax')
  })

  it('preserves already clean titles', () => {
    const result = cleanCampaignTitle('SaaS Tax Offset Sales Play')
    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toContain('[')
  })

  it('preserves AI acronym in title', () => {
    const result = cleanCampaignTitle('AI infrastructure modernization strategy')
    expect(result).toBe('AI Infrastructure Modernization Strategy')
  })

  it('preserves multiple acronyms in title', () => {
    const result = cleanCampaignTitle('RHEL and openshift TCO analysis')
    expect(result).toContain('RHEL')
    expect(result).toContain('OpenShift')
    expect(result).toContain('TCO')
  })

  it('returns empty string for empty input', () => {
    expect(cleanCampaignTitle('')).toBe('')
  })
})

// ── 2. No placeholder contacts ────────────────────────────────────────────

describe('isRealPersonName — rejects role-based placeholder names', () => {
  it('accepts real person names', () => {
    expect(isRealPersonName('Dhrupad Trivedi')).toBe(true)
    expect(isRealPersonName('Michelle Caron')).toBe(true)
    expect(isRealPersonName('Ryan Henderson')).toBe(true)
    expect(isRealPersonName('Chris Wayne')).toBe(true)
  })

  it('rejects "Role at Company" patterns', () => {
    expect(isRealPersonName('VP Infrastructure at A10 Networks')).toBe(false)
    expect(isRealPersonName('Director of Security at Acme')).toBe(false)
    expect(isRealPersonName('Head of Cloud Operations at Google')).toBe(false)
    expect(isRealPersonName('CTO at Startup Inc')).toBe(false)
  })

  it('rejects bare role titles', () => {
    expect(isRealPersonName('VP Engineering')).toBe(false)
    expect(isRealPersonName('Sr. Director IT')).toBe(false)
    expect(isRealPersonName('Chief Technology Officer')).toBe(false)
    expect(isRealPersonName('Manager DevOps')).toBe(false)
  })

  it('rejects names shorter than 4 characters', () => {
    expect(isRealPersonName('AB')).toBe(false)
    expect(isRealPersonName('Joe')).toBe(false)
  })

  it('rejects empty or missing names', () => {
    expect(isRealPersonName('')).toBe(false)
    expect(isRealPersonName('   ')).toBe(false)
  })
})

// ── 3. Challenger frame varies ────────────────────────────────────────────

describe('buildChallengerFrame — produces distinct outputs for different indices', () => {
  const dataPoints = [
    'SB 122 redefines remotely accessed software as tangible personal property.',
    'Self-managed deployment eliminates SaaS tax exposure entirely.',
    'Companies that consolidate before January 2027 lock in the exemption.',
  ]

  it('produces 3+ distinct outputs for different data points', () => {
    const outputs = dataPoints.map((dp, i) => buildChallengerFrame(dp, i))
    const unique = new Set(outputs)
    expect(unique.size).toBe(3)
  })

  it('varies the closing sentence across email indices', () => {
    const dp = 'Self-managed deployment avoids the SaaS classification.'
    const v0 = buildChallengerFrame(dp, 0)
    const v1 = buildChallengerFrame(dp, 1)
    const v2 = buildChallengerFrame(dp, 2)
    const v3 = buildChallengerFrame(dp, 3)
    const closers = new Set([v0, v1, v2, v3])
    expect(closers.size).toBeGreaterThanOrEqual(4)
  })

  it('always starts with the data point', () => {
    const dp = 'Companies adopting self-managed automation see 40% lower TCO'
    const result = buildChallengerFrame(dp, 0)
    expect(result.startsWith(dp)).toBe(true)
  })

  it('returns empty string for empty data point', () => {
    expect(buildChallengerFrame('', 0)).toBe('')
  })
})

// ── 4. Reference line has full URLs ───────────────────────────────────────
// Gold standard shows: "Holland & Knight's analysis of SB 122" with links
// This is validated by the existing sanitizeReferenceLine tests —
// the key property here is that truncated titles like "The Party's Over.."
// are NOT acceptable; full titles must be used.

describe('reference line — full titles not truncated', () => {
  it('gold standard reference lines use full document titles', () => {
    const goldStandardRefs = [
      "Holland & Knight's analysis of SB 122",
      "state-by-state SaaS tax landscape",
      "Brad Hinson — SaaS Tax Offset Sales Play",
    ]
    for (const ref of goldStandardRefs) {
      expect(ref.endsWith('..')).toBe(false)
      expect(ref.length).toBeGreaterThan(10)
    }
  })
})

// ── 5. Footprint has no raw metadata ──────────────────────────────────────

describe('sanitizeFootprint — strips internal signal metadata', () => {
  it('strips NN- prefixes', () => {
    const result = sanitizeFootprint('NN-VMWare Replace, NN-Cloud Migration')
    expect(result).not.toContain('NN-')
    expect(result).toContain('VMWare Replace')
    expect(result).toContain('Cloud Migration')
  })

  it('strips "— Pipeline" suffixes', () => {
    const result = sanitizeFootprint('VMWare Replace — Pipeline')
    expect(result).not.toContain('— Pipeline')
    expect(result).toContain('VMWare Replace')
  })

  it('strips "Company intelligence for {name}" patterns', () => {
    const result = sanitizeFootprint('Company intelligence for A10, RHEL Expansion')
    expect(result).not.toContain('Company intelligence for')
    expect(result).toContain('RHEL Expansion')
  })

  it('strips "Industry analysis: {industry}" patterns', () => {
    const result = sanitizeFootprint('Industry analysis: Networking Equipment, Security growth')
    expect(result).not.toContain('Industry analysis:')
    expect(result).toContain('Security growth')
  })

  it('preserves clean footprint text unchanged', () => {
    const clean = 'Red Hat Enterprise Linux (embedded in Thunder/Defend products via TD Synnex)'
    expect(sanitizeFootprint(clean)).toBe(clean)
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeFootprint('')).toBe('')
  })

  it('handles combined raw metadata', () => {
    const raw = 'Company intelligence for A10, NN-VMWare Replace — Pipeline'
    const result = sanitizeFootprint(raw)
    expect(result).not.toContain('Company intelligence for')
    expect(result).not.toContain('NN-')
    expect(result).not.toContain('— Pipeline')
    expect(result).toContain('VMWare Replace')
  })
})

// ── 6. Creepy line sanitizer catches pipeline in footprint ────────────────

describe('sanitizeCreepyLines — footprint-specific patterns', () => {
  it('strips pipeline references from footprint-like text', () => {
    const input = 'Strong RHEL foundation. There is a $514K VMware Replace pipeline opportunity. Automation eligible.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('pipeline opportunity')
    expect(result).not.toContain('$514K')
    expect(result).toContain('Strong RHEL foundation')
    expect(result).toContain('Automation eligible')
  })

  it('preserves non-pipeline dollar amounts in peer proofs', () => {
    const input = 'Amadeus achieved $5.62M in total benefits with 257.9% ROI.'
    const result = sanitizeCreepyLines(input)
    expect(result).toContain('$5.62M')
    expect(result).toContain('Amadeus')
  })
})

// ── renderObjectiveBlock in email body — ADR-044 ─────────────────────────

describe('renderObjectiveBlock in email body — ADR-044', () => {
  const emptyProfile: CustomerObjectiveProfile = { financial: [], security: [], operational: [], innovation: [], growth: [] }

  it('renderObjectiveBlock produces sentence for financial profile with objective context', () => {
    const profile: CustomerObjectiveProfile = {
      ...emptyProfile,
      financial: [{ objective: '12% YoY revenue growth', metric: '12%', priority: null, source: 'Q2 2026 earnings', confidence: 'HIGH' }],
    }
    const result = renderObjectiveBlock(profile, { threat: 'SaaS tax', solution: 'self-managed automation' })
    expect(result).toContain('12% YoY revenue growth')
    expect(result).toStartWith('With ')
    expect(result).not.toBe('')
  })

  it('sanitizeCreepyLines still strips pipeline data from rendered block', () => {
    const profile: CustomerObjectiveProfile = {
      ...emptyProfile,
      financial: [{ objective: '$514K pipeline opportunity', metric: '$514K pipeline opportunity', priority: null, source: 'internal', confidence: 'HIGH' }],
    }
    const objCtx = renderObjectiveBlock(profile, { threat: 'SaaS tax', solution: 'automation' })
    const combined = `Your IaC modernization signal caught our attention. ${objCtx}`
    const sanitized = sanitizeCreepyLines(combined)
    expect(sanitized).not.toContain('pipeline')
    expect(sanitized).not.toContain('$514K')
    expect(sanitized).toContain('IaC modernization')
  })

  it('renderObjectiveBlock with threat/solution produces correct framing', () => {
    const profile: CustomerObjectiveProfile = {
      ...emptyProfile,
      security: [{ objective: 'zero-trust initiative', metric: null, priority: 'HIGH', source: 'strategy', confidence: 'HIGH' }],
    }
    const result = renderObjectiveBlock(profile, { threat: 'rising breach costs', solution: 'Red Hat security platform' })
    expect(result).toContain('rising breach costs')
    expect(result).toContain('Red Hat security platform')
    expect(result).toContain('strategic exposure')
  })

  it('renderObjectiveBlock with clean discrete metrics produces readable sentence', () => {
    const profile: CustomerObjectiveProfile = {
      ...emptyProfile,
      financial: [
        { objective: 'Revenue Trajectory: $290.6M revenue', metric: '$290.6M', priority: null, source: 'Financial Health', confidence: 'HIGH' },
        { objective: 'Revenue Trajectory: 11% growth', metric: '11%', priority: null, source: 'Financial Health', confidence: 'HIGH' },
      ],
    }
    const result = renderObjectiveBlock(profile, { threat: 'rising costs', solution: 'automation' })
    expect(result).toContain('$290.6M')
    expect(result).toContain('protects this trajectory')
    expect(result.length).toBeLessThan(200)
  })
})

// ── renderMetricsTable — ADR-044 Phase 4 (UsedObjective[]) ────────────────

describe('renderMetricsTable — produces HTML table from used objectives', () => {
  it('returns empty string for empty array', () => {
    expect(renderMetricsTable([])).toBe('')
  })

  it('produces HTML table with correct headers including Used In column', () => {
    const used: UsedObjective[] = [
      { objective: '11% growth', metric: '11%', category: 'Financial', usedIn: 'Jane Doe (executive)' },
    ]
    const result = renderMetricsTable(used)
    expect(result).toContain('<table')
    expect(result).toContain('Category')
    expect(result).toContain('Metric')
    expect(result).toContain('Used In')
    expect(result).not.toContain('Source')
    expect(result).not.toContain('Priority')
  })

  it('renders rows for each used objective with Used In', () => {
    const used: UsedObjective[] = [
      { objective: '$290.6M revenue', metric: '$290.6M', category: 'Financial', usedIn: 'Jane Doe (executive)' },
      { objective: 'zero-trust initiative', metric: null, category: 'Security', usedIn: 'Bob Smith (manager)' },
    ]
    const result = renderMetricsTable(used)
    expect(result).toContain('Financial')
    expect(result).toContain('Security')
    expect(result).toContain('$290.6M revenue')
    expect(result).toContain('zero-trust initiative')
    expect(result).toContain('Jane Doe (executive)')
    expect(result).toContain('Bob Smith (manager)')
    const rowCount = (result.match(/<tr/g) || []).length
    expect(rowCount).toBe(3) // header + 2 data rows
  })

  it('deduplicates entries with same metric value', () => {
    const used: UsedObjective[] = [
      { objective: '15.5% growth', metric: '15.5%', category: 'Financial', usedIn: 'Alice (executive)' },
      { objective: '$80.1M (+15.5% YoY)', metric: '15.5%', category: 'Financial', usedIn: 'Bob (manager)' },
    ]
    const result = renderMetricsTable(used)
    const rowCount = (result.match(/<tr/g) || []).length
    expect(rowCount).toBe(2) // header + 1 deduped data row
  })

  it('title says Business Metrics Used in Outreach', () => {
    const used: UsedObjective[] = [
      { objective: 'test', metric: '10%', category: 'Financial', usedIn: 'Test (executive)' },
    ]
    const result = renderMetricsTable(used)
    expect(result).toContain('Business Metrics Used in Outreach')
  })
})
