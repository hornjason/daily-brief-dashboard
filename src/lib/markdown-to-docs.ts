/**
 * markdown-to-docs.ts — Converts markdown text into Google Docs API
 * batchUpdate request arrays for formatted document creation.
 *
 * Strategy: Google Docs API requires text inserted first, then formatting
 * applied by character index ranges (1-based). So we:
 * 1. Parse markdown into segments (headings, paragraphs, bold, italic, bullets)
 * 2. Build a plain text string with all markdown syntax removed
 * 3. Track character index ranges where formatting applies
 * 4. Return insertText + formatting requests in correct order
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface HeadingRange {
  level: 1 | 2 | 3
  startIndex: number
  endIndex: number
}

interface InlineStyleRange {
  type: 'bold' | 'italic'
  startIndex: number
  endIndex: number
}

interface BulletRange {
  preset: 'BULLET_DISC_CIRCLE_SQUARE' | 'NUMBERED_DECIMAL_NESTED'
  startIndex: number
  endIndex: number
}

export interface TableDef {
  placeholderIndex: number  // character offset in plainText where this table should be inserted
  headers: string[]
  rows: string[][]
}

// ── Line classification ─────────────────────────────────────────────────────

type LineType =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'numbered'; text: string }
  | { kind: 'hr' }
  | { kind: 'table-separator' }
  | { kind: 'table-row'; cells: string[] }
  | { kind: 'paragraph'; text: string }

function classifyLine(line: string): LineType {
  // Headings: # H1, ## H2, ### H3
  const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
  if (headingMatch) {
    return { kind: 'heading', level: headingMatch[1].length as 1 | 2 | 3, text: headingMatch[2] }
  }

  // Horizontal rule: --- or ***  or ___ (3+ chars)
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return { kind: 'hr' }
  }

  // Table separator: |---|---|
  if (/^\|[\s\-:|]+\|$/.test(line)) {
    return { kind: 'table-separator' }
  }

  // Table row: | cell | cell |
  if (/^\|.*\|$/.test(line)) {
    const cells = line
      .slice(1, -1) // strip leading and trailing |
      .split('|')
      .map((c) => c.trim())
    return { kind: 'table-row', cells }
  }

  // Unordered bullet: - item or * item
  const bulletMatch = line.match(/^[-*]\s+(.+)$/)
  if (bulletMatch) {
    return { kind: 'bullet', text: bulletMatch[1] }
  }

  // Ordered list: 1. item
  const numberedMatch = line.match(/^\d+\.\s+(.+)$/)
  if (numberedMatch) {
    return { kind: 'numbered', text: numberedMatch[1] }
  }

  return { kind: 'paragraph', text: line }
}

// ── Inline formatting parser ────────────────────────────────────────────────

/**
 * Strip inline markdown (bold/italic) from text and return the plain text
 * plus an array of style ranges with offsets relative to the plain text.
 */
function parseInlineFormatting(
  text: string,
  baseIndex: number,
): { plain: string; styles: InlineStyleRange[] } {
  const styles: InlineStyleRange[] = []
  let plain = ''
  let i = 0

  while (i < text.length) {
    // Bold: **text**
    if (text[i] === '*' && text[i + 1] === '*') {
      const closeIdx = text.indexOf('**', i + 2)
      if (closeIdx !== -1) {
        const inner = text.slice(i + 2, closeIdx)
        const startOffset = plain.length
        // Recursively parse inner for nested italic
        const innerResult = parseInlineFormatting(inner, baseIndex + startOffset)
        plain += innerResult.plain
        styles.push({
          type: 'bold',
          startIndex: baseIndex + startOffset,
          endIndex: baseIndex + startOffset + innerResult.plain.length,
        })
        for (const s of innerResult.styles) styles.push(s)
        i = closeIdx + 2
        continue
      }
    }

    // Italic: *text* (single asterisk, not followed by another)
    if (text[i] === '*' && text[i + 1] !== '*') {
      const closeIdx = text.indexOf('*', i + 1)
      if (closeIdx !== -1 && text[closeIdx + 1] !== '*') {
        const inner = text.slice(i + 1, closeIdx)
        const startOffset = plain.length
        plain += inner
        styles.push({
          type: 'italic',
          startIndex: baseIndex + startOffset,
          endIndex: baseIndex + startOffset + inner.length,
        })
        i = closeIdx + 1
        continue
      }
    }

    plain += text[i]
    i++
  }

  return { plain, styles }
}

// ── Main export ─────────────────────────────────────────────────────────────

export function markdownToDocsRequests(markdown: string): { requests: any[]; plainText: string; tables: TableDef[] } {
  const lines = markdown.split('\n')
  const classified: LineType[] = lines.map(classifyLine)

  // Build plain text and collect formatting metadata
  let plainText = ''
  const headings: HeadingRange[] = []
  const inlineStyles: InlineStyleRange[] = []
  const bullets: BulletRange[] = []
  const tables: TableDef[] = []

  // Track consecutive bullet/numbered runs so we can emit one createParagraphBullets per run
  let currentBulletRun: { preset: BulletRange['preset']; startIndex: number; endIndex: number } | null = null

  function flushBulletRun() {
    if (currentBulletRun) {
      bullets.push({ ...currentBulletRun })
      currentBulletRun = null
    }
  }

  // Track pending table data
  let pendingTable: { headers: string[]; rows: string[][]; placeholderIndex: number } | null = null
  let inTable = false

  function flushTable() {
    if (pendingTable) {
      tables.push({
        placeholderIndex: pendingTable.placeholderIndex,
        headers: pendingTable.headers,
        rows: pendingTable.rows,
      })
      pendingTable = null
    }
  }

  for (let i = 0; i < classified.length; i++) {
    const line = classified[i]

    switch (line.kind) {
      case 'heading': {
        flushTable()
        flushBulletRun()
        const startIdx = 1 + plainText.length // 1-based index
        const { plain, styles } = parseInlineFormatting(line.text, startIdx)
        plainText += plain + '\n'
        headings.push({
          level: line.level,
          startIndex: startIdx,
          endIndex: startIdx + plain.length + 1, // include the newline
        })
        for (const s of styles) inlineStyles.push(s)
        break
      }

      case 'bullet': {
        flushTable()
        const startIdx = 1 + plainText.length
        const { plain, styles } = parseInlineFormatting(line.text, startIdx)
        plainText += plain + '\n'
        const endIdx = 1 + plainText.length
        const preset = 'BULLET_DISC_CIRCLE_SQUARE' as const
        if (currentBulletRun && currentBulletRun.preset === preset) {
          currentBulletRun.endIndex = endIdx
        } else {
          flushBulletRun()
          currentBulletRun = { preset, startIndex: startIdx, endIndex: endIdx }
        }
        for (const s of styles) inlineStyles.push(s)
        break
      }

      case 'numbered': {
        flushTable()
        const startIdx = 1 + plainText.length
        const { plain, styles } = parseInlineFormatting(line.text, startIdx)
        plainText += plain + '\n'
        const endIdx = 1 + plainText.length
        const preset = 'NUMBERED_DECIMAL_NESTED' as const
        if (currentBulletRun && currentBulletRun.preset === preset) {
          currentBulletRun.endIndex = endIdx
        } else {
          flushBulletRun()
          currentBulletRun = { preset, startIndex: startIdx, endIndex: endIdx }
        }
        for (const s of styles) inlineStyles.push(s)
        break
      }

      case 'hr': {
        flushTable()
        flushBulletRun()
        // Just add an extra newline
        plainText += '\n'
        break
      }

      case 'table-separator': {
        // Mark that we're inside a table
        inTable = true
        break
      }

      case 'table-row': {
        flushBulletRun()
        if (!inTable && !pendingTable) {
          // First row of a table — this is the header
          pendingTable = {
            headers: line.cells,
            rows: [],
            placeholderIndex: plainText.length,
          }
          // Insert a single newline placeholder
          plainText += '\n'
        } else if (inTable && pendingTable) {
          // Data row
          pendingTable.rows.push(line.cells)
        }
        break
      }

      case 'paragraph': {
        flushTable()
        flushBulletRun()
        if (line.text === '') {
          // Empty line — preserve as blank line only if not redundant
          // But always emit at least one newline for paragraph breaks
          if (plainText.length > 0 && !plainText.endsWith('\n\n')) {
            plainText += '\n'
          }
          // Reset table state on empty line
          inTable = false
        } else {
          const startIdx = 1 + plainText.length
          const { plain, styles } = parseInlineFormatting(line.text, startIdx)
          plainText += plain + '\n'
          for (const s of styles) inlineStyles.push(s)
          // Reset table state
          inTable = false
        }
        break
      }
    }
  }

  flushTable()
  flushBulletRun()

  // Ensure trailing newline
  if (!plainText.endsWith('\n')) {
    plainText += '\n'
  }

  // ── Build requests array ─────────────────────────────────────────────

  const requests: any[] = []

  // 1. Insert all text first
  requests.push({
    insertText: {
      location: { index: 1 },
      text: plainText,
    },
  })

  // 2. Heading styles
  for (const h of headings) {
    const namedStyleType = h.level === 1 ? 'HEADING_1' : h.level === 2 ? 'HEADING_2' : 'HEADING_3'
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: h.startIndex, endIndex: h.endIndex },
        paragraphStyle: { namedStyleType },
        fields: 'namedStyleType',
      },
    })
  }

  // 3. Inline text styles (bold, italic)
  for (const s of inlineStyles) {
    if (s.type === 'bold') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: s.startIndex, endIndex: s.endIndex },
          textStyle: { bold: true },
          fields: 'bold',
        },
      })
    } else {
      requests.push({
        updateTextStyle: {
          range: { startIndex: s.startIndex, endIndex: s.endIndex },
          textStyle: { italic: true },
          fields: 'italic',
        },
      })
    }
  }

  // 4. Bullet lists
  for (const b of bullets) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: b.startIndex, endIndex: b.endIndex },
        bulletPreset: b.preset,
      },
    })
  }

  return { requests, plainText, tables }
}
