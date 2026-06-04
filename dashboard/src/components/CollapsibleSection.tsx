/**
 * CollapsibleSection.tsx
 * Reusable collapsible wrapper for progressive disclosure on the overview tab.
 * GitHub Issue #619 — Progressive disclosure: collapsible secondary sections
 *
 * Persists collapse state via localStorage using key `pai-collapsed-{sectionName}`.
 * Shows a summary line when collapsed: section title + count/status.
 */

import { useState, useEffect, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface CollapsibleSectionProps {
  /** Unique section name — used for localStorage key */
  sectionName: string
  /** Display title */
  title: string
  /** Icon element (lucide icon) */
  icon?: ReactNode
  /** Short summary text shown when collapsed, e.g. "3 contacts" */
  summaryText?: string
  /** Whether section starts collapsed (default: true) */
  defaultCollapsed?: boolean
  children: ReactNode
}

function getStoredState(sectionName: string, defaultCollapsed: boolean): boolean {
  try {
    const stored = localStorage.getItem(`pai-collapsed-${sectionName}`)
    if (stored !== null) return stored === 'true'
  } catch {
    // localStorage unavailable
  }
  return defaultCollapsed
}

export function CollapsibleSection({
  sectionName,
  title,
  icon,
  summaryText,
  defaultCollapsed = true,
  children,
}: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(() => getStoredState(sectionName, defaultCollapsed))

  // Persist to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(`pai-collapsed-${sectionName}`, String(collapsed))
    } catch {
      // localStorage unavailable
    }
  }, [collapsed, sectionName])

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(v => !v)}
        className="w-full px-5 py-3 flex items-center gap-2 text-left hover:bg-border/10 transition-colors"
      >
        {icon && <span className="text-text-secondary shrink-0">{icon}</span>}
        <span className="text-sm font-semibold text-text-primary">{title}</span>
        {collapsed && summaryText && (
          <span className="text-xs text-text-secondary ml-1">{summaryText}</span>
        )}
        <span className="ml-auto text-text-secondary">
          {collapsed
            ? <ChevronDown className="w-4 h-4" />
            : <ChevronUp className="w-4 h-4" />
          }
        </span>
      </button>
      {!collapsed && (
        <div className="border-t border-border/40">
          {children}
        </div>
      )}
    </div>
  )
}
