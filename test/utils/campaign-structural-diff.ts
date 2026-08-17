/**
 * Structural diff utility for campaign HTML.
 * Compares generated campaign HTML against the gold standard fixture.
 * Checks structure (sections, order, layout) — NOT content (names, numbers).
 *
 * GitHub Issue #1053
 */

export interface SectionInfo {
  heading: string
  index: number
}

export interface StructuralMismatch {
  type: 'missing-section' | 'extra-section' | 'order-mismatch' | 'missing-contact-column' | 'missing-metric-box' | 'missing-guardrail-badge' | 'missing-color' | 'missing-email-box' | 'section-count-mismatch'
  detail: string
}

export interface StructuralDiffResult {
  mismatches: StructuralMismatch[]
  fixtureSections: SectionInfo[]
  generatedSections: SectionInfo[]
  pass: boolean
}

const GOLD_STANDARD_SECTIONS = [
  'Target Contacts',
  'Generation Config',
  'Email Quality Checklist',
  'Customer Intelligence Dashboard',
  'Why .+ Is a Strong Fit',
  'Strategic Initiatives',
  'Competitive Position',
  'SB 122 Reference Material',
  'SB 122 Eligibility',
  'Existing Red Hat Footprint',
  'Outreach Guardrails',
  'Call Prep — Key Talking Points',
  'Email Templates by Role',
  'Manager Outreach',
]

const CONTACT_TABLE_COLUMNS = ['Name', 'Title', 'Email', 'LinkedIn', 'Signal']
const GUARDRAIL_BADGES = ['NEVER', 'CAREFUL', 'SAFE']
const BRAND_COLOR = '#c41e3a'

/**
 * Extract section headings from HTML by finding heading tags (h1-h3)
 * and styled section headers (uppercase letter-spacing pattern).
 */
export function extractSections(html: string): SectionInfo[] {
  const sections: SectionInfo[] = []
  const headingRegex = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi
  let match
  while ((match = headingRegex.exec(html)) !== null) {
    const text = match[2].replace(/<[^>]+>/g, '').replace(/[\u{1F300}-\u{1FAF6}]/gu, '').trim()
    if (text.length > 0) {
      sections.push({ heading: text, index: match.index })
    }
  }
  return sections
}

/**
 * Extract section headings from the gold standard text file.
 * Sections are identified by emoji prefixes, horizontal rules, or bold text patterns.
 */
export function extractSectionsFromText(text: string): SectionInfo[] {
  const sections: SectionInfo[] = []
  const lines = text.split('\n')
  const sectionPatterns = [
    /Target Contacts/,
    /Generation Config/,
    /Email Quality Checklist/,
    /Customer Intelligence Dashboard/,
    /Why .+ Is a Strong Fit/,
    /Strategic Initiatives/,
    /Competitive Position/,
    /SB 122 Reference Material/,
    /SB 122 Eligibility/,
    /Existing Red Hat Footprint/,
    /Outreach Guardrails/,
    /Call Prep — Key Talking Points/,
    /Email Templates by Role/,
    /Manager Outreach/,
  ]

  let charOffset = 0
  for (const line of lines) {
    for (const pattern of sectionPatterns) {
      if (pattern.test(line)) {
        const heading = line.replace(/^[^\w]*/, '').trim()
        if (!sections.some(s => s.heading === heading)) {
          sections.push({ heading, index: charOffset })
        }
      }
    }
    charOffset += line.length + 1
  }
  return sections
}

/**
 * Check if HTML contains contact table with required columns.
 */
export function checkContactTableColumns(html: string): string[] {
  const missing: string[] = []
  for (const col of CONTACT_TABLE_COLUMNS) {
    const pattern = new RegExp(`<t[dh][^>]*>[^<]*${col}[^<]*</t[dh]>`, 'i')
    if (!pattern.test(html)) {
      missing.push(col)
    }
  }
  return missing
}

/**
 * Check if HTML contains metric boxes (revenue, employees, product instances).
 */
export function checkMetricBoxes(html: string): string[] {
  const missing: string[] = []
  const expectedLabels = ['Revenue', 'Employees']
  for (const label of expectedLabels) {
    if (!html.includes(label)) {
      missing.push(label)
    }
  }
  return missing
}

/**
 * Check if HTML contains email template boxes with subject lines and body content.
 * Returns count of email boxes found.
 */
export function countEmailBoxes(html: string): number {
  const emailHeaderPattern = /📧/g
  const matches = html.match(emailHeaderPattern)
  return matches ? matches.length : 0
}

/**
 * Check guardrail badges (NEVER, CAREFUL, SAFE).
 */
export function checkGuardrailBadges(html: string): string[] {
  const missing: string[] = []
  for (const badge of GUARDRAIL_BADGES) {
    if (!html.includes(badge)) {
      missing.push(badge)
    }
  }
  return missing
}

/**
 * Check for brand color usage.
 */
export function checkBrandColor(html: string): number {
  const matches = html.match(new RegExp(BRAND_COLOR, 'gi'))
  return matches ? matches.length : 0
}

/**
 * Run full structural diff between generated HTML and the gold standard fixture.
 */
export function structuralDiff(generatedHtml: string, fixtureText: string): StructuralDiffResult {
  const mismatches: StructuralMismatch[] = []
  const generatedSections = extractSections(generatedHtml)
  const fixtureSections = extractSectionsFromText(fixtureText)

  // Check section presence
  for (const pattern of GOLD_STANDARD_SECTIONS) {
    const regex = new RegExp(pattern, 'i')
    const inFixture = fixtureSections.some(s => regex.test(s.heading))
    const inGenerated = generatedSections.some(s => regex.test(s.heading))

    if (inFixture && !inGenerated) {
      mismatches.push({
        type: 'missing-section',
        detail: `Section "${pattern}" present in fixture but missing from generated HTML`,
      })
    }
  }

  // Check for extra sections in generated that aren't in fixture
  for (const gen of generatedSections) {
    const matchesAny = GOLD_STANDARD_SECTIONS.some(p => new RegExp(p, 'i').test(gen.heading))
    if (!matchesAny) {
      const isKnownExtra = /Content Campaign|Positioning|Source/i.test(gen.heading)
      if (!isKnownExtra) {
        mismatches.push({
          type: 'extra-section',
          detail: `Section "${gen.heading}" in generated HTML has no fixture counterpart`,
        })
      }
    }
  }

  // Check section order — for sections present in both, verify relative ordering
  const fixtureOrder = GOLD_STANDARD_SECTIONS
    .filter(p => {
      const regex = new RegExp(p, 'i')
      return generatedSections.some(s => regex.test(s.heading))
    })
  for (let i = 0; i < fixtureOrder.length - 1; i++) {
    const regexA = new RegExp(fixtureOrder[i], 'i')
    const regexB = new RegExp(fixtureOrder[i + 1], 'i')
    const posA = generatedSections.findIndex(s => regexA.test(s.heading))
    const posB = generatedSections.findIndex(s => regexB.test(s.heading))
    if (posA >= 0 && posB >= 0 && posA > posB) {
      mismatches.push({
        type: 'order-mismatch',
        detail: `"${fixtureOrder[i]}" appears after "${fixtureOrder[i + 1]}" in generated HTML (should be before)`,
      })
    }
  }

  // Check contact table columns
  const missingCols = checkContactTableColumns(generatedHtml)
  for (const col of missingCols) {
    mismatches.push({
      type: 'missing-contact-column',
      detail: `Contact table missing column: "${col}"`,
    })
  }

  // Check metric boxes
  const missingMetrics = checkMetricBoxes(generatedHtml)
  for (const metric of missingMetrics) {
    mismatches.push({
      type: 'missing-metric-box',
      detail: `Missing metric box: "${metric}"`,
    })
  }

  // Check email boxes — gold standard has 6 (3 exec + 3 manager)
  const emailCount = countEmailBoxes(generatedHtml)
  if (emailCount < 6) {
    mismatches.push({
      type: 'missing-email-box',
      detail: `Expected 6 email boxes (3 exec + 3 manager), found ${emailCount}`,
    })
  }

  // Check guardrail badges
  const missingBadges = checkGuardrailBadges(generatedHtml)
  for (const badge of missingBadges) {
    mismatches.push({
      type: 'missing-guardrail-badge',
      detail: `Missing guardrail badge: "${badge}"`,
    })
  }

  // Check brand color usage
  const colorCount = checkBrandColor(generatedHtml)
  if (colorCount < 5) {
    mismatches.push({
      type: 'missing-color',
      detail: `Brand color ${BRAND_COLOR} used only ${colorCount} times (expected 5+)`,
    })
  }

  return {
    mismatches,
    fixtureSections,
    generatedSections,
    pass: mismatches.length === 0,
  }
}
