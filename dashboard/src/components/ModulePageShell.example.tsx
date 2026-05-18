/**
 * Example usage of ModulePageShell component
 * GitHub Issue #237
 *
 * This file demonstrates the three main usage patterns:
 * 1. Portfolio scope (no customer picker)
 * 2. Customer scope (customer picker, one required)
 * 3. Both scope (customer picker with "All customers" option)
 */

import { ModulePageShell, useModulePage } from './ModulePageShell'
import { useState, useEffect } from 'react'

// Example 1: Portfolio scope (no customer selection)
export function PortfolioPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState([1, 2, 3])

  return (
    <ModulePageShell
      title="Portfolio Intelligence"
      icon="Brain"
      scope="portfolio"
      loading={loading}
      error={error}
      empty={items.length === 0}
      emptyMessage="No portfolio data available"
      emptyIcon="FileX"
      onRetry={() => setError(null)}
    >
      <div className="p-6">
        <p className="text-white">Portfolio content here...</p>
      </div>
    </ModulePageShell>
  )
}

// Example 2: Customer scope (customer picker required)
export function CustomerPage() {
  const { customer } = useModulePage()

  return (
    <ModulePageShell
      title="Customer Intelligence"
      icon="User"
      scope="customer"
    >
      <div className="p-6">
        <p className="text-white">
          Selected customer: {customer || 'None'}
        </p>
      </div>
    </ModulePageShell>
  )
}

// Example 3: Both scope (customer picker with "All customers" option)
export function FlexiblePage() {
  const { customer } = useModulePage()
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Simulate data fetch
  useEffect(() => {
    const timer = setTimeout(() => {
      setData([{ id: 1, name: 'Item' }])
      setLoading(false)
    }, 1000)
    return () => clearTimeout(timer)
  }, [customer])

  return (
    <ModulePageShell
      title="Flexible View"
      icon="LayoutGrid"
      scope="both"
      loading={loading}
      empty={data.length === 0}
      emptyMessage="No data for this selection"
    >
      <div className="p-6">
        <p className="text-white">
          Viewing: {customer || 'All customers'}
        </p>
        <ul>
          {data.map(item => (
            <li key={item.id} className="text-zinc-300">{item.name}</li>
          ))}
        </ul>
      </div>
    </ModulePageShell>
  )
}

// Example 4: Error state with retry
export function ErrorStatePage() {
  const [error, setError] = useState<string | null>('Failed to load data')

  return (
    <ModulePageShell
      title="Error Example"
      scope="portfolio"
      error={error}
      onRetry={() => {
        setError(null)
        // Re-fetch logic here
      }}
    >
      <div>This won't render when error is set</div>
    </ModulePageShell>
  )
}
