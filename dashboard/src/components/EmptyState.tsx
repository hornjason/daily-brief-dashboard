import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

export default function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
      <Icon className="w-8 h-8 text-text-secondary/40 mb-3" />
      <p className="text-sm text-text-secondary font-medium">{title}</p>
      {description && <p className="text-xs text-text-secondary mt-1">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="mt-3 px-3 py-1.5 text-xs border border-border rounded-badge text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
          {action.label}
        </button>
      )}
    </div>
  )
}
