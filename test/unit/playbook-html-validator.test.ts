/**
 * Unit tests for playbook-html-validator.ts (GitHub Issue #313)
 * Tests HTML output quality checks for Google Doc publishing.
 */

import { describe, it, expect } from 'bun:test'
import { playbookHtmlValidator } from '../../src/quality-validators/playbook-html-validator.ts'

// ── Good HTML fixture (passing all checks) ──────────────────────────────────

const GOOD_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<h1>Customer Engagement Playbook: Acme Corp</h1>
<div class="subtitle"><strong>Generated:</strong> May 23, 2026</div>

<h2>1. Strategic Position</h2>
<p>Acme Corp is a $2.1B manufacturing company undergoing digital transformation. They recently completed a successful Kubernetes pilot with 50 containers and are evaluating enterprise-grade container platforms. Their VP of Infrastructure has publicly committed to hybrid cloud by 2027.</p>

<h2>2. SWOT Analysis</h2>
<p><strong>Strengths:</strong> Technical expertise demonstrated in Kubernetes pilot, executive commitment to modernization.</p>
<p><strong>Weaknesses:</strong> Limited experience with production-scale container management.</p>
<p><strong>Opportunities:</strong> Infrastructure refresh cycle provides timing for platform adoption.</p>
<p><strong>Threats:</strong> Competitors are also courting Acme during this evaluation cycle.</p>

<h2>3. Key Relationships</h2>
<p style="margin:2px 0;font-size:10pt"><strong>David Park</strong> · VP Infrastructure — Container strategy lead</p>
<p style="margin:2px 0;font-size:10pt"><strong>Jennifer Lee</strong> · VP Operations — Day 2 operations owner</p>

<h2>4. Current Priorities</h2>
<p>Primary focus is selecting an enterprise Kubernetes platform that meets compliance requirements for regulated manufacturing environments. Secondary priority is reducing operational overhead through automation.</p>

<h2>5. MEDDPICC Qualification</h2>
<p style="margin:8px 0"><strong>Qualification Score: 62%</strong> (5/8 confirmed)</p>
<div style="border:1px solid #e0e0e0;border-left:4px solid #3d7317;padding:10px 16px;margin:8px 0;border-radius:4px">
<p style="margin:0 0 4px 0"><strong>Metrics</strong> <span style="color:#3d7317;font-weight:bold;font-size:9pt">CONFIRMED</span></p>
<p style="margin:4px 0;font-size:10pt">3x deployment frequency improvement, 40-hour to 10-hour maintenance reduction target</p>
</div>

<h2>6. Product Alignment</h2>
<div style="border:1px solid #e0e0e0;border-left:4px solid #3d7317;padding:12px 16px;margin:6px 0;border-radius:4px">
<p style="margin:0 0 6px 0"><strong style="font-size:11pt">OpenShift Container Platform</strong> <span style="color:#3d7317;font-weight:bold;font-size:9pt">HIGH</span></p>
<p style="margin:4px 0;font-size:10pt">Enterprise Kubernetes for cloud-native applications with built-in security</p>
<p style="margin:8px 0 4px 0;font-weight:bold;font-size:9pt">Proof Points:</p>
<p style="margin:2px 0 2px 12px;font-size:9pt"><span style="color:#3d7317;font-weight:bold">45%</span> faster time to production deployment</p>
<p style="margin:2px 0 2px 12px;font-size:9pt"><span style="color:#3d7317;font-weight:bold">75%</span> reduction in security vulnerabilities</p>
<p style="margin:8px 0 0 0;font-size:9pt"><strong>Lifecycle:</strong> Evaluating</p>
</div>

<h2>7. Solution Plays</h2>
<div style="border:1px solid #e0e0e0;border-left:4px solid #3d7317;padding:12px 16px;margin:6px 0;border-radius:4px">
<p style="margin:0 0 6px 0"><strong style="font-size:11pt">Container Platform Modernization</strong> <span style="color:#3d7317;font-weight:bold;font-size:9pt">HIGH</span></p>
<p style="margin:4px 0;font-size:9pt"><strong>TDP:</strong> Cloud-Native Applications · <strong>Triggers:</strong> Kubernetes, Containers</p>
</div>

<h2>8. Open Action Items</h2>
<div style="border:1px solid #e0e0e0;border-left:4px solid #EE0000;padding:10px 16px;margin:8px 0;border-radius:4px">
<p style="margin:0 0 4px 0"><span style="color:#EE0000;font-weight:bold">○ OPEN</span></p>
<p style="margin:4px 0;font-size:10pt">Schedule technical deep dive with DevOps team</p>
<p style="margin:4px 0 0 0;font-size:8pt;color:#707070"><strong>Owner:</strong> Sarah Chen · <strong>Created:</strong> 5/20/2026</p>
</div>

<h2>9. Engagement History</h2>
<div style="border-left:3px solid #0066cc;padding:8px 16px;margin:8px 0">
<p style="margin:0;font-size:9pt;color:#707070"><strong>2026-05-15</strong> · <span style="color:#0066cc;font-weight:bold">MEETING</span></p>
<p style="margin:4px 0;font-size:10pt">Discovery call with VP Infrastructure</p>
</div>

<h2>10. Expansion Opportunities</h2>
<div style="border:1px solid #e0e0e0;border-left:4px solid #3d7317;padding:10px 16px;margin:8px 0;border-radius:4px">
<p style="margin:0 0 4px 0"><strong style="font-size:11pt">Ansible Automation Platform</strong> <span style="color:#3d7317;font-weight:bold;font-size:9pt">HIGH</span></p>
<p style="margin:4px 0;font-size:10pt">Automate Day 2 operations and reduce maintenance overhead.</p>
<p style="margin:6px 0 0 0;font-size:9pt"><strong style="color:#5f0000">Business value:</strong> $450K annual savings from reduced operational overhead</p>
</div>

<h2>11. Renewals and Risk</h2>
<p>No active renewals in current quarter. Primary risk is evaluation cycle extending beyond budget availability window in Q3.</p>

<div class="footer">Generated by PAI Intelligence — May 23, 2026</div>
</body>
</html>`

// ── Bad HTML fixtures (each fails a specific check) ────────────────────────

const HTML_WITH_RAW_MARKDOWN = `<!DOCTYPE html>
<html><body>
<h1>Customer Playbook: Acme Corp</h1>
<h2>1. Strategic Position</h2>
<p>Acme Corp is evaluating **OpenShift Container Platform** for their infrastructure.</p>
<h2>2. SWOT Analysis</h2>
<p>### Strengths</p>
<p>Strong technical team</p>
<h2>3. Key Relationships</h2>
<p>| Name | Role | Focus |</p>
<p>|------|------|-------|</p>
<p>| David Park | VP Infrastructure | Container strategy |</p>
</body></html>`

const HTML_WITH_EMPTY_SECTIONS = `<!DOCTYPE html>
<html><body>
<h1>Customer Playbook: Acme Corp</h1>
<h2>1. Strategic Position</h2>
<p>This is a good section with sufficient content for validation purposes.</p>
<h2>2. SWOT Analysis</h2>

<h2>3. Key Relationships</h2>
<p>Some content here</p>
<h2>4. Current Priorities</h2>
<p></p>
<h2>5. MEDDPICC Qualification</h2>
<p>Content here</p>
</body></html>`

const HTML_WITH_UNCLOSED_TAGS = `<!DOCTYPE html>
<html><body>
<h1>Customer Playbook: Acme Corp</h1>
<h2>1. Strategic Position</h2>
<p>This paragraph has <strong>bold text but no closing tag</p>
<h2>2. SWOT Analysis</h2>
<p>Another paragraph with <em>emphasis that is not closed</p>
<h2>3. Key Relationships</h2>
<p><a href="https://example.com">Link without closing tag</p>
</body></html>`

const HTML_WITH_SHORT_SECTIONS = `<!DOCTYPE html>
<html><body>
<h1>Customer Playbook: Acme Corp</h1>
<h2>1. Strategic Position</h2>
<p>Too short</p>
<h2>2. SWOT Analysis</h2>
<p>Also way too short for a real section</p>
<h2>3. Key Relationships</h2>
<p>Only 20 chars here.</p>
<h2>4. Current Priorities</h2>
<p>This section is good and has enough content to pass the minimum length requirement for validation.</p>
</body></html>`

const HTML_MISSING_BUSINESS_VALUE = `<!DOCTYPE html>
<html><body>
<h1>Customer Playbook: Acme Corp</h1>
<h2>10. Expansion Opportunities</h2>
<div style="border:1px solid #e0e0e0;border-left:4px solid #3d7317;padding:10px 16px;margin:8px 0;border-radius:4px">
<p style="margin:0 0 4px 0"><strong style="font-size:11pt">Ansible Automation Platform</strong> <span style="color:#3d7317;font-weight:bold;font-size:9pt">HIGH</span></p>
<p style="margin:4px 0;font-size:10pt">Automate Day 2 operations and reduce maintenance overhead.</p>
</div>
<div style="border:1px solid #e0e0e0;border-left:4px solid #3d7317;padding:10px 16px;margin:8px 0;border-radius:4px">
<p style="margin:0 0 4px 0"><strong style="font-size:11pt">Advanced Cluster Management</strong> <span style="color:#3d7317;font-weight:bold;font-size:9pt">MEDIUM</span></p>
<p style="margin:4px 0;font-size:10pt">Multi-cluster management solution.</p>
</div>
</body></html>`

const HTML_MISSING_SECTIONS = `<!DOCTYPE html>
<html><body>
<h1>Customer Playbook: Acme Corp</h1>
<h2>1. Strategic Position</h2>
<p>Content here with sufficient length for passing validation requirements.</p>
<h2>2. SWOT Analysis</h2>
<p>More content here that is also sufficiently long to pass validation.</p>
<h2>3. Key Relationships</h2>
<p>Additional content that meets the minimum length requirements for testing.</p>
<!-- Missing sections 4-11 -->
</body></html>`

// ── Tests ───────────────────────────────────────────────────────────────────

describe('playbookHtmlValidator', () => {
  it('passes clean HTML with all required sections and formatting', () => {
    const result = playbookHtmlValidator.validate(GOOD_HTML)

    expect(result.passed).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(playbookHtmlValidator.passThreshold)
    expect(result.failures.length).toBe(0)
  })

  it('detects raw markdown patterns (**, ###, | table |)', () => {
    const result = playbookHtmlValidator.validate(HTML_WITH_RAW_MARKDOWN)

    const markdownCheck = result.checks.find(c => c.name === 'raw-markdown-detection')
    expect(markdownCheck).toBeDefined()
    expect(markdownCheck?.passed).toBe(false)
    expect(markdownCheck?.actual).toContain('**')
  })

  it('detects empty sections between headings', () => {
    const result = playbookHtmlValidator.validate(HTML_WITH_EMPTY_SECTIONS)

    const emptyCheck = result.checks.find(c => c.name === 'empty-sections')
    expect(emptyCheck).toBeDefined()
    expect(emptyCheck?.passed).toBe(false)
    expect(emptyCheck?.actual).toMatch(/\d+ empty/)
  })

  it('detects unclosed HTML tags', () => {
    const result = playbookHtmlValidator.validate(HTML_WITH_UNCLOSED_TAGS)

    const unclosedCheck = result.checks.find(c => c.name === 'unclosed-tags')
    expect(unclosedCheck).toBeDefined()
    expect(unclosedCheck?.passed).toBe(false)
    expect(unclosedCheck?.actual).toMatch(/unclosed/)
  })

  it('flags sections with insufficient content length', () => {
    const result = playbookHtmlValidator.validate(HTML_WITH_SHORT_SECTIONS)

    const lengthCheck = result.checks.find(c => c.name === 'section-length')
    expect(lengthCheck).toBeDefined()
    expect(lengthCheck?.passed).toBe(false)
    expect(lengthCheck?.actual).toMatch(/\d+ sections? under/)
  })

  it('detects missing Business value in Expansion Opportunities', () => {
    const result = playbookHtmlValidator.validate(HTML_MISSING_BUSINESS_VALUE)

    const bizValueCheck = result.checks.find(c => c.name === 'expansion-business-value')
    expect(bizValueCheck).toBeDefined()
    expect(bizValueCheck?.passed).toBe(false)
    expect(bizValueCheck?.actual).toMatch(/missing/)
  })

  it('verifies all 11 sections are present', () => {
    const result = playbookHtmlValidator.validate(HTML_MISSING_SECTIONS)

    const completenessCheck = result.checks.find(c => c.name === 'section-completeness')
    expect(completenessCheck).toBeDefined()
    expect(completenessCheck?.passed).toBe(false)
    expect(completenessCheck?.actual).toMatch(/\d+ of 11/)
  })

  it('has correct contentType and threshold', () => {
    expect(playbookHtmlValidator.contentType).toBe('playbook-html')
    expect(playbookHtmlValidator.passThreshold).toBeGreaterThanOrEqual(70)
  })

  it('produces a QualityScorecard with required fields', () => {
    const result = playbookHtmlValidator.validate(GOOD_HTML)

    expect(result.contentType).toBe('playbook-html')
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.checks).toBeDefined()
    expect(result.failures).toBeDefined()
    expect(result.timestamp).toBeDefined()
    expect(typeof result.passed).toBe('boolean')
  })
})
