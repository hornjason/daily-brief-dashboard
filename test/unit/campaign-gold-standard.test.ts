/**
 * Gold standard fixture convergence test.
 * Compares campaign-html-template.ts output against the gold standard fixture.
 * Expected: many mismatches before template unification (slices 2-8).
 *
 * GitHub Issue #1053
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  structuralDiff,
  extractSections,
  extractSectionsFromText,
  checkContactTableColumns,
  checkMetricBoxes,
  checkGuardrailBadges,
  checkBrandColor,
  countEmailBoxes,
} from '../utils/campaign-structural-diff.ts'

const FIXTURE_DIR = resolve(import.meta.dir, '../fixtures')
const fixtureHtml = readFileSync(resolve(FIXTURE_DIR, 'campaign-gold-standard.html'), 'utf-8')
const fixtureText = readFileSync(resolve(FIXTURE_DIR, 'campaign-gold-standard.txt'), 'utf-8')

// ── Fixture integrity ──

describe('gold standard fixture integrity', () => {
  it('HTML fixture file is non-empty', () => {
    expect(fixtureHtml.length).toBeGreaterThan(1000)
  })

  it('text fixture file is non-empty', () => {
    expect(fixtureText.length).toBeGreaterThan(1000)
  })

  it('HTML fixture contains the brand color', () => {
    expect(fixtureHtml).toContain('#c41e3a')
  })

  it('text fixture contains all expected sections', () => {
    const sections = extractSectionsFromText(fixtureText)
    const headings = sections.map(s => s.heading)
    expect(headings.some(h => /Target Contacts/i.test(h))).toBe(true)
    expect(headings.some(h => /Generation Config/i.test(h))).toBe(true)
    expect(headings.some(h => /Email Quality Checklist/i.test(h))).toBe(true)
    expect(headings.some(h => /Customer Intelligence Dashboard/i.test(h))).toBe(true)
    expect(headings.some(h => /Why .+ Is a Strong Fit/i.test(h))).toBe(true)
    expect(headings.some(h => /Strategic Initiatives/i.test(h))).toBe(true)
    expect(headings.some(h => /Competitive Position/i.test(h))).toBe(true)
    expect(headings.some(h => /SB 122 Reference Material/i.test(h))).toBe(true)
    expect(headings.some(h => /SB 122 Eligibility/i.test(h))).toBe(true)
    expect(headings.some(h => /Existing Red Hat Footprint/i.test(h))).toBe(true)
    expect(headings.some(h => /Email Templates by Role/i.test(h))).toBe(true)
    expect(headings.some(h => /Manager Outreach/i.test(h))).toBe(true)
    expect(headings.some(h => /Call Prep — Key Talking Points/i.test(h))).toBe(true)
  })

  it('text fixture has sections in correct order', () => {
    const sections = extractSectionsFromText(fixtureText)
    const order = [
      'Target Contacts',
      'Generation Config',
      'Email Quality Checklist',
      'Customer Intelligence Dashboard',
      'Strategic Initiatives',
      'Competitive Position',
      'Call Prep — Key Talking Points',
      'Email Templates by Role',
    ]
    let lastIdx = -1
    for (const name of order) {
      const section = sections.find(s => s.heading.includes(name))
      if (section) {
        expect(section.index).toBeGreaterThan(lastIdx)
        lastIdx = section.index
      }
    }
  })
})

// ── Structural diff utility unit tests ──

describe('structural diff utility', () => {
  it('extractSections parses heading tags from HTML', () => {
    const html = '<h1>Title</h1><h2>Section One</h2><p>body</p><h3>Sub Section</h3>'
    const sections = extractSections(html)
    expect(sections).toHaveLength(3)
    expect(sections[0].heading).toBe('Title')
    expect(sections[1].heading).toBe('Section One')
    expect(sections[2].heading).toBe('Sub Section')
  })

  it('extractSections strips emoji from headings', () => {
    const html = '<h2>📊 Customer Intelligence Dashboard</h2>'
    const sections = extractSections(html)
    expect(sections[0].heading).toBe('Customer Intelligence Dashboard')
  })

  it('extractSections handles nested span tags', () => {
    const html = '<h2><span style="color:red">Target</span> <span>Contacts</span></h2>'
    const sections = extractSections(html)
    expect(sections[0].heading).toBe('Target Contacts')
  })

  it('checkContactTableColumns detects missing columns', () => {
    const html = '<table><tr><th>Name</th><th>Title</th></tr></table>'
    const missing = checkContactTableColumns(html)
    expect(missing).toContain('Email')
    expect(missing).toContain('LinkedIn')
    expect(missing).toContain('Signal')
  })

  it('checkContactTableColumns passes with all columns', () => {
    const html = '<table><tr><th>Name</th><th>Title</th><th>Email</th><th>LinkedIn</th><th>Signal</th></tr></table>'
    const missing = checkContactTableColumns(html)
    expect(missing).toHaveLength(0)
  })

  it('checkMetricBoxes detects missing metrics', () => {
    const html = '<div>Revenue</div>'
    const missing = checkMetricBoxes(html)
    expect(missing).toContain('Employees')
    expect(missing).not.toContain('Revenue')
  })

  it('checkGuardrailBadges detects missing badges', () => {
    const html = '<span>NEVER</span><span>SAFE</span>'
    const missing = checkGuardrailBadges(html)
    expect(missing).toContain('CAREFUL')
    expect(missing).not.toContain('NEVER')
    expect(missing).not.toContain('SAFE')
  })

  it('checkBrandColor counts occurrences', () => {
    const html = 'color: #c41e3a; border: #c41e3a; bg: #c41e3a;'
    expect(checkBrandColor(html)).toBe(3)
  })

  it('countEmailBoxes counts email emoji headers', () => {
    const html = '📧 Person A 📧 Person B 📧 Person C'
    expect(countEmailBoxes(html)).toBe(3)
  })

  it('structuralDiff returns mismatches for minimal HTML', () => {
    const minimal = '<html><body><h1>Test</h1></body></html>'
    const result = structuralDiff(minimal, fixtureText)
    expect(result.pass).toBe(false)
    expect(result.mismatches.length).toBeGreaterThan(0)
    expect(result.mismatches.some(m => m.type === 'missing-section')).toBe(true)
  })

  it('structuralDiff detects order mismatches', () => {
    const wrongOrder = `<html><body>
      <h2>Email Templates by Role</h2>
      <h2>Target Contacts</h2>
    </body></html>`
    const result = structuralDiff(wrongOrder, fixtureText)
    expect(result.mismatches.some(m => m.type === 'order-mismatch')).toBe(true)
  })
})

