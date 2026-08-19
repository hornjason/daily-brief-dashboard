/**
 * Campaign Pipeline Data Contract Assertions
 *
 * Runtime assertions at each pipeline stage boundary.
 * Catch wiring failures where data is captured but not passed to next stage.
 *
 * Behavior:
 * - Production/dev: console.warn() on contract violation (never throw)
 * - Test (NODE_ENV=test): throw with descriptive error
 *
 * Issue #1141
 */

const DENY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\$\d[\d,.]*[kKmMbB]?\s+(?:pipeline|deal)/i, label: 'pipeline dollar amounts' },
  { pattern: /pipeline\s+(?:opportunit|value)/i, label: 'pipeline opportunity/value language' },
  { pattern: /pending\s+\$/i, label: 'pending dollar references' },
  { pattern: /support\s+(?:case|ticket)/i, label: 'support case/ticket references' },
  { pattern: /(?:case|ticket)\s+#\d/i, label: 'case/ticket number references' },
  { pattern: /\d+\s+(?:RHEL\s+)?subscriptions?\b/i, label: 'subscription count disclosure' },
  { pattern: /subscription\s+count/i, label: 'subscription count language' },
  { pattern: /\d+\s+(?:nodes?|instances?)\b/i, label: 'node/instance count disclosure' },
  { pattern: /\b[A-Z]{2,4}\d{4,6}\b/, label: 'SKU codes' },
  { pattern: /laid\s+off\s+\d|headcount\s+reduction|workforce\s+reduction/i, label: 'layoff language' },
  { pattern: /\$\d[\d,.]*[kKmMbB]?\s+renewal|renewal\s+of\s+\$/i, label: 'renewal dollar amounts' },
  { pattern: /NN-\d+\s*—\s*Pipeline/i, label: 'internal footprint prefix' },
  { pattern: /Company\s+intelligence/i, label: 'internal system name' },
  { pattern: /(?:^|\s)Red\s+Hat\b.*?\bthreat\b/im, label: 'Red Hat as threat' },
  { pattern: /Initiative\s*—\s*Description/i, label: 'raw table headers' },
]

const IS_TEST = process.env.NODE_ENV === 'test'

/**
 * Contract helper: logs warning in production, throws in test
 */
function contractViolation(boundary: string, message: string): void {
  const errorMsg = `[${boundary}] Contract violation: ${message}`
  if (IS_TEST) {
    throw new Error(errorMsg)
  } else {
    console.warn(errorMsg)
  }
}

/**
 * Boundary: Material Extraction → Pass 0
 *
 * Validates that material content was successfully extracted and is ready for Pass 0.
 *
 * @param data - Extracted material content and title
 */
export function assertExtractionOutput(data: { materialContent: string; materialTitle: string }): void {
  const boundary = 'Extraction → Pass 0'

  if (!data.materialContent || data.materialContent.length === 0) {
    contractViolation(boundary, 'materialContent is empty — Pass 0 will have no content to analyze')
    return
  }

  if (!data.materialTitle || data.materialTitle.trim().length === 0) {
    contractViolation(boundary, 'materialTitle is empty — campaign will have no title')
    return
  }

  // Check for common extraction artifacts that indicate poor quality
  const hasEmailPrefixes = /^(RE:|FW:|Fwd:)/i.test(data.materialTitle)
  if (hasEmailPrefixes) {
    contractViolation(boundary, `materialTitle contains email prefix artifacts: "${data.materialTitle}" — should be cleaned before this boundary`)
  }
}

/**
 * Boundary: Unified Selection → Pass 2
 *
 * Validates that the unified selection produced persona entries with all required
 * fields for template assembly: role, suggestedTitle, recipientName, subject,
 * signalIndex, featureKeys, and count matching.
 *
 * @param result - Unified selection result
 * @param expectedContactCount - Number of resolved contacts (for persona count validation)
 */
export function assertUnifiedSelectionOutput(
  result: {
    personas: Array<{
      role: string
      suggestedTitle: string
      recipientName: string
      subject: string
      signalIndex: number
      featureKeys: string[]
      tier?: string
      intent?: string
    }>
  },
  expectedContactCount: number,
): void {
  const boundary = 'Unified Selection → Pass 2'

  if (!result.personas || result.personas.length === 0) {
    contractViolation(boundary, `No personas in unified selection output — Pass 2 has nothing to assemble`)
    return
  }

  if (result.personas.length < 3) {
    contractViolation(boundary, `Expected at least 3 personas, got ${result.personas.length}`)
  }

  if (result.personas.length !== expectedContactCount) {
    contractViolation(boundary, `Persona count mismatch: ${result.personas.length} personas for ${expectedContactCount} contacts — should be 1:1`)
  }

  for (let i = 0; i < result.personas.length; i++) {
    const persona = result.personas[i]

    if (!persona.role || persona.role.trim().length === 0) {
      contractViolation(boundary, `Persona ${i} missing role — template needs role for personalization`)
    }

    if (!persona.suggestedTitle || persona.suggestedTitle.trim().length === 0) {
      contractViolation(boundary, `Persona ${i} missing suggestedTitle — email personalization needs title`)
    }

    if (!persona.recipientName || persona.recipientName.trim().length === 0) {
      contractViolation(boundary, `Persona ${i} missing recipientName — template needs recipient to personalize`)
    }

    if (!persona.subject || persona.subject.trim().length === 0) {
      contractViolation(boundary, `Persona ${i} missing subject — template needs subject line`)
    }

    if (typeof persona.signalIndex !== 'number' || persona.signalIndex < 0) {
      contractViolation(boundary, `Persona ${i} has invalid signalIndex: ${persona.signalIndex} — template needs valid signal reference`)
    }

    if (!persona.featureKeys || persona.featureKeys.length !== 3) {
      contractViolation(boundary, `Persona ${i} has ${persona.featureKeys?.length ?? 0} featureKeys, expected exactly 3 — template needs 3 feature bullets`)
    }
  }
}

/**
 * Boundary: Executive Resolution → Pass 1
 *
 * Validates that executive resolution produced sufficient contacts with required fields
 * and proper tier distribution.
 *
 * @param execs - Resolved executive contacts
 */
export function assertExecResolutionOutput(execs: Array<{ name: string; title: string; email?: string; linkedinUrl?: string }>): void {
  const boundary = 'Exec Resolution → Pass 1'

  if (!execs || execs.length < 6) {
    contractViolation(boundary, `Expected at least 6 resolved contacts, got ${execs?.length ?? 0} — Pass 1 needs contacts to generate emails for`)
    return
  }

  // Check each exec has required fields
  for (let i = 0; i < execs.length; i++) {
    const exec = execs[i]

    if (!exec.name || exec.name.trim().length === 0) {
      contractViolation(boundary, `Contact ${i} missing name — emails need recipient names`)
    }

    if (!exec.title || exec.title.trim().length === 0) {
      contractViolation(boundary, `Contact ${i} missing title — email personalization needs titles`)
    }
  }

  // Check tier distribution (both executive and manager tiers should be present)
  const classifyTier = (title: string): 'executive' | 'manager' => {
    const titleLower = title.toLowerCase()
    if (/\b(ceo|cfo|cto|cio|ciso|chief|c-level)\b/i.test(titleLower)) return 'executive'
    if (/\bvp\b|vice president/i.test(titleLower)) return 'executive'
    return 'manager'
  }

  const execTier = execs.filter(e => classifyTier(e.title) === 'executive')
  const managerTier = execs.filter(e => classifyTier(e.title) === 'manager')

  if (execTier.length === 0) {
    contractViolation(boundary, `No executive-tier contacts found — campaign needs both executive and manager personas`)
  }

  if (managerTier.length === 0) {
    contractViolation(boundary, `No manager-tier contacts found — campaign needs both executive and manager personas`)
  }
}


/**
 * Boundary: Pass 2 (Template Assembly) → Drive Upload
 *
 * Validates that Pass 2 generated complete HTML with all expected sections
 * and no internal data leaks.
 *
 * @param html - Generated campaign HTML
 */
export function assertPass2Output(html: string): void {
  const boundary = 'Pass 2 → Drive'

  if (!html || html.trim().length === 0) {
    contractViolation(boundary, `HTML output is empty — nothing to upload to Drive`)
    return
  }

  // Check for expected section headers (based on spec §1-11)
  const expectedSections = [
    'Target Contacts',
    'Generation Config',
    'Quality Checklist',
    'Intelligence Dashboard',
    'Email Templates',
  ]

  for (const section of expectedSections) {
    if (!html.includes(section)) {
      contractViolation(boundary, `Missing expected section: "${section}" — output may be incomplete`)
    }
  }

  // Check for DENY_PATTERNS (internal data leaks)
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const violations: string[] = []

  for (const { pattern, label } of DENY_PATTERNS) {
    const match = plainText.match(pattern)
    if (match) {
      violations.push(`${label}: "${match[0]}"`)
    }
  }

  if (violations.length > 0) {
    contractViolation(
      boundary,
      `Found ${violations.length} DENY_PATTERN violations (internal data leaks): ${violations.join(', ')} — output contains internal data that should not reach customers`,
    )
  }
}
