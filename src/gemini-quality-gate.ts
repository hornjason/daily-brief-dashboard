/**
 * Gemini Output Quality Gate — ADR-024
 *
 * Middleware pattern: validateAndRetry() wraps any generation function.
 * Does NOT modify callGemini() or gemini-call.ts.
 *
 * Validates output against domain-specific validators, retries with
 * structured feedback on failure, returns best-scoring attempt.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** A single quality check result */
export interface QualityCheck {
  name: string          // e.g., 'revenue-populated', 'positioning-count'
  passed: boolean
  expected: string      // human-readable: "revenue field non-empty"
  actual: string        // human-readable: "revenue: ''"
  severity: 'required' | 'recommended'
}

/** Scorecard produced by a validator */
export interface QualityScorecard {
  contentType: string   // 'campaign' | 'meeting-prep' | 'intelligence' | 'account-plan'
  score: number         // 0-100, percentage of checks passed
  checks: QualityCheck[]
  failures: QualityCheck[]  // convenience: checks.filter(c => !c.passed)
  passThreshold: number     // the threshold used (e.g., 80)
  passed: boolean           // score >= passThreshold
  timestamp: string
  attempt: number       // 1-based attempt number
}

/** Interface that each content type implements */
export interface QualityValidator {
  contentType: string
  passThreshold: number   // 0-100
  validate(output: string): QualityScorecard
}

/** Result from validateAndRetry */
export interface QualityGateResult {
  output: string                 // best output (highest-scoring attempt)
  scorecard: QualityScorecard    // scorecard for the returned output
  attempts: number               // total attempts made (1 = passed first try)
  retriesExhausted: boolean      // true if max retries hit without passing
}

/** Options for the quality gate */
export interface QualityGateOptions {
  maxRetries?: number    // default: 2
  validator: QualityValidator
}

// ── Core loop ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2

/**
 * Validate output and retry with error feedback if quality is below threshold.
 *
 * @param initialOutput - The raw Gemini output text from the first generation
 * @param options       - Validator and retry config
 * @param retryFn       - Called with failure descriptions; must return a new Gemini output.
 *                        The caller owns prompt construction and Gemini invocation.
 *                        Receives: (failures: QualityCheck[], attempt: number) => Promise<string>
 */
export async function validateAndRetry(
  initialOutput: string,
  options: QualityGateOptions,
  retryFn: (failures: QualityCheck[], attempt: number) => Promise<string>
): Promise<QualityGateResult> {
  const { validator } = options
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const maxAttempts = maxRetries + 1 // first try + retries

  let bestOutput = initialOutput
  let bestScorecard: QualityScorecard | null = null
  let bestScore = -1

  let currentOutput = initialOutput

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const scorecard = validator.validate(currentOutput)
    // Override attempt number to track which try this was
    scorecard.attempt = attempt

    console.log(
      `[quality-gate:${validator.contentType}] attempt ${attempt}/${maxAttempts}, score ${scorecard.score}/${scorecard.passThreshold}`
    )

    // Track best attempt
    if (scorecard.score > bestScore) {
      bestScore = scorecard.score
      bestScorecard = scorecard
      bestOutput = currentOutput
    }

    // Pass — return immediately
    if (scorecard.passed) {
      return {
        output: currentOutput,
        scorecard,
        attempts: attempt,
        retriesExhausted: false,
      }
    }

    // Fail but retries remain — call retryFn
    if (attempt < maxAttempts) {
      try {
        currentOutput = await retryFn(scorecard.failures, attempt + 1)
      } catch (err: any) {
        console.warn(
          `[quality-gate:${validator.contentType}] retryFn failed on attempt ${attempt + 1}: ${err?.message ?? err}`
        )
        // retryFn failure — stop retrying, return best so far
        break
      }
    }
  }

  // All attempts exhausted (or retryFn failed) — return best
  return {
    output: bestOutput,
    scorecard: bestScorecard!,
    attempts: Math.min(maxAttempts, bestScorecard!.attempt + (bestScorecard!.passed ? 0 : maxRetries)),
    retriesExhausted: true,
  }
}

// ── Helpers for validators ──────────────────────────────────────────────────

/** Build a scorecard from a list of checks */
export function buildScorecard(
  contentType: string,
  passThreshold: number,
  checks: QualityCheck[]
): QualityScorecard {
  const passed = checks.filter(c => c.passed).length
  const total = checks.length
  const score = total > 0 ? Math.round((passed / total) * 100) : 0
  const failures = checks.filter(c => !c.passed)

  return {
    contentType,
    score,
    checks,
    failures,
    passThreshold,
    passed: score >= passThreshold,
    timestamp: new Date().toISOString(),
    attempt: 1, // overridden by validateAndRetry
  }
}

/** Count rows in a pipe-delimited markdown table (excludes header + separator) */
export function countTableRows(tableText: string): number {
  const lines = tableText.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'))
  // First line = header, second line = separator (|---|---|), rest = data rows
  if (lines.length <= 2) return 0
  return lines.length - 2
}

/** Extract a section by numbered header (e.g., "### 3. Customer Snapshot") */
export function extractNumberedSection(content: string, sectionNumber: number): string {
  // Match headers like "### 3. Customer Snapshot" or "## 3. Customer Snapshot"
  const pattern = new RegExp(
    `^#{1,4}\\s*${sectionNumber}\\.\\s+.*$`,
    'm'
  )
  const match = content.match(pattern)
  if (!match) return ''

  const startIdx = match.index! + match[0].length
  // Find next section header (any numbered header or end of content)
  const nextPattern = /^#{1,4}\s*\d+\.\s+/m
  const rest = content.slice(startIdx)
  const nextMatch = rest.match(nextPattern)
  const endIdx = nextMatch ? startIdx + nextMatch.index! : content.length

  return content.slice(startIdx, endIdx).trim()
}

/** Insert content after a numbered section (before the next numbered section starts).
 *  If the target section is not found, appends to end of content as fallback. */
export function insertAfterNumberedSection(content: string, sectionNumber: number, insertContent: string): string {
  // Find the target section header
  const sectionPattern = new RegExp(
    `^#{1,4}\\s*${sectionNumber}\\.\\s+.*$`,
    'm'
  )
  const sectionMatch = content.match(sectionPattern)
  if (!sectionMatch) {
    // Section not found — append to end as fallback
    return content + '\n' + insertContent
  }

  // Find the start of the next numbered section
  const afterSectionStart = sectionMatch.index! + sectionMatch[0].length
  const rest = content.slice(afterSectionStart)
  const nextSectionPattern = /^#{1,4}\s*\d+\.\s+/m
  const nextMatch = rest.match(nextSectionPattern)

  if (nextMatch) {
    // Insert just before the next section header
    const insertPos = afterSectionStart + nextMatch.index!
    return content.slice(0, insertPos) + insertContent + '\n\n' + content.slice(insertPos)
  } else {
    // No next section — append after this section's content
    return content + '\n' + insertContent
  }
}

/** Extract a section by header text (e.g., "## Whitespace Map") */
export function extractSection(content: string, headerPattern: RegExp): string {
  const match = content.match(headerPattern)
  if (!match) return ''

  const startIdx = match.index! + match[0].length
  // Find next header of same or higher level
  const level = (match[0].match(/^#+/) ?? ['##'])[0].length
  const nextPattern = new RegExp(`^#{1,${level}}\\s+`, 'm')
  const rest = content.slice(startIdx)
  const nextMatch = rest.match(nextPattern)
  const endIdx = nextMatch ? startIdx + nextMatch.index! : content.length

  return content.slice(startIdx, endIdx).trim()
}

/** Check if a table column contains specific names (not generic references) */
export function hasSpecificNames(tableText: string, columnIndex: number): boolean {
  const lines = tableText.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'))
  if (lines.length <= 2) return false

  const genericPatterns = /\b(the customer|the team|them|they|customer|client|user|N\/A|TBD)\b/i
  const dataRows = lines.slice(2) // skip header + separator

  let hasName = false
  for (const row of dataRows) {
    const cells = row.split('|').filter(c => c.trim() !== '')
    if (cells.length > columnIndex) {
      const cellText = cells[columnIndex].trim()
      if (cellText.length > 1 && !genericPatterns.test(cellText)) {
        hasName = true
        break
      }
    }
  }
  return hasName
}

/** Format quality check failures as structured feedback for retry prompts */
export function formatFailureFeedback(failures: QualityCheck[]): string {
  if (failures.length === 0) return ''

  const lines = failures.map(f =>
    `- Check "${f.name}" FAILED: Expected: ${f.expected}. Got: ${f.actual}.`
  )

  return `Your previous output failed these quality checks:\n${lines.join('\n')}\n\nPlease fix specifically these issues and return the complete output.`
}
