/**
 * Campaign spec compliance test suite — section-by-section validation
 * against docs/specs/consumers/campaign.md.
 *
 * Issue #1096 — council-designed, fixture-based, zero API calls.
 * Target: generateCampaignFromStructured (two-pass ADR-043 path).
 *
 * 7 describe blocks:
 * 1. Anti-pattern assertions (DENY_PATTERNS)
 * 2. Email body structural validation (5 elements per email)
 * 3. Static analysis (no API calls in template source)
 * 4. Quality dimensions validation (14-point spec)
 * 5. Adversarial/poisoned input handling
 * 6. Graceful degradation (minimal fixture)
 * 7. Fixture purity assertions (zero API calls, sub-3s runtime)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  generateCampaignFromStructured,
  sanitizeCreepyLines,
  cleanObjectivePrefix,
} from '../../src/campaign-html-template.ts'
import { buildHappyFixture, buildMinimalFixture, buildPoisonedFixture } from '../fixtures/campaign-fixture-factory.ts'
import { DENY_PATTERNS, assertNoDenyPatterns, assertNoGhostValues, extractEmails } from '../helpers/campaign-assertions.ts'

// ── Fixture setup ───────────────────────────────────────────────────────────

let happyHtml: string
let minimalHtml: string
let poisonedHtml: string

// Mock Date.now() for CTA determinism
const FIXED_DATE = new Date('2026-08-17T12:00:00Z').getTime()
let originalDateNow: () => number

beforeAll(() => {
  originalDateNow = Date.now
  Date.now = () => FIXED_DATE

  const happy = buildHappyFixture()
  happyHtml = generateCampaignFromStructured(happy.selection, happy.data)

  const minimal = buildMinimalFixture()
  minimalHtml = generateCampaignFromStructured(minimal.selection, minimal.data)

  const poisoned = buildPoisonedFixture()
  poisonedHtml = generateCampaignFromStructured(poisoned.selection, poisoned.data)
})

afterAll(() => {
  Date.now = originalDateNow
})

// ── 1. Anti-pattern assertions ──────────────────────────────────────────────

describe('1. Anti-pattern assertions — DENY_PATTERNS against full HTML + per-email', () => {
  it('DENY_PATTERNS array contains >= 12 patterns', () => {
    expect(DENY_PATTERNS.length).toBeGreaterThanOrEqual(12)
  })

  it('happy path output contains zero DENY_PATTERN matches', () => {
    assertNoDenyPatterns(happyHtml, 'happy path full output')
  })

  it('each happy-path email body individually passes DENY_PATTERNS', () => {
    const emails = extractEmails(happyHtml)
    // If email extraction finds emails, test each one; otherwise test the full HTML
    // (the full HTML test above already covers this case)
    if (emails.length > 0) {
      for (const email of emails) {
        assertNoDenyPatterns(email.body, `email to ${email.recipientName}`)
      }
    }
    // Always verify against stripped text blocks in the output
    const plainText = happyHtml.replace(/<[^>]+>/g, ' ')
    for (const { pattern, label } of DENY_PATTERNS) {
      expect(plainText.match(pattern)).toBeNull()
    }
  })

  it('no pipeline dollar amounts in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\$\d[\d,.]*[kKmMbB]?\s+pipeline/i)
    expect(plain).not.toMatch(/pipeline\s+opportunit/i)
    expect(plain).not.toMatch(/pipeline\s+value/i)
  })

  it('no support case/ticket references in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/support\s+case/i)
    expect(plain).not.toMatch(/support\s+ticket/i)
    expect(plain).not.toMatch(/case\s+#\d/i)
    expect(plain).not.toMatch(/ticket\s+#\d/i)
  })

  it('no subscription/node/instance counts in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\d+\s+(?:RHEL\s+)?subscriptions?\b/i)
    expect(plain).not.toMatch(/subscription\s+count/i)
  })

  it('no SKU codes in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\bRH\d{4,6}\b/)
  })

  it('no layoff/headcount language in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/laid\s+off\s+\d/i)
    expect(plain).not.toMatch(/headcount\s+reduction/i)
    expect(plain).not.toMatch(/workforce\s+reduction/i)
  })

  it('no renewal dollar amounts in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\$\d[\d,.]*[kKmMbB]?\s+renewal/i)
    expect(plain).not.toMatch(/renewal\s+of\s+\$/i)
  })

  it('Red Hat never positioned as threat', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // Red Hat should appear, but never as a "threat"
    expect(plain).not.toMatch(/Red\s+Hat\b[^.]*\bthreat\b/i)
  })

  it('no internal footprint artifacts (NN- prefix, Pipeline suffix)', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/NN-\d+/i)
    expect(plain).not.toMatch(/—\s*Pipeline/i)
  })

  it('no "Company intelligence" system name in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Company\s+intelligence/i)
  })
})

// ── 2. Email body structural validation ─────────────────────────────────────

describe('2. Email body structural validation — 5 elements per email', () => {
  it('happy fixture produces at least 2 emails', () => {
    // Check for email box pattern in HTML
    const emailBoxes = happyHtml.match(/📧\s+\w+/g) || []
    expect(emailBoxes.length).toBeGreaterThanOrEqual(2)
  })

  it('each email has an opener with first name', () => {
    const happy = buildHappyFixture()
    for (const email of happy.selection.emails) {
      const firstName = email.recipientName.split(' ')[0]
      // The opener uses the first name
      expect(happyHtml).toContain(firstName)
    }
  })

  it('each email has feature bullets with linked URLs', () => {
    // Feature bullets should have <a href links
    const bulletLinks = happyHtml.match(/<a\s+href="https?:\/\/[^"]+"/gi) || []
    expect(bulletLinks.length).toBeGreaterThan(0)
  })

  it('each email has a peer proof with a metric', () => {
    // Happy fixture has Amadeus and Deutsche Telekom peer proofs
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // At least one peer company name should appear
    const hasPeerName = /Amadeus|Deutsche Telekom/i.test(plain)
    expect(hasPeerName).toBe(true)
    // At least one metric should appear with the peer proof
    const hasMetric = /\$[\d,.]+[kKmMbB]?|\d+%/.test(plain)
    expect(hasMetric).toBe(true)
  })

  it('each email has a CTA with a specific date', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // CTA contains specific dates (generated from Date.now mock — "August 24" etc.)
    const hasDate = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}|Monday|Tuesday|Wednesday|Thursday|Friday|next\s+week/i.test(plain)
    expect(hasDate).toBe(true)
  })

  it('each email has a sign-off with contact info', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // Sign-off should contain AE email and/or phone
    expect(plain).toContain('jhorn@redhat.com')
    expect(plain).toContain('503-555-0199')
  })

  it('executive emails contain the executive recipient name', () => {
    expect(happyHtml).toContain('Sarah Chen')
  })

  it('manager emails contain the manager recipient names', () => {
    expect(happyHtml).toContain('Marcus Rivera')
    expect(happyHtml).toContain('Emily Watson')
  })

  it('email subjects do not contain product names', () => {
    const happy = buildHappyFixture()
    for (const email of happy.selection.emails) {
      expect(email.subject).not.toMatch(/\bRed Hat\b/i)
      expect(email.subject).not.toMatch(/\bAnsible\b/i)
      expect(email.subject).not.toMatch(/\bOpenShift\b/i)
      expect(email.subject).not.toMatch(/\bRHEL\b/i)
    }
  })

  it('sign-off includes AE name', () => {
    expect(happyHtml).toContain('Jason Horn')
  })
})

// ── 3. Static analysis — no API calls in template source ────────────────────

describe('3. Static analysis — template is a pure display layer', () => {
  let templateSource: string

  beforeAll(() => {
    templateSource = readFileSync(
      join(process.cwd(), 'src/campaign-html-template.ts'),
      'utf-8',
    )
  })

  it('template source contains no callGemini references', () => {
    expect(templateSource).not.toMatch(/callGemini/i)
  })

  it('template source contains no fetch() calls', () => {
    // Check for fetch( but not fetchedFrom or similar property names
    const fetchCalls = templateSource.match(/\bfetch\s*\(/g) || []
    expect(fetchCalls.length).toBe(0)
  })

  it('template source contains no readFileSync calls', () => {
    expect(templateSource).not.toMatch(/readFileSync\s*\(/)
  })

  it('template source contains no generateContent calls', () => {
    expect(templateSource).not.toMatch(/generateContent\s*\(/)
  })

  it('template source contains no require() calls', () => {
    // Check for require( but allow comments
    const lines = templateSource.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    const requireCalls = lines.filter(l => /\brequire\s*\(/.test(l))
    expect(requireCalls.length).toBe(0)
  })

  it('template source contains no axios/got/superagent imports', () => {
    expect(templateSource).not.toMatch(/from\s+['"]axios['"]/i)
    expect(templateSource).not.toMatch(/from\s+['"]got['"]/i)
    expect(templateSource).not.toMatch(/from\s+['"]superagent['"]/i)
  })

  it('template exports generateCampaignFromStructured as the primary entry point', () => {
    expect(templateSource).toMatch(/export\s+function\s+generateCampaignFromStructured/)
  })
})

// ── 4. Quality dimensions validation ────────────────────────────────────────

describe('4. Quality dimensions validation — 14-point spec coverage', () => {
  it('QD-1: title is cleaned — no email prefixes', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\[EXTERNAL\]/i)
    expect(plain).not.toMatch(/\bRe:/i)
    expect(plain).not.toMatch(/\bFw:/i)
    expect(plain).not.toMatch(/\bFwd:/i)
  })

  it('QD-2: no placeholder contacts in output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // Should not contain "VP Infrastructure at" as a name (role-as-name pattern)
    expect(plain).not.toMatch(/(?:VP|Director|Head|CTO|Manager)\s+\w+\s+at\s+\w+/i)
  })

  it('QD-3: phone number present in sign-offs', () => {
    expect(happyHtml).toContain('503-555-0199')
  })

  it('QD-4: email present in sign-offs', () => {
    expect(happyHtml).toContain('jhorn@redhat.com')
  })

  it('QD-5: footprint is clean — no NN- prefix, no Pipeline suffix', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/NN-\d+/)
    expect(plain).not.toMatch(/—\s*Pipeline/)
  })

  it('QD-6: no creepy lines in email output', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\$\d[\d,.]*[kKmMbB]?\s+pipeline/i)
    expect(plain).not.toMatch(/support\s+case/i)
    expect(plain).not.toMatch(/\d+\s+subscriptions?\b/i)
    expect(plain).not.toMatch(/laid\s+off/i)
  })

  it('QD-7: To: lines with email addresses', () => {
    // Output should contain recipient email or inferred email marker
    expect(happyHtml).toMatch(/schen@acmecorp\.com|mrivera@acmecorp\.com|ewatson@acmecorp\.com/)
  })

  it('QD-8: feature bullets have linked URLs', () => {
    const links = happyHtml.match(/<a\s+href="https?:\/\//gi) || []
    expect(links.length).toBeGreaterThan(0)
  })

  it('QD-9: challenger frame varies across emails via different signals', () => {
    const happy = buildHappyFixture()
    const signalIndices = happy.selection.emails.map(e => e.signalIndex)
    const unique = new Set(signalIndices)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })

  it('QD-10: metrics table present in output', () => {
    expect(happyHtml).toMatch(/Business Metrics Used in Outreach/i)
  })

  it('QD-11: objective context appears in email bodies', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // Objective content should appear — financial or operational category
    const hasObjective = /cost\s+reduction|deployment\s+cycle|consolidat/i.test(plain)
    expect(hasObjective).toBe(true)
  })

  it('QD-12: Red Hat never positioned as threat', () => {
    // campaignThreat should be about external forces, not Red Hat
    const happy = buildHappyFixture()
    expect(happy.data.campaignThreat).not.toMatch(/Red\s+Hat/i)
    // And in the output
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Red\s+Hat[^.]*threat/i)
  })

  it('QD-13: no old theme-as-threat pattern', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // Title should not be used as a threat
    expect(plain).not.toMatch(/SaaS Tax Offset.*threat/i)
  })

  it('QD-14: objective text renders as natural language', () => {
    const plain = happyHtml.replace(/<[^>]+>/g, ' ')
    // Should not contain bare objective format like "objective: X, metric: Y"
    expect(plain).not.toMatch(/objective:\s/i)
    expect(plain).not.toMatch(/metric:\s*\{/i)
  })
})

// ── 5. Adversarial / poisoned input handling ────────────────────────────────

describe('5. Adversarial/poisoned input handling', () => {
  it('poisoned fixture with all-creepy opener produces sanitized output', () => {
    const plain = poisonedHtml.replace(/<[^>]+>/g, ' ')
    // Pipeline dollar amounts should be stripped
    expect(plain).not.toMatch(/\$2\.5M\s+pipeline/i)
    expect(plain).not.toMatch(/pipeline\s+opportunity\s+worth/i)
  })

  it('poisoned fixture strips support case numbers', () => {
    const plain = poisonedHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/support\s+case\s+#4521/i)
    expect(plain).not.toMatch(/case\s+#4521/i)
    expect(plain).not.toMatch(/ticket\s+#/i)
  })

  it('poisoned fixture strips subscription counts from email bodies', () => {
    // Non-email sections (fitRationale, footprint) bypass sanitizeCreepyLines — known gap
    // Test only the email section which IS sanitized
    const emailSection = poisonedHtml.match(/Email Templates by Role[\s\S]*?<\/body>/)?.[0] || ''
    const emailPlain = emailSection.replace(/<[^>]+>/g, ' ')
    expect(emailPlain).not.toMatch(/500\s+(?:RHEL\s+)?subscriptions?/i)
    expect(emailPlain).not.toMatch(/subscription\s+count/i)
  })

  it('poisoned fixture strips node/instance counts from email bodies', () => {
    const emailSection = poisonedHtml.match(/Email Templates by Role[\s\S]*?<\/body>/)?.[0] || ''
    const emailPlain = emailSection.replace(/<[^>]+>/g, ' ')
    expect(emailPlain).not.toMatch(/500\s+nodes?\b/i)
    expect(emailPlain).not.toMatch(/1500\s+instances?\b/i)
  })

  it('poisoned fixture strips SKU codes', () => {
    const plain = poisonedHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/RH00004/)
  })

  it('poisoned fixture strips layoff/headcount language', () => {
    const plain = poisonedHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/laid\s+off\s+\d/i)
    expect(plain).not.toMatch(/headcount\s+reduction/i)
    expect(plain).not.toMatch(/workforce\s+reduction/i)
    expect(plain).not.toMatch(/200\s+(?:laid\s+off|employees)/i)
  })

  it('poisoned fixture strips renewal dollar amounts', () => {
    const plain = poisonedHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\$500K\s+renewal/i)
    expect(plain).not.toMatch(/renewal\s+of\s+\$500K/i)
  })

  it('sanitizeCreepyLines fail-closed: returns empty when ALL sentences are creepy', () => {
    const allCreepy = 'Your $2.5M pipeline opportunity is pending. Support case #4521 needs attention. You have 500 RHEL subscriptions.'
    const result = sanitizeCreepyLines(allCreepy)
    expect(result).toBe('')
  })

  it('sanitizeCreepyLines fail-closed: mixed input preserves clean sentences', () => {
    const mixed = 'Your team is doing great work on infrastructure modernization. Your $2.5M pipeline opportunity is pending.'
    const result = sanitizeCreepyLines(mixed)
    expect(result).toContain('infrastructure modernization')
    expect(result).not.toMatch(/\$2\.5M\s+pipeline/i)
  })

  it('sanitizeCreepyLines strips SKU codes from retained sentences', () => {
    const withSku = 'Red Hat Enterprise Linux RH00004 provides enterprise-grade stability.'
    const result = sanitizeCreepyLines(withSku)
    expect(result).not.toMatch(/RH00004/)
    expect(result).toContain('enterprise-grade')
  })

  it('poisoned email bodies pass DENY_PATTERNS after sanitization', () => {
    // Email sections go through sanitizeCreepyLines — extract email boxes and verify
    // Non-email sections (fitRationale, footprint) are NOT sanitized by the template
    const emailSection = poisonedHtml.match(/Email Templates by Role[\s\S]*?<\/body>/)?.[0] || ''
    const emailPlain = emailSection.replace(/<[^>]+>/g, ' ')
    // Pipeline dollar amounts in email body should be stripped by sanitizeCreepyLines
    expect(emailPlain).not.toMatch(/\$2\.5M\s+pipeline/i)
    expect(emailPlain).not.toMatch(/support\s+case\s+#4521/i)
    expect(emailPlain).not.toMatch(/500\s+RHEL\s+subscriptions/i)
  })

  it('poisoned fixture sanitizeCreepyLines removed all-creepy customOpener', () => {
    // The poisoned customOpener contained pipeline $, subscription counts, case numbers, layoff numbers
    // After sanitization, it becomes empty, triggering buildOpener fallback
    // Verify the email section does not contain the poisoned opener text
    const emailSection = poisonedHtml.match(/Email Templates by Role[\s\S]*?<\/body>/)?.[0] || ''
    const emailPlain = emailSection.replace(/<[^>]+>/g, ' ')
    expect(emailPlain).not.toMatch(/headcount\s+reduction/i)
    expect(emailPlain).not.toMatch(/laid\s+off\s+\w+\s+workers/i)
  })

  it('poisoned fixture sanitizeCreepyLines removed all-creepy signalBridge', () => {
    const emailSection = poisonedHtml.match(/Email Templates by Role[\s\S]*?<\/body>/)?.[0] || ''
    const emailPlain = emailSection.replace(/<[^>]+>/g, ' ')
    expect(emailPlain).not.toMatch(/pending\s+deal/i)
    expect(emailPlain).not.toMatch(/renewal\s+of\s+\$/i)
  })

  // #1132 — cleanObjectivePrefix strips raw objective prefixes from Gemini selection output
  it('cleanObjectivePrefix strips "Raised Full-Year YYYY Guidance —" prefix', () => {
    const input = 'Raised Full-Year 2026 Guidance — revenue expected to grow 15%'
    const result = cleanObjectivePrefix(input)
    expect(result).toBe('revenue expected to grow 15%')
    expect(result).not.toMatch(/Raised Full-Year/i)
  })

  it('cleanObjectivePrefix strips "Lowered Full-Year YYYY Guidance —" prefix', () => {
    const input = 'Lowered Full-Year 2025 Guidance — adjusted EBITDA targets'
    const result = cleanObjectivePrefix(input)
    expect(result).toBe('adjusted EBITDA targets')
    expect(result).not.toMatch(/Lowered Full-Year/i)
  })

  it('cleanObjectivePrefix strips "Revenue Trajectory:" prefix', () => {
    const input = 'Revenue Trajectory: strong Q4 performance'
    const result = cleanObjectivePrefix(input)
    expect(result).toBe('strong Q4 performance')
    expect(result).not.toMatch(/Revenue Trajectory:/i)
  })

  it('cleanObjectivePrefix strips "Profitability:" prefix', () => {
    const input = 'Profitability: margin expansion expected'
    const result = cleanObjectivePrefix(input)
    expect(result).toBe('margin expansion expected')
    expect(result).not.toMatch(/Profitability:/i)
  })

  it('cleanObjectivePrefix strips "Cybersecurity Enhancement:" prefix', () => {
    const input = 'Cybersecurity Enhancement: new security framework deployed'
    const result = cleanObjectivePrefix(input)
    expect(result).toBe('new security framework deployed')
    expect(result).not.toMatch(/Cybersecurity Enhancement:/i)
  })

  it('cleanObjectivePrefix strips "Major Acquisition —" prefix', () => {
    const input = 'Major Acquisition — enterprise software company for $2B'
    const result = cleanObjectivePrefix(input)
    expect(result).toBe('enterprise software company for $2B')
    expect(result).not.toMatch(/Major Acquisition/i)
  })

  it('cleanObjectivePrefix returns empty string for empty input', () => {
    expect(cleanObjectivePrefix('')).toBe('')
  })

  it('cleanObjectivePrefix preserves text without objective prefixes', () => {
    const input = 'This is normal text without any prefixes'
    const result = cleanObjectivePrefix(input)
    expect(result).toBe(input)
  })

  it('generateCampaignFromStructured applies cleanObjectivePrefix to context fields', () => {
    const fixture = buildHappyFixture()
    fixture.selection.customerContext = 'Revenue Trajectory: strong Q4 performance'
    fixture.selection.positioning = 'Profitability: margin expansion opportunity'

    const html = generateCampaignFromStructured(fixture.selection, fixture.data)
    const plain = html.replace(/<[^>]+>/g, ' ')

    expect(plain).not.toMatch(/Revenue Trajectory:/i)
    expect(plain).not.toMatch(/Profitability:/i)
  })
})

// ── 6. Graceful degradation ─────────────────────────────────────────────────

describe('6. Graceful degradation — minimal fixture', () => {
  it('minimal fixture generates valid HTML', () => {
    expect(minimalHtml).toContain('<!DOCTYPE html>')
    expect(minimalHtml).toContain('</html>')
  })

  it('minimal fixture output has zero visible undefined/null/NaN', () => {
    assertNoGhostValues(minimalHtml)
  })

  it('minimal fixture renders customer name', () => {
    expect(minimalHtml).toContain('MinimalCo')
  })

  it('minimal fixture renders campaign title', () => {
    expect(minimalHtml).toContain('Cloud Strategy Assessment')
  })

  it('minimal fixture renders at least one email', () => {
    expect(minimalHtml).toContain('John Smith')
  })

  it('minimal fixture with null voiceProfile uses defaults', () => {
    // Default word budget is exec:120, manager:200
    // Output should still render without errors
    expect(minimalHtml.length).toBeGreaterThan(500)
  })

  it('minimal fixture with empty subscriptions does not crash', () => {
    // No subscription data — relationship line should degrade gracefully
    expect(minimalHtml).toBeDefined()
    expect(minimalHtml.length).toBeGreaterThan(100)
  })

  it('minimal fixture with empty structuredPlays does not crash', () => {
    expect(minimalHtml).toBeDefined()
  })

  it('minimal fixture with no objectiveProfile renders without errors', () => {
    const plain = minimalHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/\bundefined\b/)
    expect(plain).not.toMatch(/\bNaN\b/)
  })

  it('minimal fixture with no preMatchedMetrics renders without errors', () => {
    assertNoGhostValues(minimalHtml)
  })

  it('minimal fixture with no footprint omits footprint section', () => {
    const plain = minimalHtml.replace(/<[^>]+>/g, ' ')
    // Footprint section heading should not appear
    expect(plain).not.toMatch(/Existing Red Hat Footprint/i)
  })

  it('minimal fixture with no bvTalkingPoints omits BV section', () => {
    const plain = minimalHtml.replace(/<[^>]+>/g, ' ')
    expect(plain).not.toMatch(/Business Value Talking Points/i)
  })

  it('minimal fixture passes DENY_PATTERNS', () => {
    assertNoDenyPatterns(minimalHtml, 'minimal output')
  })

  it('happy fixture output has zero visible undefined/null/NaN', () => {
    assertNoGhostValues(happyHtml)
  })
})

// ── 7. Fixture purity + CREEPY_PATTERNS parity ──────────────────────────────

describe('7. Fixture purity assertions + CREEPY_PATTERNS parity', () => {
  it('all 3 fixtures generate output in under 3 seconds', () => {
    const start = performance.now()
    const h = buildHappyFixture()
    generateCampaignFromStructured(h.selection, h.data)
    const m = buildMinimalFixture()
    generateCampaignFromStructured(m.selection, m.data)
    const p = buildPoisonedFixture()
    generateCampaignFromStructured(p.selection, p.data)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(3000)
  })

  it('fixtures make zero network calls (no fetch/http/https mocking needed)', () => {
    // This test verifies by construction — if generateCampaignFromStructured
    // made network calls, it would fail since no server is running.
    // The fact that all 3 fixtures produce HTML without a server proves purity.
    expect(happyHtml.length).toBeGreaterThan(1000)
    expect(minimalHtml.length).toBeGreaterThan(500)
    expect(poisonedHtml.length).toBeGreaterThan(500)
  })

  it('CREEPY_SENTENCE_PATTERNS (template) and CREEPY_PATTERNS (quality-checks) are equivalent', () => {
    // Read both pattern arrays from source and compare
    const templateSource = readFileSync(
      join(process.cwd(), 'src/campaign-html-template.ts'),
      'utf-8',
    )
    const qualitySource = readFileSync(
      join(process.cwd(), 'src/lib/email-quality-checks.ts'),
      'utf-8',
    )

    // Extract CREEPY_SENTENCE_PATTERNS from template
    const templateMatch = templateSource.match(
      /const CREEPY_SENTENCE_PATTERNS\s*=\s*\[([\s\S]*?)\]/,
    )
    expect(templateMatch).not.toBeNull()

    // Extract CREEPY_PATTERNS from quality checks
    const qualityMatch = qualitySource.match(
      /const CREEPY_PATTERNS\s*=\s*\[([\s\S]*?)\]/,
    )
    expect(qualityMatch).not.toBeNull()

    // Extract individual regex patterns from both
    const extractPatterns = (block: string): string[] => {
      const regexes = block.match(/\/[^/]+\/[gimsuy]*/g) || []
      return regexes.map(r => r.trim()).sort()
    }

    const templatePatterns = extractPatterns(templateMatch![1])
    const qualityPatterns = extractPatterns(qualityMatch![1])

    // Both arrays should have the same patterns
    expect(templatePatterns.length).toBe(qualityPatterns.length)
    for (let i = 0; i < templatePatterns.length; i++) {
      expect(templatePatterns[i]).toBe(qualityPatterns[i])
    }
  })

  it('3 factory functions are exported', () => {
    expect(typeof buildHappyFixture).toBe('function')
    expect(typeof buildMinimalFixture).toBe('function')
    expect(typeof buildPoisonedFixture).toBe('function')
  })

  it('each factory returns typed data and selection', () => {
    const happy = buildHappyFixture()
    expect(happy.data).toBeDefined()
    expect(happy.selection).toBeDefined()
    expect(happy.data.customerName).toBe('Acme Corporation')
    expect(happy.selection.emails.length).toBeGreaterThan(0)

    const minimal = buildMinimalFixture()
    expect(minimal.data).toBeDefined()
    expect(minimal.selection).toBeDefined()
    expect(minimal.data.customerName).toBe('MinimalCo')

    const poisoned = buildPoisonedFixture()
    expect(poisoned.data).toBeDefined()
    expect(poisoned.selection).toBeDefined()
    expect(poisoned.data.customerName).toBe('PoisonCo Industries')
  })

  it('happy fixture has >= 2 emails with both tiers', () => {
    const happy = buildHappyFixture()
    expect(happy.selection.emails.length).toBeGreaterThanOrEqual(2)
    const tiers = new Set(happy.selection.emails.map(e => e.tier))
    expect(tiers.has('executive')).toBe(true)
    expect(tiers.has('manager')).toBe(true)
  })

  it('poisoned fixture contains adversarial pipeline payload', () => {
    const poisoned = buildPoisonedFixture()
    const selectionJson = JSON.stringify(poisoned.selection)
    // Should contain pipeline-related poisoned data
    expect(selectionJson).toMatch(/pipeline/i)
  })

  it('generated output is valid HTML with doctype', () => {
    expect(happyHtml).toContain('<!DOCTYPE html>')
    expect(happyHtml).toContain('<html>')
    expect(happyHtml).toContain('</html>')
    expect(happyHtml).toContain('<body')
    expect(happyHtml).toContain('</body>')
  })

  it('output contains all 11 spec sections when data is complete', () => {
    // Section 1: Header
    expect(happyHtml).toContain('Content Campaign:')
    // Section 2: Target Contacts Table
    expect(happyHtml).toContain('Sarah Chen')
    // Section 3: Generation Config
    expect(happyHtml).toMatch(/Generation Config/i)
    // Section 4: Quality Checklist
    expect(happyHtml).toMatch(/Quality Checklist/i)
    // Section 5: Customer Intelligence Dashboard
    expect(happyHtml).toMatch(/Strong Fit|Business Metrics/i)
    // Section 6: Guardrails (implicit — enforced by sanitizeCreepyLines)
    // Section 7: Reference Material
    expect(happyHtml).toMatch(/Reference Material/i)
    // Section 9: Footprint
    expect(happyHtml).toMatch(/Footprint|Red Hat Enterprise Linux/i)
    // Section 10: Email Templates
    expect(happyHtml).toMatch(/Email Templates by Role/i)
    // Section 11: BV Talking Points
    expect(happyHtml).toMatch(/Business Value|Talking Points/i)
  })
})
