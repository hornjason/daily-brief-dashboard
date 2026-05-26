import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, Check, X, FileText, Globe, Mail, Rss } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

interface DocumentSource {
  id: string
  name: string
  type: string
  identifier: string
  configKey?: string
  lastFetched?: string | null
  status: 'ok' | 'error' | 'pending' | 'stale'
  error?: string
}

const TYPE_ICONS: Record<string, typeof FileText> = {
  'google-slides': FileText,
  'google-doc': FileText,
  'google-drive-folder': FileText,
  'url': Globe,
  'email': Mail,
  'rss': Rss,
}

const TYPE_LABELS: Record<string, string> = {
  'google-slides': 'Google Slides',
  'google-doc': 'Google Doc',
  'google-drive-folder': 'Drive Folder',
  'url': 'URL',
  'email': 'Email Query',
  'rss': 'RSS Feed',
}

const STATUS_COLORS: Record<string, string> = {
  ok: 'text-green-400',
  error: 'text-red-400',
  pending: 'text-yellow-400',
  stale: 'text-orange-400',
}

const TYPE_HELPER_TEXT: Record<string, string> = {
  'google-slides': 'Share a presentation or document to include in intelligence analysis',
  'google-doc': 'Share a Google Doc to include in intelligence analysis',
  'google-drive-folder': 'Monitor a folder for new documents about this customer',
  'url': 'Scan a web page for relevant content',
  'email': 'Track emails matching a search query',
  'rss': 'Subscribe to an industry or customer news feed',
}

function AddSourceForm({ onAdd, onCancel }: { onAdd: (s: Partial<DocumentSource>) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('url')
  const [identifier, setIdentifier] = useState('')

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-600 space-y-3">
      <div className="text-sm font-medium text-gray-200">Add Document Source</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input
          type="text"
          placeholder="Name"
          value={name}
          onChange={e => setName(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500"
        />
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200"
        >
          {Object.entries(TYPE_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="ID, URL, or query"
          value={identifier}
          onChange={e => setIdentifier(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500"
        />
      </div>
      {TYPE_HELPER_TEXT[type] && (
        <p className="text-xs text-gray-500" data-testid="doc-source-type-helper">
          {TYPE_HELPER_TEXT[type]}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300">
          Cancel
        </button>
        <button
          onClick={() => { if (name && identifier) onAdd({ name, type, identifier }) }}
          disabled={!name || !identifier}
          className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white"
        >
          Add Source
        </button>
      </div>
    </div>
  )
}

function SourceRow({
  source,
  onEdit,
  onDelete,
}: {
  source: DocumentSource
  onEdit: (id: string, updates: Partial<DocumentSource>) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editId, setEditId] = useState(source.identifier)
  const Icon = TYPE_ICONS[source.type] ?? FileText

  if (editing) {
    return (
      <tr className="border-b border-gray-700">
        <td className="px-3 py-2 text-sm text-gray-200">{source.name}</td>
        <td className="px-3 py-2 text-xs text-gray-400">{TYPE_LABELS[source.type] ?? source.type}</td>
        <td className="px-3 py-2">
          <input
            value={editId}
            onChange={e => setEditId(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 w-full"
          />
        </td>
        <td className="px-3 py-2 text-xs text-gray-400">{source.lastFetched ? formatRelTime(source.lastFetched) : 'Never'}</td>
        <td className="px-3 py-2">
          <span className={`text-xs ${STATUS_COLORS[source.status] ?? 'text-gray-400'}`}>{source.status}</span>
        </td>
        <td className="px-3 py-2 text-right">
          <button onClick={() => { onEdit(source.id, { identifier: editId }); setEditing(false) }} className="text-green-400 hover:text-green-300 mr-2">
            <Check className="w-3.5 h-3.5 inline" />
          </button>
          <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-300">
            <X className="w-3.5 h-3.5 inline" />
          </button>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b border-gray-700 hover:bg-gray-800/50">
      <td className="px-3 py-2 text-sm text-gray-200 flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        {source.name}
      </td>
      <td className="px-3 py-2 text-xs text-gray-400">{TYPE_LABELS[source.type] ?? source.type}</td>
      <td className="px-3 py-2 text-xs text-gray-400 truncate max-w-[200px]" title={source.identifier}>{source.identifier}</td>
      <td className="px-3 py-2 text-xs text-gray-400">{source.lastFetched ? formatRelTime(source.lastFetched) : 'Never'}</td>
      <td className="px-3 py-2">
        <span className={`text-xs ${STATUS_COLORS[source.status] ?? 'text-gray-400'}`}>{source.status}</span>
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <button onClick={() => setEditing(true)} className="text-gray-400 hover:text-gray-200 mr-2" aria-label={`Edit ${source.name}`}>
          <Pencil className="w-3.5 h-3.5 inline" />
        </button>
        <button onClick={() => onDelete(source.id)} className="text-gray-400 hover:text-red-400" aria-label={`Remove ${source.name}`}>
          <Trash2 className="w-3.5 h-3.5 inline" />
        </button>
      </td>
    </tr>
  )
}

export function DocumentSourcesPanel() {
  const [sources, setSources] = useState<DocumentSource[]>([])
  const [adding, setAdding] = useState(false)

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/document-sources')
      if (res.ok) {
        const data = await res.json()
        setSources(data.sources ?? [])
      }
    } catch (err) {
      console.error('Failed to load document sources:', err)
    }
  }, [])

  useEffect(() => { loadSources() }, [loadSources])

  const handleAdd = async (s: Partial<DocumentSource>) => {
    try {
      const res = await fetch('/api/admin/document-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      })
      if (res.ok) {
        setAdding(false)
        await loadSources()
      }
    } catch (err) {
      console.error('Failed to add source:', err)
    }
  }

  const handleEdit = async (id: string, updates: Partial<DocumentSource>) => {
    try {
      await fetch(`/api/admin/document-sources/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      await loadSources()
    } catch (err) {
      console.error('Failed to update source:', err)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/admin/document-sources/${id}`, { method: 'DELETE' })
      await loadSources()
    } catch (err) {
      console.error('Failed to delete source:', err)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500" data-testid="doc-sources-purpose">
        Document sources enrich customer intelligence. Added sources are scanned periodically
        and their content feeds into account briefs, meeting prep, and campaign generation.
        Add Google Drive folders with customer-specific documents, URLs to relevant industry
        content, or email queries to track customer communications.
      </p>

      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm text-gray-400">{sources.length} configured source{sources.length !== 1 ? 's' : ''}</span>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Source
        </button>
      </div>

      {adding && <AddSourceForm onAdd={handleAdd} onCancel={() => setAdding(false)} />}

      {sources.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Source</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">ID / URL</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Last Fetched</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(s => (
                <SourceRow key={s.id} source={s} onEdit={handleEdit} onDelete={handleDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sources.length === 0 && !adding && (
        <div className="text-center py-8 text-gray-500 text-sm">
          No document sources configured. Click "Add Source" to get started.
        </div>
      )}
    </div>
  )
}
