import { useState, useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

interface SidebarGroupProps {
  title: string
  icon: ReactNode
  children: ReactNode
  defaultExpanded?: boolean
  summaryText?: string
  storageKey: string
}

function getStoredExpanded(storageKey: string, defaultExpanded: boolean): boolean {
  try {
    const stored = localStorage.getItem(`account-detail:${storageKey}`)
    if (stored !== null) return stored === 'true'
  } catch {
    // localStorage unavailable
  }
  return defaultExpanded
}

export function SidebarGroup({
  title,
  icon,
  children,
  defaultExpanded = false,
  summaryText,
  storageKey,
}: SidebarGroupProps) {
  const [expanded, setExpanded] = useState(() => getStoredExpanded(storageKey, defaultExpanded))

  useEffect(() => {
    try {
      localStorage.setItem(`account-detail:${storageKey}`, String(expanded))
    } catch {
      // localStorage unavailable
    }
  }, [expanded, storageKey])

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full px-5 py-3 flex items-center gap-2 text-left hover:bg-surface-elevated transition-colors"
      >
        <span className="text-text-secondary shrink-0">{icon}</span>
        <span className="text-sm font-semibold text-text-primary">{title}</span>
        {!expanded && summaryText && (
          <span className="text-xs text-text-secondary ml-1 truncate">{summaryText}</span>
        )}
        <ChevronDown
          className={`w-4 h-4 ml-auto text-text-secondary transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-border/40 p-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  )
}
