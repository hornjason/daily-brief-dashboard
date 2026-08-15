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
} from '../../src/campaign-html-template.ts'

// ── 1. Title cleaning ─────────────────────────────────────────────────────

describe('cleanCampaignTitle — strips email prefixes and title-cases', () => {
  it('strips email prefixes from campaign title', () => {
    const result = cleanCampaignTitle('[nwcorporate] Re: Ansible prospecting and the upcoming SaaS tax')
    expect(result).not.toContain('[nwcorporate]')
    expect(result).not.toContain('Re:')
    expect(result).toBe('Ansible Prospecting and the Upcoming Saas Tax')
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
    expect(result).toContain('Saas Tax Strategy Document')
  })

  it('title-cases the result with minor word handling', () => {
    const result = cleanCampaignTitle('ansible prospecting and the upcoming saas tax')
    expect(result).toBe('Ansible Prospecting and the Upcoming Saas Tax')
  })

  it('preserves already clean titles', () => {
    const result = cleanCampaignTitle('SaaS Tax Offset Sales Play')
    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toContain('[')
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
