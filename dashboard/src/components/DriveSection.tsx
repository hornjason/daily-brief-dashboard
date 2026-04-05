import { FileText, ExternalLink } from 'lucide-react'

// ── Helpers ──────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-border/40 rounded animate-pulse-slow ${className}`} />
}

function mimeLabel(mimeType: string): string {
  const m: Record<string, string> = {
    'application/vnd.google-apps.document': 'Doc',
    'application/vnd.google-apps.spreadsheet': 'Sheet',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/pdf': 'PDF',
  }
  return m[mimeType] ?? 'File'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── DriveSection ──────────────────────────────────────────────────────────────

export function DriveSection({ files, loading }: { files: any[]; loading: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <FileText className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Drive Documents</h2>
        {!loading && <span className="text-xs text-text-secondary">{files.length} recent</span>}
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}
        </div>
      )}

      {!loading && files.length === 0 && (
        <p className="text-sm text-text-secondary italic py-1">No documents in last 90 days</p>
      )}

      {!loading && files.length > 0 && (
        <div className="space-y-1">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <span className="text-xs font-medium text-text-secondary bg-border/40 px-1.5 py-0.5 rounded shrink-0 w-10 text-center">
                {mimeLabel(f.mimeType)}
              </span>
              <div className="min-w-0 flex-1">
                {f.webViewLink ? (
                  <a
                    href={f.webViewLink?.startsWith('https://') ? f.webViewLink : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-text-primary hover:text-accent transition-colors flex items-center gap-1 truncate"
                  >
                    <span className="truncate">{f.name}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : (
                  <span className="text-xs text-text-primary truncate">{f.name}</span>
                )}
              </div>
              {f.modifiedTime && (
                <span className="text-xs text-text-secondary shrink-0">{formatDate(f.modifiedTime)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
