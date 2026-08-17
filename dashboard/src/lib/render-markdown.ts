function isTableRow(line: string) { return line.trim().startsWith('|') && line.trim().endsWith('|') }
function isSeparatorRow(line: string) { return isTableRow(line) && /^\|[\s|:-]+\|$/.test(line.trim()) }
function parseTableCells(line: string) {
  return line.trim().slice(1, -1).split('|').map(c => c.trim())
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineFormat(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-black/20 text-xs font-mono">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safe = /^https?:\/\//i.test(url.trim())
      return safe
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${label}</a>`
        : `<span class="text-accent">${label}</span>`
    })
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const html: string[] = []
  let inCodeBlock = false
  let inList = false
  let inOrderedList = false
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push('</code></pre>')
        inCodeBlock = false
      } else {
        closeList()
        html.push('<pre class="bg-black/20 rounded-lg p-3 overflow-x-auto text-xs my-2"><code>')
        inCodeBlock = true
      }
      i++; continue
    }
    if (inCodeBlock) {
      html.push(escapeHtml(line) + '\n')
      i++; continue
    }

    if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      closeList()
      const headers = parseTableCells(line)
      i += 2
      const thCells = headers.map(h => `<th class="px-3 py-2 text-left text-xs font-semibold text-text-primary border-b border-border whitespace-nowrap">${inlineFormat(h)}</th>`).join('')
      html.push('<div class="overflow-x-auto my-3"><table class="w-full text-xs border-collapse">')
      html.push(`<thead><tr>${thCells}</tr></thead><tbody>`)
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = parseTableCells(lines[i])
        const tdCells = cells.map(c => `<td class="px-3 py-2 text-text-secondary border-b border-border/30">${inlineFormat(c)}</td>`).join('')
        html.push(`<tr class="hover:bg-surface-hover/30">${tdCells}</tr>`)
        i++
      }
      html.push('</tbody></table></div>')
      continue
    }

    if (line.trim() === '') {
      closeList()
      i++; continue
    }

    if (/^---+$/.test(line.trim())) {
      closeList()
      html.push('<hr class="border-border/40 my-4" />')
      i++; continue
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headerMatch) {
      closeList()
      const level = headerMatch[1].length
      const text = inlineFormat(headerMatch[2])
      const sizes: Record<number, string> = {
        1: 'text-lg font-bold mt-6 mb-2',
        2: 'text-base font-bold mt-5 mb-2',
        3: 'text-sm font-semibold mt-4 mb-1.5',
        4: 'text-sm font-medium mt-3 mb-1',
        5: 'text-xs font-semibold mt-2 mb-1',
        6: 'text-xs font-medium mt-2 mb-1',
      }
      html.push(`<h${level} class="${sizes[level] ?? sizes[3]} text-text-primary">${text}</h${level}>`)
      i++; continue
    }

    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/)
    if (ulMatch) {
      if (!inList) {
        html.push('<ul class="list-disc list-outside ml-5 space-y-0.5 text-xs text-text-secondary my-1">')
        inList = true
      }
      html.push(`<li>${inlineFormat(ulMatch[2])}</li>`)
      i++; continue
    }

    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/)
    if (olMatch) {
      if (!inOrderedList) {
        closeList()
        html.push('<ol class="list-decimal list-outside ml-5 space-y-0.5 text-xs text-text-secondary my-1">')
        inOrderedList = true
      }
      html.push(`<li>${inlineFormat(olMatch[2])}</li>`)
      i++; continue
    }

    closeList()
    html.push(`<p class="text-xs text-text-secondary my-1.5 leading-relaxed">${inlineFormat(line)}</p>`)
    i++
  }

  closeList()
  return html.join('\n')

  function closeList() {
    if (inList) { html.push('</ul>'); inList = false }
    if (inOrderedList) { html.push('</ol>'); inOrderedList = false }
  }
}
