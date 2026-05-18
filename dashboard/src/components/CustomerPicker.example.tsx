/**
 * CustomerPicker Usage Examples
 *
 * This file demonstrates how to use the CustomerPicker component.
 * It is NOT imported by the app - it's documentation only.
 */

import { useState } from 'react'
import { CustomerPicker } from './CustomerPicker'

/**
 * Example 1: Customer-only scope (one customer must be selected)
 *
 * Use this when the feature requires a specific customer selection.
 * The picker shows "Select a customer..." when no selection is made.
 */
export function CustomerOnlyExample() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold mb-4">Select a Customer</h2>
      <CustomerPicker
        scope="customer"
        value={selectedSlug}
        onChange={setSelectedSlug}
      />
      {selectedSlug && (
        <p className="mt-4 text-sm text-zinc-400">
          Selected: {selectedSlug}
        </p>
      )}
    </div>
  )
}

/**
 * Example 2: Both scope (includes "All customers" option)
 *
 * Use this when the feature can show data for all customers or a specific one.
 * The picker defaults to "All customers" when no selection is made.
 */
export function BothScopeExample() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold mb-4">Filter by Customer</h2>
      <CustomerPicker
        scope="both"
        value={selectedSlug}
        onChange={setSelectedSlug}
      />
      <p className="mt-4 text-sm text-zinc-400">
        {selectedSlug
          ? `Showing data for: ${selectedSlug}`
          : 'Showing data for all customers'}
      </p>
    </div>
  )
}

/**
 * Example 3: Reading from URL query param
 *
 * The CustomerPicker automatically syncs with ?customer=slug in the URL.
 * On mount, it reads the URL param and calls onChange if a customer slug is present.
 * When the user selects a customer, it updates the URL param.
 */
export function UrlSyncExample() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold mb-4">Customer Picker with URL Sync</h2>
      <CustomerPicker
        scope="both"
        value={selectedSlug}
        onChange={setSelectedSlug}
      />
      <p className="mt-4 text-xs text-zinc-500">
        Try adding ?customer=acme-corp to the URL and reload the page.
        The picker will pre-select that customer.
      </p>
    </div>
  )
}
