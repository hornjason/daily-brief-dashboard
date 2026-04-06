import React from 'react'

/**
 * Converts inline markdown to React elements.
 * Handles: **bold**, *italic*, `code` — nothing else.
 * Dependency-free (no react-markdown needed for inline only).
 */
export function renderMarkdownInline(text: string): React.ReactNode {
  if (!text) return text

  // Split on inline patterns: **bold**, *italic*, `code`
  // Process in order of specificity: code first (to avoid * matching inside `...`),
  // then bold (**), then italic (*)
  const segments: React.ReactNode[] = []
  // Regex captures: `code`, **bold**, *italic*, and plain text between them
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    // Add any plain text before this match
    if (match.index > lastIndex) {
      segments.push(text.slice(lastIndex, match.index))
    }

    const token = match[0]
    if (token.startsWith('`')) {
      segments.push(
        <code key={match.index} className="px-1 py-0.5 rounded bg-surface-hover text-xs font-mono">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**')) {
      segments.push(<strong key={match.index}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      segments.push(<em key={match.index}>{token.slice(1, -1)}</em>)
    }

    lastIndex = match.index + token.length
  }

  // Add any remaining plain text
  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex))
  }

  // If no markdown was found, return the original string (avoids unnecessary wrapper)
  if (segments.length === 1 && typeof segments[0] === 'string') {
    return text
  }

  return <>{segments}</>
}
