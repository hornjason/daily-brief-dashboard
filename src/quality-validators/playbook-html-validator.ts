/**
 * Playbook HTML Quality Validator — GitHub Issue #313
 *
 * Validates playbook HTML output BEFORE Google Doc publishing.
 * Catches formatting issues that would only be visible after publishing:
 * - Raw markdown leaking through (**, ###, | table |)
 * - Empty sections
 * - Broken inline formatting (unclosed tags)
 * - Content too short (likely generation failure)
 * - Missing business value metrics in Expansion Opportunities
 * - Section completeness (all 11 sections present)
 *
 * Threshold: 75
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'playbook-html'
const PASS_THRESHOLD = 75

function validate(html: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Raw markdown detection — patterns that should have been converted to HTML
  const rawMarkdownPatterns = [
    /\*\*[^*]+\*\*/,           // **bold**
    /^#{1,6}\s+/m,             // ### headers
    /^\|[\s\w|]+\|$/m,         // | table | headers
    /^\|[-:\s|]+\|$/m,         // |---|---| separators
  ]

  const detectedMarkdown: string[] = []
  for (const pattern of rawMarkdownPatterns) {
    const match = html.match(pattern)
    if (match) {
      detectedMarkdown.push(match[0].slice(0, 20))
    }
  }

  checks.push({
    name: 'raw-markdown-detection',
    passed: detectedMarkdown.length === 0,
    expected: 'No raw markdown patterns in HTML output',
    actual: detectedMarkdown.length > 0
      ? `Found: ${detectedMarkdown.join(', ')}`
      : 'clean HTML',
    severity: 'required',
  })

  // 2. Empty sections — verify each <h2> has content before next heading
  const h2Matches = Array.from(html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi))
  let emptySections = 0

  for (let i = 0; i < h2Matches.length; i++) {
    const currentMatch = h2Matches[i]
    const nextMatch = h2Matches[i + 1]

    const sectionStart = currentMatch.index! + currentMatch[0].length
    const sectionEnd = nextMatch ? nextMatch.index! : html.length

    const sectionContent = html.slice(sectionStart, sectionEnd)
    // Strip HTML tags and check for actual text content
    const textContent = sectionContent.replace(/<[^>]+>/g, '').trim()

    if (textContent.length === 0) {
      emptySections++
    }
  }

  checks.push({
    name: 'empty-sections',
    passed: emptySections === 0,
    expected: 'All sections have content between headings',
    actual: emptySections > 0
      ? `${emptySections} empty section${emptySections > 1 ? 's' : ''} found`
      : 'all sections have content',
    severity: 'required',
  })

  // 3. Unclosed tags — detect unclosed <strong>, <em>, <a>
  const unclosedTags: string[] = []

  // Check <strong>
  const strongOpen = (html.match(/<strong[^>]*>/g) || []).length
  const strongClose = (html.match(/<\/strong>/g) || []).length
  if (strongOpen !== strongClose) {
    unclosedTags.push(`<strong>: ${strongOpen} open, ${strongClose} close`)
  }

  // Check <em>
  const emOpen = (html.match(/<em[^>]*>/g) || []).length
  const emClose = (html.match(/<\/em>/g) || []).length
  if (emOpen !== emClose) {
    unclosedTags.push(`<em>: ${emOpen} open, ${emClose} close`)
  }

  // Check <a>
  const aOpen = (html.match(/<a[^>]*>/g) || []).length
  const aClose = (html.match(/<\/a>/g) || []).length
  if (aOpen !== aClose) {
    unclosedTags.push(`<a>: ${aOpen} open, ${aClose} close`)
  }

  checks.push({
    name: 'unclosed-tags',
    passed: unclosedTags.length === 0,
    expected: 'All inline tags properly closed',
    actual: unclosedTags.length > 0
      ? `unclosed: ${unclosedTags.join('; ')}`
      : 'all tags closed',
    severity: 'required',
  })

  // 4. Content length — flag sections under 50 chars (likely generation failure)
  let shortSections = 0
  const MIN_SECTION_LENGTH = 50

  for (let i = 0; i < h2Matches.length; i++) {
    const currentMatch = h2Matches[i]
    const nextMatch = h2Matches[i + 1]

    const sectionStart = currentMatch.index! + currentMatch[0].length
    const sectionEnd = nextMatch ? nextMatch.index! : html.length

    const sectionContent = html.slice(sectionStart, sectionEnd)
    const textContent = sectionContent.replace(/<[^>]+>/g, '').trim()

    if (textContent.length > 0 && textContent.length < MIN_SECTION_LENGTH) {
      shortSections++
    }
  }

  checks.push({
    name: 'section-length',
    passed: shortSections === 0,
    expected: `All sections >= ${MIN_SECTION_LENGTH} chars`,
    actual: shortSections > 0
      ? `${shortSections} section${shortSections > 1 ? 's' : ''} under ${MIN_SECTION_LENGTH} chars`
      : `all sections sufficient`,
    severity: 'required',
  })

  // 5. Missing metrics — for Expansion Opportunities, verify "Business value:" exists
  const expansionSection = findSection(html, /10\.\s*Expansion Opportunities/i)
  if (expansionSection) {
    // Count product cards (divs with border-left styling - the card pattern)
    const productCards = (expansionSection.match(/<div[^>]+border-left:[^>]+>/g) || []).length
    const businessValueMentions = (expansionSection.match(/Business value:/gi) || []).length

    const hasAllBusinessValues = productCards === 0 || businessValueMentions >= productCards

    checks.push({
      name: 'expansion-business-value',
      passed: hasAllBusinessValues,
      expected: 'All expansion opportunity cards have "Business value:" metrics',
      actual: productCards > 0
        ? (hasAllBusinessValues
            ? `${businessValueMentions}/${productCards} cards have business value`
            : `missing: ${productCards - businessValueMentions}/${productCards} cards lack business value`)
        : 'no product cards found',
      severity: 'recommended',
    })
  } else {
    // Expansion Opportunities section not found — flag it
    checks.push({
      name: 'expansion-business-value',
      passed: false,
      expected: 'Expansion Opportunities section present',
      actual: 'section missing',
      severity: 'required',
    })
  }

  // 6. Section completeness — all 11 sections present
  const expectedSections = [
    /1\.\s*Strategic Position/i,
    /2\.\s*SWOT Analysis/i,
    /3\.\s*Key Relationships/i,
    /4\.\s*Current Priorities/i,
    /5\.\s*MEDDPICC Qualification/i,
    /6\.\s*Product Alignment/i,
    /7\.\s*Solution Plays/i,
    /8\.\s*Open Action Items/i,
    /9\.\s*Engagement History/i,
    /10\.\s*Expansion Opportunities/i,
    /11\.\s*Renewals and Risk/i,
  ]

  let sectionsFound = 0
  for (const pattern of expectedSections) {
    if (pattern.test(html)) {
      sectionsFound++
    }
  }

  checks.push({
    name: 'section-completeness',
    passed: sectionsFound === expectedSections.length,
    expected: '11 numbered sections present',
    actual: `${sectionsFound} of 11 sections found`,
    severity: 'required',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

// ── Helper ──────────────────────────────────────────────────────────────────

/** Extract content after a section header until next <h2> or end of document */
function findSection(html: string, headerPattern: RegExp): string | null {
  const h2Match = html.match(new RegExp(`<h2[^>]*>${headerPattern.source}.*?</h2>`, 'i'))
  if (!h2Match) return null

  const startIdx = h2Match.index! + h2Match[0].length
  const nextH2Pattern = /<h2[^>]*>/i
  const rest = html.slice(startIdx)
  const nextMatch = rest.match(nextH2Pattern)
  const endIdx = nextMatch ? startIdx + nextMatch.index! : html.length

  return html.slice(startIdx, endIdx)
}

export const playbookHtmlValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
