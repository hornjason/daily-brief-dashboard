import { useState } from 'react'

interface CitationProps {
  index: number
  source: string  // e.g. "Email from Bob Chen, 2026-03-28"
}

export default function CitationTooltip({ index, source }: CitationProps) {
  const [show, setShow] = useState(false)

  return (
    <span className="relative inline-block">
      <sup
        className="text-xs text-accent cursor-help tabular-nums"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        [{index}]
      </sup>
      {show && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs bg-surface border border-border rounded shadow-lg whitespace-nowrap z-50 text-text-secondary">
          {source}
        </span>
      )}
    </span>
  )
}
