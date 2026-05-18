/**
 * CustomerPicker — Shared searchable customer dropdown component
 *
 * GitHub Issue #236
 *
 * Provides a searchable dropdown for selecting customers across the application.
 * Fetches customer/AE data from GET /api/accounts and groups results by AE.
 *
 * Features:
 * - Search filtering (case-insensitive substring match)
 * - Grouped by AE with section headers
 * - Keyboard navigation (arrow keys, enter, escape)
 * - URL query param sync via ?customer=slug
 * - Two scope modes: 'customer' (one required) or 'both' (includes "All customers")
 *
 * Usage:
 *   <CustomerPicker scope="customer" value={slug} onChange={setSlug} />
 *   <CustomerPicker scope="both" value={slug} onChange={setSlug} />
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Check } from 'lucide-react'

export interface CustomerPickerProps {
  /** 'customer' = one customer required; 'both' = includes "All customers" option */
  scope: 'customer' | 'both'
  /** Currently selected customer slug (null = no selection / "All customers") */
  value: string | null
  /** Callback when selection changes */
  onChange: (slug: string | null) => void
}

interface Customer {
  name: string
  ae: string
  slug: string
}

interface CustomerGroup {
  ae: string
  customers: Customer[]
}

/**
 * Filter customers by search query (case-insensitive substring match on name)
 */
export function filterCustomers(customers: Customer[], query: string): Customer[] {
  if (!query.trim()) return customers
  const lower = query.toLowerCase()
  return customers.filter(c => c.name.toLowerCase().includes(lower))
}

/**
 * Group customers by AE for display
 * Returns array of { ae: string, customers: Customer[] } sorted by AE name
 */
export function groupCustomersByAE(customers: Customer[]): CustomerGroup[] {
  const groups = new Map<string, Customer[]>()

  for (const customer of customers) {
    const ae = customer.ae || 'Unassigned'
    if (!groups.has(ae)) {
      groups.set(ae, [])
    }
    groups.get(ae)!.push(customer)
  }

  // Sort customers within each group by name
  for (const list of groups.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }

  // Return sorted by AE name
  return Array.from(groups.entries())
    .map(([ae, customers]) => ({ ae, customers }))
    .sort((a, b) => a.ae.localeCompare(b.ae))
}

/**
 * Generate customer slug from name (lowercase, hyphenated)
 */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function CustomerPicker({ scope, value, onChange }: CustomerPickerProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch customer data on mount
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)

    fetch('/api/accounts', { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        const transformed = data.customers.map((c: any) => ({
          name: c.name,
          ae: c.ae,
          slug: toSlug(c.name),
        }))
        setCustomers(transformed)
        setLoading(false)
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          setError('Failed to load customers')
          setLoading(false)
        }
      })

    return () => controller.abort()
  }, [])

  // Sync with URL query param on mount
  useEffect(() => {
    const urlSlug = searchParams.get('customer')
    if (urlSlug && urlSlug !== value) {
      onChange(urlSlug)
    }
  }, []) // Run once on mount

  // Filter and group customers
  const filteredCustomers = useMemo(
    () => filterCustomers(customers, searchQuery),
    [customers, searchQuery]
  )

  const groups = useMemo(
    () => groupCustomersByAE(filteredCustomers),
    [filteredCustomers]
  )

  // Flatten for keyboard navigation
  const flatItems = useMemo(() => {
    const items: Array<{ type: 'all' | 'header' | 'customer'; customer?: Customer; ae?: string }> = []
    if (scope === 'both') {
      items.push({ type: 'all' })
    }
    for (const group of groups) {
      items.push({ type: 'header', ae: group.ae })
      for (const customer of group.customers) {
        items.push({ type: 'customer', customer })
      }
    }
    return items
  }, [scope, groups])

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Keyboard navigation
  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault()
        setIsOpen(true)
        setFocusedIndex(0)
      }
      return
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        setFocusedIndex(-1)
        inputRef.current?.blur()
        break

      case 'ArrowDown':
        e.preventDefault()
        setFocusedIndex(prev => {
          let next = prev + 1
          // Skip headers
          while (next < flatItems.length && flatItems[next].type === 'header') {
            next++
          }
          return next < flatItems.length ? next : prev
        })
        break

      case 'ArrowUp':
        e.preventDefault()
        setFocusedIndex(prev => {
          let next = prev - 1
          // Skip headers
          while (next >= 0 && flatItems[next].type === 'header') {
            next--
          }
          return next >= 0 ? next : prev
        })
        break

      case 'Enter':
        e.preventDefault()
        if (focusedIndex >= 0 && focusedIndex < flatItems.length) {
          const item = flatItems[focusedIndex]
          if (item.type === 'all') {
            handleSelect(null)
          } else if (item.type === 'customer' && item.customer) {
            handleSelect(item.customer.slug)
          }
        }
        break
    }
  }

  function handleSelect(slug: string | null) {
    onChange(slug)

    // Update URL query param
    if (slug === null) {
      searchParams.delete('customer')
    } else {
      searchParams.set('customer', slug)
    }
    setSearchParams(searchParams)

    setIsOpen(false)
    setSearchQuery('')
    setFocusedIndex(-1)
    inputRef.current?.blur()
  }

  // Display text
  const selectedCustomer = customers.find(c => c.slug === value)
  const displayText = selectedCustomer
    ? selectedCustomer.name
    : scope === 'both'
    ? 'All customers'
    : 'Select a customer...'

  if (loading) {
    return (
      <div className="relative w-full max-w-md">
        <div className="w-full px-4 py-2.5 bg-surface border border-border rounded-lg text-sm text-text-secondary">
          Loading customers...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="relative w-full max-w-md">
        <div className="w-full px-4 py-2.5 bg-surface border border-critical rounded-lg text-sm text-red-400">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div ref={dropdownRef} className="relative w-full max-w-md">
      {/* Input field */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={isOpen ? searchQuery : displayText}
          onChange={e => setSearchQuery(e.target.value)}
          onFocus={() => {
            setIsOpen(true)
            setSearchQuery('')
          }}
          onKeyDown={handleKeyDown}
          placeholder={scope === 'both' ? 'All customers' : 'Select a customer...'}
          className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
        />
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-surface border border-border rounded-lg shadow-xl max-h-80 overflow-y-auto">
          {/* "All customers" option (scope=both only) */}
          {scope === 'both' && (
            <button
              onClick={() => handleSelect(null)}
              className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                focusedIndex === 0
                  ? 'bg-accent/20 text-accent'
                  : value === null
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-primary hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">All customers</span>
                {value === null && <Check className="w-4 h-4 text-accent" />}
              </div>
            </button>
          )}

          {/* Grouped customer list */}
          {groups.length === 0 ? (
            <div className="px-4 py-3 text-sm text-text-secondary">No customers found</div>
          ) : (
            groups.map(group => (
              <div key={group.ae}>
                {/* AE header */}
                <div className="px-4 py-2 text-xs font-semibold text-text-secondary bg-bg/50 border-t border-border/50 first:border-t-0">
                  {group.ae}
                </div>

                {/* Customer items */}
                {group.customers.map((customer, idx) => {
                  const itemIndex = flatItems.findIndex(
                    item => item.type === 'customer' && item.customer?.slug === customer.slug
                  )
                  const isFocused = itemIndex === focusedIndex
                  const isSelected = customer.slug === value

                  return (
                    <button
                      key={customer.slug}
                      onClick={() => handleSelect(customer.slug)}
                      className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                        isFocused
                          ? 'bg-accent/20 text-accent'
                          : isSelected
                          ? 'bg-surface-hover text-text-primary'
                          : 'text-text-primary hover:bg-surface-hover'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span>{customer.name}</span>
                        {isSelected && <Check className="w-4 h-4 text-accent" />}
                      </div>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
