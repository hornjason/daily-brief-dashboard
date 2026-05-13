import { useState, useEffect } from 'react'
import { Target } from 'lucide-react'

interface AEInfo {
  name: string
  customers: string[]
}

interface Customer {
  name: string
  ae?: string
}

interface BatchProgress {
  customerName: string
  status: 'pending' | 'running' | 'done' | 'failed'
  driveUrl?: string
  error?: string
}

type BatchAction = 'campaigns' | 'news' | 'pitchbuilder' | 'finlistics'

export function BatchPage() {
  const [aes, setAes] = useState<AEInfo[]>([])
  const [allCustomers, setAllCustomers] = useState<Customer[]>([])
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedAction, setSelectedAction] = useState<BatchAction>('campaigns')
  const [progress, setProgress] = useState<BatchProgress[]>([])
  const [batchRunning, setBatchRunning] = useState(false)

  // Fetch AEs and customers on mount
  useEffect(() => {
    fetch('/api/aes')
      .then(r => r.json())
      .then(d => setAes(d.aes || []))
      .catch(err => console.error('Failed to fetch AEs:', err))

    fetch('/api/accounts')
      .then(r => r.json())
      .then(d => setAllCustomers(d.customers || []))
      .catch(err => console.error('Failed to fetch customers:', err))
  }, [])

  // Group customers by AE
  const groupedCustomers = allCustomers.reduce((acc, customer) => {
    const ae = customer.ae || 'Unassigned'
    if (!acc[ae]) acc[ae] = []
    acc[ae].push(customer.name)
    return acc
  }, {} as Record<string, string[]>)

  // Filter customers by search query
  const filteredGroups = Object.entries(groupedCustomers).reduce((acc, [ae, customers]) => {
    const filtered = customers.filter(name =>
      name.toLowerCase().includes(searchQuery.toLowerCase())
    )
    if (filtered.length > 0) {
      acc[ae] = filtered
    }
    return acc
  }, {} as Record<string, string[]>)

  const handleToggleCustomer = (customerName: string) => {
    setSelectedCustomers(prev => {
      const next = new Set(prev)
      if (next.has(customerName)) {
        next.delete(customerName)
      } else {
        next.add(customerName)
      }
      return next
    })
  }

  const handleSelectAllForAE = (ae: string) => {
    const customers = filteredGroups[ae] || []
    const allSelected = customers.every(c => selectedCustomers.has(c))
    setSelectedCustomers(prev => {
      const next = new Set(prev)
      if (allSelected) {
        customers.forEach(c => next.delete(c))
      } else {
        customers.forEach(c => next.add(c))
      }
      return next
    })
  }

  const handleSelectAll = () => {
    const allVisible = Object.values(filteredGroups).flat()
    const allSelected = allVisible.every(c => selectedCustomers.has(c))
    if (allSelected) {
      setSelectedCustomers(new Set())
    } else {
      setSelectedCustomers(new Set(allVisible))
    }
  }

  const handleRun = () => {
    if (selectedCustomers.size === 0) return

    // For automated actions (campaigns, news), populate progress list with pending entries
    if (selectedAction === 'campaigns' || selectedAction === 'news') {
      const initialProgress: BatchProgress[] = Array.from(selectedCustomers).map(name => ({
        customerName: name,
        status: 'pending' as const,
      }))
      setProgress(initialProgress)
      setBatchRunning(true)
      // Actual execution API will be in #168
    }

    // For manual checklists (pitchbuilder, finlistics), they're handled by the checklist render
  }

  // PitchBuilder/FinListics checklist state (persisted in localStorage)
  const [checklistState, setChecklistState] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem(`batch-checklist-${selectedAction}`)
      return stored ? JSON.parse(stored) : {}
    } catch {
      return {}
    }
  })

  useEffect(() => {
    localStorage.setItem(`batch-checklist-${selectedAction}`, JSON.stringify(checklistState))
  }, [checklistState, selectedAction])

  const handleToggleChecklistItem = (customerName: string) => {
    setChecklistState(prev => ({
      ...prev,
      [customerName]: !prev[customerName]
    }))
  }

  const isAutomatedAction = selectedAction === 'campaigns' || selectedAction === 'news'
  const isChecklistAction = selectedAction === 'pitchbuilder' || selectedAction === 'finlistics'

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-bg">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Target className="w-6 h-6 text-accent" />
        <h1 className="text-2xl font-bold text-text-primary">Batch Operations</h1>
      </div>

      {/* Action Selector */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Select Action</h2>
        <div className="flex items-center gap-2">
          {(['campaigns', 'news', 'pitchbuilder', 'finlistics'] as const).map(action => (
            <button
              key={action}
              onClick={() => setSelectedAction(action)}
              className={`px-5 py-2 text-sm font-medium rounded-full border transition-colors ${
                selectedAction === action
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
              }`}
            >
              {action === 'campaigns' && 'Campaigns'}
              {action === 'news' && 'News Refresh'}
              {action === 'pitchbuilder' && 'PitchBuilder'}
              {action === 'finlistics' && 'FinListics'}
            </button>
          ))}
        </div>
      </div>

      {/* Customer Picker */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Select Customers</h2>
          <button
            onClick={handleSelectAll}
            className="text-xs text-accent hover:underline"
          >
            {Object.values(filteredGroups).flat().every(c => selectedCustomers.has(c))
              ? 'Deselect All'
              : 'Select All'}
          </button>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search customers..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 bg-bg border border-border rounded-lg text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {/* Grouped Customer List */}
        <div className="space-y-4 max-h-96 overflow-y-auto">
          {Object.entries(filteredGroups)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ae, customers]) => (
              <div key={ae} className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={customers.every(c => selectedCustomers.has(c))}
                    onChange={() => handleSelectAllForAE(ae)}
                    className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                  />
                  <span className="text-sm font-medium text-text-secondary">{ae}</span>
                  <span className="text-xs text-text-tertiary">
                    ({customers.filter(c => selectedCustomers.has(c)).length}/{customers.length})
                  </span>
                </div>
                <div className="ml-6 space-y-1">
                  {customers.map(customerName => (
                    <label key={customerName} className="flex items-center gap-2 cursor-pointer hover:bg-surface-hover p-1 rounded">
                      <input
                        type="checkbox"
                        checked={selectedCustomers.has(customerName)}
                        onChange={() => handleToggleCustomer(customerName)}
                        className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                      />
                      <span className="text-sm text-text-primary">{customerName}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
        </div>

        <div className="text-sm text-text-secondary">
          {selectedCustomers.size} customer{selectedCustomers.size !== 1 ? 's' : ''} selected
        </div>
      </div>

      {/* Config Area (placeholder for CampaignConfigurator) */}
      {selectedAction === 'campaigns' && (
        <div className="bg-surface border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-text-primary mb-3">Campaign Configuration</h2>
          <div className="text-sm text-text-secondary italic">
            Campaign configurator will be integrated here (separate issue)
          </div>
        </div>
      )}

      {/* Run Button */}
      {isAutomatedAction && (
        <button
          onClick={handleRun}
          disabled={selectedCustomers.size === 0 || batchRunning}
          className={`w-full py-3 rounded-lg font-medium transition-colors ${
            selectedCustomers.size === 0 || batchRunning
              ? 'bg-surface-hover text-text-tertiary cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent/90'
          }`}
        >
          {batchRunning ? 'Running...' : `Run ${selectedAction === 'campaigns' ? 'Campaigns' : 'News Refresh'}`}
        </button>
      )}

      {/* Progress Section (for automated actions) */}
      {isAutomatedAction && progress.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">Progress</h2>
          <div className="space-y-2">
            {progress.map((item, idx) => (
              <div key={idx} className="flex items-center gap-3 py-2">
                {/* Status indicator */}
                {item.status === 'pending' && <span className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />}
                {item.status === 'running' && (
                  <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                )}
                {item.status === 'done' && <span className="text-green-500 shrink-0">✓</span>}
                {item.status === 'failed' && <span className="text-red-500 shrink-0">✕</span>}

                {/* Customer name */}
                <span className="text-sm text-text-primary flex-1">{item.customerName}</span>

                {/* Drive link (for campaigns) */}
                {item.status === 'done' && item.driveUrl && (
                  <a
                    href={item.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline"
                  >
                    View ↗
                  </a>
                )}

                {/* Error message */}
                {item.status === 'failed' && item.error && (
                  <span className="text-xs text-critical">{item.error}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Checklist Section (for PitchBuilder/FinListics) */}
      {isChecklistAction && selectedCustomers.size > 0 && (
        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {selectedAction === 'pitchbuilder' ? 'PitchBuilder' : 'FinListics'} Checklist
          </h2>
          <div className="space-y-2">
            {Array.from(selectedCustomers)
              .sort()
              .map(customerName => (
                <label key={customerName} className="flex items-center gap-3 py-2 cursor-pointer hover:bg-surface-hover rounded px-2">
                  <input
                    type="checkbox"
                    checked={!!checklistState[customerName]}
                    onChange={() => handleToggleChecklistItem(customerName)}
                    className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                  />
                  <span className="text-sm text-text-primary flex-1">{customerName}</span>
                  <a
                    href={
                      selectedAction === 'pitchbuilder'
                        ? `/dashboard/customer/${encodeURIComponent(customerName)}?tool=pitchbuilder`
                        : `/dashboard/customer/${encodeURIComponent(customerName)}?tool=finlistics`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline"
                  >
                    Launch {selectedAction === 'pitchbuilder' ? 'PitchBuilder' : 'FinListics'} ↗
                  </a>
                </label>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
