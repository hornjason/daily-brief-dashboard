/**
 * HTML Template Generator for Meeting Prep
 *
 * Follows campaign-html-template.ts pattern — converts Gemini's markdown output
 * to pixel-perfect Google Docs HTML with Red Hat branding.
 *
 * Design spec matches gold standard: 10pt Arial, Red Hat red (#EE0000) headers,
 * styled tables with alternating rows, colored badges for urgency/status.
 */

interface MeetingPrepHTMLOptions {
  customerName: string
  meetingTitle: string
  dateStr: string
  preparedFor: string
}

interface Section {
  number: number
  title: string
  content: string
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Parse markdown sections from Gemini output
 * Handles both ### N. Title and ## N. Title patterns
 */
function parseMarkdownSections(markdown: string): Section[] {
  const sections: Section[] = []
  const sectionRegex = /^#{2,3}\s+(\d+)\.\s+(.+)$/gm

  let lastIdx = 0
  let lastSection: Section | null = null
  let match

  while ((match = sectionRegex.exec(markdown)) !== null) {
    if (lastSection) {
      lastSection.content = markdown.slice(lastIdx, match.index).trim()
      sections.push(lastSection)
    }
    lastSection = {
      number: parseInt(match[1]),
      title: match[2],
      content: '',
    }
    lastIdx = match.index + match[0].length
  }

  if (lastSection) {
    lastSection.content = markdown.slice(lastIdx).trim()
    sections.push(lastSection)
  }

  return sections
}

/**
 * Apply inline formatting — bold, colored badges, links
 */
function applyInlineFormatting(text: string): string {
  // Bold: **text** or __text__
  let result = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>')

  // Italic: *text* (but not in URLs)
  result = result.replace(/(?<!https?:\/\/[^\s]*)\*([^*]+)\*/g, '<em>$1</em>')

  // Color badges for key terms
  result = result.replace(/\b(HIGH|URGENT|CRITICAL|IMMEDIATE)\b/gi, '<span class="badge-urgent">$1</span>')
  result = result.replace(/\b(Coming [A-Z][a-z]+ \d{4}|GA —|New Product|NEW|COMING|Available)\b/gi, '<span class="badge-new">$1</span>')
  result = result.replace(/\b(Announced [A-Z][a-z]+ \d+|Tech Preview|Technology Preview|BETA)\b/gi, '<span class="badge-info">$1</span>')

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0066cc">$1</a>')

  return result
}

/**
 * Convert markdown content to HTML (tables, bullets, paragraphs)
 */
function renderContent(content: string): string {
  const lines = content.split('\n')
  let html = ''
  let inTable = false
  let tableRows: string[][] = []
  let tableHeaders: string[] = []
  let inList = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Empty line
    if (!trimmed) {
      if (inList) { html += '</ul>\n'; inList = false }
      continue
    }

    // Table separator — skip but mark headers done
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
      continue
    }

    // Table row
    if (/^\|.*\|$/.test(trimmed)) {
      if (!inTable) {
        // Flush any open list
        if (inList) { html += '</ul>\n'; inList = false }
        inTable = true
        tableHeaders = trimmed.slice(1, -1).split('|').map(c => c.trim())
      } else {
        tableRows.push(trimmed.slice(1, -1).split('|').map(c => c.trim()))
      }
      continue
    }

    // End of table
    if (inTable) {
      html += renderTable(tableHeaders, tableRows)
      inTable = false
      tableHeaders = []
      tableRows = []
    }

    // Blockquote lines (> text) — render as indented styled block
    if (/^>\s*/.test(trimmed)) {
      if (inList) { html += '</ul>\n'; inList = false }
      const quoteText = trimmed.replace(/^>\s*/, '')
      if (quoteText.startsWith('- ')) {
        html += `<p style="margin:4px 0 4px 20px;color:#333">${applyInlineFormatting(quoteText.replace(/^-\s+/, '• '))}</p>\n`
      } else {
        html += `<p style="margin:6px 0 6px 20px;padding:4px 8px;border-left:3px solid #ccc;color:#333">${applyInlineFormatting(quoteText)}</p>\n`
      }
      continue
    }

    // Bullet list
    if (/^[-*•]\s+/.test(trimmed)) {
      if (!inList) { html += '<ul>\n'; inList = true }
      html += `<li>${applyInlineFormatting(trimmed.replace(/^[-*•]\s+/, ''))}</li>\n`
      continue
    }

    // Checkbox list
    if (/^\[[ x]\]\s+/.test(trimmed)) {
      if (!inList) { html += '<ul style="list-style:none;padding-left:10px">\n'; inList = true }
      const checked = trimmed.startsWith('[x]')
      const text = trimmed.replace(/^\[[ x]\]\s+/, '')
      html += `<li>${checked ? '☑' : '☐'} ${applyInlineFormatting(text)}</li>\n`
      continue
    }

    // Regular paragraph
    if (inList) { html += '</ul>\n'; inList = false }
    html += `<p style="margin:8px 0">${applyInlineFormatting(trimmed)}</p>\n`
  }

  // Flush any remaining structures
  if (inTable) html += renderTable(tableHeaders, tableRows)
  if (inList) html += '</ul>\n'

  return html
}

/**
 * Render HTML table with Red Hat styling
 */
function renderTable(headers: string[], rows: string[][]): string {
  let html = '<table>\n<tr>'
  for (const h of headers) {
    html += `<th>${applyInlineFormatting(h)}</th>`
  }
  html += '</tr>\n'

  for (const row of rows) {
    html += '<tr>'
    for (let i = 0; i < headers.length; i++) {
      const cell = row[i] ?? ''
      html += `<td>${applyInlineFormatting(cell)}</td>`
    }
    html += '</tr>\n'
  }

  html += '</table>\n'
  return html
}

/**
 * Render a single section
 */
function renderSection(section: Section): string {
  return `<h2>${section.number}. ${escapeHtml(section.title)}</h2>\n${renderContent(section.content)}`
}

/**
 * Generate complete HTML document from markdown output
 */
export function generateMeetingPrepHTML(
  markdown: string,
  metadata: MeetingPrepHTMLOptions
): string {
  const sections = parseMarkdownSections(markdown)

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10pt;
    color: #333;
    line-height: 1.5;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
  }
  h1 {
    font-size: 16pt;
    color: #333;
    margin-bottom: 4px;
  }
  .subtitle {
    font-size: 10pt;
    color: #707070;
    margin-bottom: 20px;
  }
  h2 {
    font-size: 14pt;
    color: #EE0000;
    border-bottom: 2px solid #EE0000;
    padding-bottom: 6px;
    margin-top: 28px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
    font-size: 9pt;
  }
  th {
    background-color: #5f0000;
    color: white;
    font-weight: bold;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid #5f0000;
  }
  td {
    padding: 8px 10px;
    border: 1px solid #e0e0e0;
    vertical-align: top;
  }
  tr:nth-child(even) td {
    background-color: #f2f2f2;
  }
  tr:nth-child(odd) td {
    background-color: #ffffff;
  }
  ul {
    padding-left: 20px;
    margin: 8px 0;
  }
  li {
    margin-bottom: 4px;
  }
  .badge-urgent {
    color: #EE0000;
    font-weight: bold;
  }
  .badge-new {
    color: #3d7317;
    font-weight: bold;
  }
  .badge-info {
    color: #0066cc;
    font-weight: bold;
  }
  .section-note {
    font-size: 9pt;
    color: #707070;
    font-style: italic;
    margin-bottom: 8px;
  }
  .footer {
    font-size: 8pt;
    color: #a3a3a3;
    margin-top: 30px;
    border-top: 1px solid #e0e0e0;
    padding-top: 8px;
  }
</style>
</head>
<body>
<h1>Meeting Prep: ${escapeHtml(metadata.customerName)} — ${escapeHtml(metadata.meetingTitle)}</h1>
<div class="subtitle"><strong>${escapeHtml(metadata.dateStr)}</strong> | Prepared for: ${escapeHtml(metadata.preparedFor)}</div>

${sections.map(s => renderSection(s)).join('\n')}

<div class="footer">Generated by PAI Intelligence — ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
</body>
</html>`
}
