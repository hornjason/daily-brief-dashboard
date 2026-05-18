/**
 * GitHub Issue #142: Account detail tab navigation chrome
 * GitHub Issue #240: Auto-discovered tabs from Feature Module Registry with overflow
 * Follows PodTabBar styling pattern
 */

import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'

// Tab ID is now dynamic (module name or 'overview'/'intelligence')
export type AccountTab = string

export interface TabEntry {
  id: string
  label: string
  order: number
}

interface CustomerTabBarProps {
  tabs: TabEntry[]        // pre-sorted by parent
  activeTab: AccountTab
  onChange: (tabId: AccountTab) => void
}

const OVERFLOW_THRESHOLD = 7

export function CustomerTabBar({ tabs, activeTab, onChange }: CustomerTabBarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Split tabs into visible and overflow
  const { visible, overflow } = splitTabsForOverflow(tabs, OVERFLOW_THRESHOLD)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [dropdownOpen])

  // Check if active tab is in overflow
  const activeInOverflow = overflow.some(t => t.id === activeTab)
  const activeOverflowTab = overflow.find(t => t.id === activeTab)

  return (
    <div className="w-full h-12 bg-surface flex items-end px-6 gap-1 shrink-0 overflow-x-auto">
      {/* Visible tabs */}
      {visible.map(tab => {
        const isActive = tab.id === activeTab
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors relative whitespace-nowrap ${
              isActive
                ? 'text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-t" />
            )}
          </button>
        )
      })}

      {/* Overflow dropdown */}
      {overflow.length > 0 && (
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-1.5 ${
              activeInOverflow
                ? 'text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {activeInOverflow ? activeOverflowTab?.label : 'More'}
            <ChevronDown className="w-3.5 h-3.5" />
            {activeInOverflow && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-t" />
            )}
          </button>

          {dropdownOpen && (
            <div className="absolute top-full right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg overflow-hidden z-50 min-w-[180px]">
              {overflow.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => {
                    onChange(tab.id)
                    setDropdownOpen(false)
                  }}
                  className={`w-full px-4 py-2.5 text-left text-sm font-medium transition-colors ${
                    tab.id === activeTab
                      ? 'bg-surface-hover text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Helper functions ─────────────────────────────────────────────────────────

function splitTabsForOverflow(
  tabs: TabEntry[],
  threshold: number
): { visible: TabEntry[]; overflow: TabEntry[] } {
  if (tabs.length <= threshold) {
    return { visible: tabs, overflow: [] }
  }

  const overview = tabs[0]
  const intelligence = tabs[tabs.length - 1]
  const middle = tabs.slice(1, -1)

  // Available slots for middle tabs = threshold - 2 (overview + intelligence)
  const middleSlots = threshold - 2
  const visibleMiddle = middle.slice(0, middleSlots)
  const overflowMiddle = middle.slice(middleSlots)

  return {
    visible: [overview, ...visibleMiddle, intelligence],
    overflow: overflowMiddle
  }
}
