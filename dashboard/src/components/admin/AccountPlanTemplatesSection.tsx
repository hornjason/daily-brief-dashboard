import { useState, useEffect } from 'react'
import { RefreshCw, FileText, Cloud, HardDrive } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

interface TemplateFile {
  name: string
  source: 'cache' | 'baked-in'
  size: number
  modifiedAt: string
}

interface TemplateStatus {
  files: TemplateFile[]
  cacheDir: string
  bakedDir: string
  manifest: {
    version: string
    lastUpdated: string
    templatesFolderId: string | null
  }
}

export function AccountPlanTemplatesSection() {
  const [status, setStatus] = useState<TemplateStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = () => {
    fetch('/api/account-plan-templates/status')
      .then(r => r.json())
      .then(d => setStatus(d))
      .catch(() => setError('Failed to load template status'))
  }

  useEffect(() => { loadStatus() }, [])

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    setSyncResult(null)
    try {
      const res = await fetch('/api/account-plan-templates/sync', { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setSyncResult(`Synced ${data.synced} template(s)`)
        loadStatus()
      } else {
        setError(data.error || 'Sync failed')
      }
    } catch (e: any) {
      setError(e.message || 'Network error')
    } finally {
      setSyncing(false)
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className="mt-4 space-y-4">
      {/* Header with sync button */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-200">Account Plan Templates</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Templates used for AI-powered account plan generation. Sync from Google Drive to update.
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : 'Sync from Drive'}
        </button>
      </div>

      {/* Status messages */}
      {syncResult && (
        <div className="text-xs text-green-400 bg-green-900/20 border border-green-800/30 rounded px-3 py-2">
          {syncResult}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Manifest info */}
      {status?.manifest && (
        <div className="text-xs text-gray-400 space-y-1">
          <div>Version: <span className="text-gray-300">{status.manifest.version}</span></div>
          {status.manifest.lastUpdated && (
            <div>Last updated: <span className="text-gray-300">{formatRelTime(status.manifest.lastUpdated)}</span></div>
          )}
          {status.manifest.templatesFolderId && (
            <div className="flex items-center gap-1">
              <Cloud className="w-3 h-3" />
              <span>Drive folder linked</span>
            </div>
          )}
        </div>
      )}

      {/* File list */}
      {status?.files && status.files.length > 0 && (
        <div className="border border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-800/50 text-gray-400">
                <th className="text-left px-3 py-2 font-medium">File</th>
                <th className="text-left px-3 py-2 font-medium">Source</th>
                <th className="text-right px-3 py-2 font-medium">Size</th>
                <th className="text-right px-3 py-2 font-medium">Modified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {status.files.map(f => (
                <tr key={f.name} className="hover:bg-gray-800/30">
                  <td className="px-3 py-2 text-gray-200 flex items-center gap-1.5">
                    <FileText className="w-3 h-3 text-gray-500" />
                    {f.name}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      f.source === 'cache'
                        ? 'bg-blue-900/30 text-blue-400 border border-blue-800/30'
                        : 'bg-gray-700/50 text-gray-400 border border-gray-600/30'
                    }`}>
                      {f.source === 'cache' ? <Cloud className="w-2.5 h-2.5" /> : <HardDrive className="w-2.5 h-2.5" />}
                      {f.source === 'cache' ? 'Drive cache' : 'Built-in'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400 tabular-nums">{formatSize(f.size)}</td>
                  <td className="px-3 py-2 text-right text-gray-400">{formatRelTime(f.modifiedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status?.files && status.files.length === 0 && (
        <div className="text-xs text-gray-500 text-center py-4">
          No template files found. Sync from Drive to download templates.
        </div>
      )}
    </div>
  )
}
