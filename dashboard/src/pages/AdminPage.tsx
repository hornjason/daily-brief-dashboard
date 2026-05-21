import { useNavigate } from 'react-router-dom'
import { SystemOverviewPanel } from '../components/admin/SystemOverviewPanel'
import { DataSourcesPanel } from '../components/admin/DataSourcesPanel'
import { OperationsPanel } from '../components/admin/OperationsPanel'
import { SettingsPanel } from '../components/admin/SettingsPanel'
import { useApi } from '../hooks/useApi'

export function AdminPage() {
  const navigate = useNavigate()
  const nodeRoleApi = useApi<{ isL3Only: boolean }>('/api/node-role')
  const isL3Only = nodeRoleApi.data?.isL3Only ?? true

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold text-gray-100">System Health Dashboard</h1>
            <button
              onClick={() => navigate('/dashboard/setup')}
              className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              ← Back to Setup
            </button>
          </div>
          {!isL3Only && (
            <div className="mt-2 bg-red-900/50 border border-red-700/60 rounded-md px-4 py-2.5 text-xs text-red-300">
              <span className="font-semibold">Break-glass page.</span> Manual scrape triggers may take several
              minutes and require an active Red Hat Portal session. Not for normal use.
            </div>
          )}
        </div>

        {/* System Overview Panel — GitHub Issue #340 */}
        <SystemOverviewPanel />

        {/* Data Sources Panel — GitHub Issue #341 */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Data Sources</h2>
          <p className="text-xs text-gray-500 mb-3">Where your customer data comes from — refresh individual sources or check when data was last updated</p>
          <DataSourcesPanel />
        </div>

        {/* Operations Panel — GitHub Issue #342 */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Operations</h2>
          <p className="text-xs text-gray-500 mb-3">System activity — scraper health, AI usage, and cache management</p>
          <OperationsPanel />
        </div>

        {/* Settings Panel — GitHub Issue #343 */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Settings</h2>
          <p className="text-xs text-gray-500 mb-3">Configure automation, AI features, and data backup</p>
          <SettingsPanel />
        </div>
      </div>
    </div>
  )
}
