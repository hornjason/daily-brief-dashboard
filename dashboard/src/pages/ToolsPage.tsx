/**
 * ToolsPage — Module page for business value tools
 * GitHub Issue #241
 *
 * Wraps ToolsTab content in ModulePageShell.
 * Scope: 'customer' — CustomerPicker required, no content until selected
 * Route: /dashboard/tools
 */

import { ModulePageShell, useModulePage } from '../components/ModulePageShell'
import { ToolsTab } from '../components/tabs/ToolsTab'
import { Wrench } from 'lucide-react'

function ToolsContent() {
  const { customer } = useModulePage()

  if (!customer) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 max-w-md">
          <Wrench className="w-12 h-12 text-text-secondary mx-auto" />
          <p className="text-sm text-text-secondary">
            Select a customer to access business value tools.
          </p>
        </div>
      </div>
    )
  }

  return <ToolsTab customerName={customer} />
}

export function ToolsPage() {
  return (
    <ModulePageShell
      title="Business Value Tools"
      icon="Wrench"
      scope="customer"
    >
      <ToolsContent />
    </ModulePageShell>
  )
}
