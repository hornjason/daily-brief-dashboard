import { useEffect, useCallback } from 'react'
import { X, Download, ExternalLink } from 'lucide-react'
import { formatRelTime } from '../lib/format'
import { renderMarkdown } from '../lib/render-markdown'

interface MarkdownPreviewModalProps {
  open: boolean
  onClose: () => void
  title: string
  markdown: string
  generatedAt: string
  driveUrl?: string
  onDownload?: () => void
}

export function MarkdownPreviewModal({
  open,
  onClose,
  title,
  markdown,
  generatedAt,
  driveUrl,
  onDownload,
}: MarkdownPreviewModalProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, handleKeyDown])

  if (!open) return null

  const renderedHtml = renderMarkdown(markdown)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-enter" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70" />
      <div
        className="relative w-full max-w-4xl max-h-[90vh] bg-surface border border-border rounded-modal shadow-2xl modal-enter flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary truncate">{title}</h2>
              <p className="text-[10px] text-text-secondary">
                Generated {formatRelTime(generatedAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {driveUrl && (
              <a
                href={driveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded text-text-secondary hover:text-accent hover:bg-surface-hover transition-colors"
                title="Open in Google Docs"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            {onDownload && (
              <button
                onClick={onDownload}
                className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                title="Download markdown"
              >
                <Download className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
              aria-label="Close modal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div
          className="flex-1 overflow-y-auto px-6 py-5"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      </div>
    </div>
  )
}
