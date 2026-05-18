/**
 * ModulePageShell — Shared layout component for module pages
 *
 * GitHub Issue #237
 *
 * Provides a consistent layout with:
 * - Sticky header with title and optional icon
 * - CustomerPicker integration (when scope requires it)
 * - State management: loading > error > empty > children
 * - Full-height scrollable content area
 *
 * Usage:
 *   <ModulePageShell
 *     title="Intelligence"
 *     icon="Brain"
 *     scope="customer"
 *     loading={isLoading}
 *     error={errorMsg}
 *     empty={items.length === 0}
 *     emptyMessage="No intelligence available"
 *   >
 *     {content}
 *   </ModulePageShell>
 */

import { createContext, useContext, useState, useEffect } from 'react'
import { CustomerPicker } from './CustomerPicker'
import { useSearchParams } from 'react-router-dom'
import * as Icons from 'lucide-react'

export interface ModulePageShellProps {
  /** Page title displayed in header */
  title: string
  /** Optional Lucide icon name (e.g., "Brain", "Package") */
  icon?: string
  /** Scope determines CustomerPicker behavior:
   *  - 'portfolio': no picker
   *  - 'customer': picker required, one customer selected
   *  - 'both': picker with "All customers" option
   */
  scope: 'portfolio' | 'customer' | 'both'
  /** Loading state (highest priority) */
  loading?: boolean
  /** Error message (second priority) */
  error?: string | null
  /** Empty state (third priority) */
  empty?: boolean
  /** Empty state message */
  emptyMessage?: string
  /** Empty state icon name */
  emptyIcon?: string
  /** Retry callback for error state */
  onRetry?: () => void
  /** Content to render when no special states active */
  children: React.ReactNode
}

interface ModulePageContextValue {
  customer: string | null
}

const ModulePageContext = createContext<ModulePageContextValue>({ customer: null })

/**
 * Hook to access the selected customer slug from ModulePageShell context
 */
export const useModulePage = () => useContext(ModulePageContext)

export function ModulePageShell({
  title,
  icon,
  scope,
  loading = false,
  error = null,
  empty = false,
  emptyMessage = 'No data available',
  emptyIcon,
  onRetry,
  children,
}: ModulePageShellProps) {
  const [searchParams] = useSearchParams()
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(() => {
    // Initialize from URL query param if present
    const urlSlug = searchParams.get('customer')
    if (scope === 'portfolio') return null
    return urlSlug || null
  })

  // Update selected customer when URL changes
  useEffect(() => {
    const urlSlug = searchParams.get('customer')
    if (scope === 'portfolio') {
      setSelectedCustomer(null)
    } else if (urlSlug !== selectedCustomer) {
      setSelectedCustomer(urlSlug)
    }
  }, [searchParams, scope])

  // Resolve icon component dynamically
  const IconComponent = icon ? (Icons as any)[icon] : null

  // State priority: loading > error > empty > children
  let content: React.ReactNode

  if (loading) {
    content = (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-text-secondary">Loading...</span>
        </div>
      </div>
    )
  } else if (error) {
    content = (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <p className="text-red-400 text-sm">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-4 py-2 bg-surface-hover hover:bg-surface-active text-text-primary text-sm rounded transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    )
  } else if (empty) {
    const EmptyIconComponent = emptyIcon ? (Icons as any)[emptyIcon] : null
    content = (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          {EmptyIconComponent && <EmptyIconComponent className="w-12 h-12 text-text-secondary" />}
          <p className="text-sm text-text-secondary">{emptyMessage}</p>
        </div>
      </div>
    )
  } else {
    content = (
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
    )
  }

  return (
    <ModulePageContext.Provider value={{ customer: selectedCustomer }}>
      <div className="flex flex-col min-h-screen bg-bg">
        {/* Sticky header */}
        <div className="sticky top-0 z-10 bg-surface border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            {IconComponent && <IconComponent className="w-6 h-6 text-text-secondary" />}
            <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
          </div>

          {/* CustomerPicker — only render when scope requires it */}
          {(scope === 'customer' || scope === 'both') && (
            <div className="mt-4">
              <CustomerPicker
                scope={scope}
                value={selectedCustomer}
                onChange={setSelectedCustomer}
              />
            </div>
          )}
        </div>

        {/* Content area */}
        {content}
      </div>
    </ModulePageContext.Provider>
  )
}
