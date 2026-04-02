import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  icon?: LucideIcon
  subtitle?: string
  maxWidth?: string
  children: React.ReactNode
}

export default function Modal({ open, onClose, title, icon: Icon, subtitle, maxWidth = 'max-w-lg', children }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-enter" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className={`relative w-full ${maxWidth} bg-surface border border-border rounded-modal shadow-2xl modal-enter`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            {Icon && <Icon className="w-4 h-4 text-accent" />}
            <div>
              <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
              {subtitle && <p className="text-xs text-text-secondary">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors" aria-label="Close modal">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}
