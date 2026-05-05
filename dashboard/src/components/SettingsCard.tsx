import type { ReactNode } from 'react'
import { Loader2, Check } from 'lucide-react'

interface SettingsCardProps {
  title?: string
  error: string | null
  dirty: boolean
  saving: boolean
  saved: boolean
  onSave: () => void
  saveLabel?: string
  saveIcon?: ReactNode
  children: ReactNode
  /** Extra classes applied to the outer card div (e.g. override default space-y-4 with space-y-5). */
  className?: string
  /** Override the default "Saved" label shown after a successful save. */
  savedLabel?: string
}

const DEFAULT_CARD =
  'bg-surface rounded-xl p-5 border border-border space-y-4'

/**
 * Shared chrome for settings panels:
 *  - outer surface card
 *  - optional title
 *  - error message
 *  - save button with saving / saved / dirty states
 *
 * Panels supply only their form fields as children.
 */
export function SettingsCard({
  title,
  error,
  dirty,
  saving,
  saved,
  onSave,
  saveLabel = 'Save',
  savedLabel = 'Saved',
  saveIcon,
  children,
  className,
}: SettingsCardProps) {
  return (
    <div className={className ?? DEFAULT_CARD}>
      {title && <p className="text-sm font-medium text-text-primary">{title}</p>}
      {children}
      {error && <p className="text-xs text-critical">{error}</p>}
      <button
        onClick={onSave}
        disabled={!dirty || saving}
        className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : saved ? (
          <Check className="w-3.5 h-3.5" />
        ) : (
          saveIcon ?? null
        )}
        {saved ? savedLabel : saveLabel}
      </button>
    </div>
  )
}
