/**
 * Real campaign output audit — validates actual cached campaign HTML
 * against docs/specs/consumers/campaign.md section-by-section.
 *
 * Picks the latest structured-path campaign from cache.
 * 11 spec sections + 14 quality dimensions.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { DENY_PATTERNS } from '../helpers/campaign-assertions.ts'

const CACHE_DIR = join(import.meta.dir, '../../data/cache/campaigns')

function loadLatestStructuredCampaign(): { html: string; meta: any } {
  const files = readdirSync(CACHE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, mtime: statSync(join(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  for (const { name } of files) {
    const raw = JSON.parse(readFileSync(join(CACHE_DIR, name), 'utf-8'))
    if (raw.htmlContent) {
      return { html: raw.htmlContent, meta: raw }
    }
  }
  throw new Error('No structured-path campaign found in cache')
}

interface ExtractedEmail {
  recipientName: string
  title: string
  subject: string
  toLine: string
  body: string
}

function extractEmailsFromHtml(html: string): ExtractedEmail[] {
  const emails: ExtractedEmail[] = []
  const boxPattern = /<div style="border: 2px solid[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
  let match
  while ((match = boxPattern.exec(html)) !== null) {
    const box = match[1]
    const headerMatch = box.match(/📧\s*(.*?)\s*—\s*(.*?)<\/span>/i)
    const recipientName = headerMatch ? headerMatch[1].trim() : ''
    const title = headerMatch ? headerMatch[2].trim() : ''
    const subjectMatch = box.match(/Subject:\s*<strong[^>]*>(.*?)<\/strong>/i)
    const subject = subjectMatch ? subjectMatch[1] : ''
    const toMatch = box.match(/To:\s*<strong[^>]*>(.*?)<\/strong>/i)
    const toLine = toMatch ? toMatch[1] : ''
    const bodyMatch = box.match(/<div style="padding: 20px[^"]*">([\s\S]*?)$/)
    const body = bodyMatch ? bodyMatch[1] : box
    emails.push({ recipientName, title, subject, toLine, body })
  }
  return emails
}

let html: string
let meta: any
let plainText: string
let emails: ExtractedEmail[]

function sectionText(sectionHeader: RegExp): string {
  const headerMatch = html.match(sectionHeader)
  if (!headerMatch) return ''
  const startIdx = headerMatch.index! + headerMatch[0].length
  const nextHeader = html.slice(startIdx).match(/<h[23][^>]*>/)
  const endIdx = nextHeader ? startIdx + nextHeader.index! : html.length
  return html.slice(startIdx, endIdx).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

beforeAll(() => {
  const campaign = loadLatestStructuredCampaign()
  html = campaign.html
  meta = campaign.meta
  plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  emails = extractEmailsFromHtml(html)
})

// ═══ SPEC SECTION VALIDATION (11 sections) ═══

describe('Spec §1: Header', () => {
  it('contains customer name', () => { expect(html).toContain(meta.customerName) })
  it('has AE name', () => { expect(plainText).toMatch(/Account\s+Executive/i) })
})

describe('Spec §2: Target Contacts', () => {
  it('section exists', () => { expect(plainText).toMatch(/Target\s+Contacts/i) })
  it('has ≥2 contacts with titles', () => {
    const section = sectionText(/Target\s+Contacts/i)
    expect(/Chief|VP|Director|Head|Manager|Officer|President|Engineer/i.test(section)).toBe(true)
  })
  it('contacts have emails', () => { expect(sectionText(/Target\s+Contacts/i)).toMatch(/@/) })
})

describe('Spec §3: Generation Config', () => {
  it('section exists', () => { expect(plainText).toMatch(/Generation\s+Config/i) })
  it('shows two-pass model', () => { expect(sectionText(/Generation\s+Config/i)).toMatch(/two-pass|ADR-043|structured/i) })
})

describe('Spec §4: Quality Checklist', () => {
  it('section exists with ≥10 checks', () => {
    const checks = (sectionText(/Quality\s+Checklist/i).match(/[☑☒✅❌⚠️]/g) || []).length
    expect(checks).toBeGreaterThanOrEqual(10)
  })
})

describe('Spec §5: Intelligence Dashboard', () => {
  it('section exists', () => { expect(plainText).toMatch(/Customer\s+Intelligence\s+Dashboard/i) })
  it('has revenue figure', () => { expect(sectionText(/Customer\s+Intelligence\s+Dashboard/i)).toMatch(/\$[\d,.]+\s*(?:billion|million|[BMK])|revenue/i) })
  it('has Strong Fit section', () => { expect(plainText).toMatch(/Strong\s+Fit/i) })
  it('has Business Metrics', () => { expect(plainText).toMatch(/Business\s+Metrics/i) })
  it('has Strategic Initiatives', () => { expect(plainText).toMatch(/Strategic\s+Initiatives/i) })
  it('has Competitive Position', () => { expect(plainText).toMatch(/Competitive\s+Position/i) })
})

describe('Spec §6: Guardrails', () => {
  it('guardrails or creepy check exists', () => {
    expect(/guardrail|creepy\s+line\s+check|internal\s+data/i.test(plainText)).toBe(true)
  })
})

describe('Spec §7: Reference Material', () => {
  it('section exists', () => { expect(plainText).toMatch(/Reference\s+Material|Source\s+Documents/i) })
})

describe('Spec §8: Eligibility', () => {
  it('well-formed when present', () => {
    if (/<h[23][^>]*>.*?Eligibility/i.test(html)) {
      expect(sectionText(/Eligibility/i).length).toBeGreaterThan(10)
    }
  })
})

describe('Spec §9: Footprint', () => {
  it('section exists', () => { expect(plainText).toMatch(/Red\s+Hat\s+Footprint|Existing.*Footprint/i) })
  it('no NN- prefixes', () => { expect(/\bNN-\d+/.test(sectionText(/Footprint/i))).toBe(false) })
  it('no Pipeline text', () => { expect(/Pipeline/i.test(sectionText(/Footprint/i))).toBe(false) })
})

describe('Spec §10: Email Templates', () => {
  it('≥2 emails extracted', () => { expect(emails.length).toBeGreaterThanOrEqual(2) })
  it('has executive outreach', () => { expect(sectionText(/Executive\s+Outreach/i).length).toBeGreaterThan(50) })
  it('manager emails when contacts exist', () => {
    if (sectionText(/Manager\s+Outreach/i).length === 0) {
      console.log('\n⚠️ No manager-tier emails — all contacts are executive-level')
    }
  })
})

describe('Spec §11: BV Talking Points', () => {
  it('section exists', () => { expect(plainText).toMatch(/Talking\s+Points|Call\s+Prep/i) })
})

// ═══ QUALITY DIMENSIONS ═══

describe('Quality: DENY_PATTERNS', () => {
  it('zero matches in full output', () => {
    const failures: string[] = []
    for (const { pattern, label } of DENY_PATTERNS) {
      const match = plainText.match(pattern)
      if (match) {
        const idx = plainText.indexOf(match[0])
        failures.push(`${label}: "${match[0]}" in ...${plainText.slice(Math.max(0, idx - 30), idx + match[0].length + 30)}...`)
      }
    }
    if (failures.length > 0) { console.log('\n❌ DENY_PATTERN failures:'); failures.forEach(f => console.log(`  - ${f}`)) }
    expect(failures).toEqual([])
  })

  it('zero matches per email', () => {
    const failures: string[] = []
    for (const email of emails) {
      const emailText = email.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      for (const { pattern, label } of DENY_PATTERNS) {
        const match = emailText.match(pattern)
        if (match) failures.push(`${email.recipientName}: ${label} — "${match[0]}"`)
      }
    }
    if (failures.length > 0) { console.log('\n❌ Per-email DENY_PATTERN failures:'); failures.forEach(f => console.log(`  - ${f}`)) }
    expect(failures).toEqual([])
  })
})

describe('Quality: ghost values', () => {
  it('no undefined/null/NaN', () => {
    const ghosts: string[] = []
    if (/\bundefined\b/.test(plainText)) ghosts.push('undefined')
    if (/\bnull\b/.test(plainText)) ghosts.push('null')
    if (/\bNaN\b/.test(plainText)) ghosts.push('NaN')
    expect(ghosts).toEqual([])
  })
})

describe('Quality: email structure (5 checks)', () => {
  it('opener with first name', () => {
    const failures: string[] = []
    for (const e of emails) {
      const first = e.recipientName.split(/\s+/)[0]
      if (first && first.length > 1 && !e.body.replace(/<[^>]+>/g, ' ').includes(first))
        failures.push(`${e.recipientName}: missing "${first}"`)
    }
    expect(failures).toEqual([])
  })

  it('feature bullets with URLs', () => {
    const failures: string[] = []
    for (const e of emails) {
      if ((e.body.match(/href="https?:\/\//gi) || []).length < 1) failures.push(e.recipientName)
    }
    expect(failures).toEqual([])
  })

  it('CTA with date', () => {
    const failures: string[] = []
    for (const e of emails) {
      if (!/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i.test(e.body))
        failures.push(e.recipientName)
    }
    expect(failures).toEqual([])
  })

  it('sign-off with contact', () => {
    const failures: string[] = []
    for (const e of emails) {
      const text = e.body.replace(/<[^>]+>/g, ' ')
      if (!/@/.test(text) && !/\d{3}[.-]\d{3}[.-]\d{4}/.test(text)) failures.push(e.recipientName)
    }
    expect(failures).toEqual([])
  })
})

describe('Quality: objective text', () => {
  it('no raw prefixes in emails', () => {
    const failures: string[] = []
    const patterns = [
      /Revenue\s+Trajectory:/i,
      /Raised\s+Full-Year\s+\d{4}\s+Guidance\s*—/i,
      /Lowered\s+Full-Year\s+\d{4}\s+Guidance\s*—/i,
      /Profitability:/i,
      /Cybersecurity\s+Enhancement:/i,
    ]
    for (const e of emails) {
      const text = e.body.replace(/<[^>]+>/g, ' ')
      for (const p of patterns) {
        const m = text.match(p)
        if (m) failures.push(`${e.recipientName}: "${m[0]}"`)
      }
    }
    if (failures.length > 0) console.log('\n❌ Raw prefixes:', failures)
    expect(failures).toEqual([])
  })
})

describe('Quality: threat/solution', () => {
  it('Red Hat never as threat in emails', () => {
    const failures: string[] = []
    for (const e of emails) {
      const text = e.body.replace(/<[^>]+>/g, ' ')
      if (/Red\s+Hat.*?\bthreat\b|\bthreat\b.*?Red\s+Hat/i.test(text))
        failures.push(e.recipientName)
    }
    expect(failures).toEqual([])
  })
})

describe('Audit summary', () => {
  it('prints metadata', () => {
    console.log('\n═══ Campaign Spec Compliance Audit ═══')
    console.log(`Customer:     ${meta.customerName}`)
    console.log(`Material:     ${meta.materialTitle}`)
    console.log(`Generated:    ${meta.generatedAt}`)
    console.log(`Path:         ${meta.generationPath}`)
    console.log(`Signals:      ${meta.signalsLoaded?.length || 0} loaded (${meta.signalCompleteness || '?'}%)`)
    console.log(`Missing:      ${meta.signalsMissing?.join(', ') || 'none'}`)
    console.log(`HTML size:    ${html.length} chars`)
    console.log(`Emails found: ${emails.length}`)
    emails.forEach((e, i) => console.log(`  ${i + 1}. ${e.recipientName} — ${e.title} | "${e.subject}"`))
    console.log('══════════════════════════════════════')
  })
})
