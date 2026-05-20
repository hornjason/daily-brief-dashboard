/**
 * Shared markdown-to-HTML conversion utilities.
 * Used by playbook HTML generator and campaign HTML template.
 * GitHub Issue #311
 */

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Apply inline formatting: bold, italic, links (including bare URLs).
 * Merges playbook's applyInlineFormatting + campaign's convertMarkdownBold/Links.
 */
export function applyInlineFormatting(text: string): string {
  let result = text
  // Bold: **text** and __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  // Italic: *text* (but not URLs like https://...)
  result = result.replace(/(?<!https?:\/\/[^\s]*)\*([^*]+)\*/g, '<em>$1</em>')
  // Markdown links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0066cc">$1</a>')
  // Gemini alternate format: [url] text (from campaign converter)
  result = result.replace(/\[(https?:\/\/[^\]]+)\]\s*([^[\n]+)/g, '<a href="$1" style="color:#0066cc">$2</a>')
  // Bare URLs (from campaign converter) — only if not already inside an href
  result = result.replace(/(?<!")(https?:\/\/[^\s<>"]+)/g, '<a href="$1" style="color:#0066cc">Link</a>')
  return result
}

/**
 * Convert markdown content block to HTML.
 * Handles: tables, numbered lists, bullet lists, paragraphs.
 * From playbook's renderContent, enhanced with campaign's bullet styling.
 */
export function renderMarkdownToHtml(content: string): string {
  // Pre-process: Gemini sometimes returns bullets and headers on a single line
  // e.g., "### Strengths - bullet1 - bullet2 ### Weaknesses - bullet3"
  // Split these onto separate lines before parsing.
  let normalized = content
    .replace(/\s+(#{1,3}\s)/g, '\n$1')         // Split before ### headers
    .replace(/\.\s+-\s+\*\*/g, '.\n- **')      // Split " - **Bold" after period (new bullet with bold start)
    .replace(/\s+•\s+/g, '\n• ')               // Split inline " • "
    .replace(/\.\s*Business value:/g, '.<br><strong>Business value:</strong>')  // Business value as line break within same bullet

  const lines = normalized.split('\n').filter((l, idx) => idx > 0 || l.trim() !== '')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (!trimmed) { i++; continue }

    // Markdown table blocks
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s-|]+\|$/.test(lines[i + 1]?.trim())) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim())
        i++
      }
      const headerCells = tableLines[0].split('|').filter(c => c.trim()).map(c => applyInlineFormatting(c.trim()))
      const dataRows = tableLines.slice(2).map(row => row.split('|').filter(c => c.trim()).map(c => applyInlineFormatting(c.trim())))
      result.push(`<table style="width:100%"><tr>${headerCells.map(c => `<th>${c}</th>`).join('')}</tr>${dataRows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`)
      continue
    }

    // Numbered lists
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${applyInlineFormatting(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`)
        i++
      }
      result.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Bullet lists
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(`<li>${applyInlineFormatting(lines[i].trim().replace(/^[-*•]\s+/, ''))}</li>`)
        i++
      }
      result.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Markdown headers (### Title)
    const headerMatch = trimmed.match(/^(#{1,3})\s+(.+)/)
    if (headerMatch) {
      const level = headerMatch[1].length + 1 // ### = h4, ## = h3
      result.push(`<h${level}>${applyInlineFormatting(headerMatch[2])}</h${level}>`)
      i++
      continue
    }

    // Regular paragraph
    result.push(`<p style="margin:8px 0">${applyInlineFormatting(trimmed)}</p>`)
    i++
  }
  return result.join('\n')
}
