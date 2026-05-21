import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Plus, X, Trash2 } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface RSSFeed {
  url: string
  label: string
  category: string
  productTags: string[]
  enabled: boolean
}

// ── RSS Feeds Management Section ──────────────────────────────────────────────

export function RSSFeedsManagementSection() {
  const [feeds, setFeeds] = useState<RSSFeed[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null)
  const [togglingUrl, setTogglingUrl] = useState<string | null>(null)

  // New feed form state
  const [newFeedUrl, setNewFeedUrl] = useState('')
  const [newFeedLabel, setNewFeedLabel] = useState('')
  const [newFeedCategory, setNewFeedCategory] = useState('')
  const [newFeedTags, setNewFeedTags] = useState('')
  const [adding, setAdding] = useState(false)

  const loadFeeds = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/rss-feeds')
      if (res.ok) {
        const data = await res.json()
        setFeeds(data.feeds)
      }
    } catch (err) {
      console.error('Failed to load RSS feeds:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadFeeds()
  }, [loadFeeds])

  const handleToggleEnabled = async (feed: RSSFeed) => {
    setTogglingUrl(feed.url)
    try {
      const res = await fetch('/api/admin/rss-feeds', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: feed.url, enabled: !feed.enabled }),
      })
      if (res.ok) {
        await loadFeeds()
      }
    } catch (err) {
      console.error('Failed to toggle feed:', err)
    } finally {
      setTogglingUrl(null)
    }
  }

  const handleDelete = async (url: string) => {
    if (!confirm('Are you sure you want to delete this RSS feed?')) return

    setDeletingUrl(url)
    try {
      const res = await fetch('/api/admin/rss-feeds', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (res.ok) {
        await loadFeeds()
      }
    } catch (err) {
      console.error('Failed to delete feed:', err)
    } finally {
      setDeletingUrl(null)
    }
  }

  const handleRefreshAll = async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/admin/rss-feeds/refresh', { method: 'POST' })
      if (!res.ok) {
        console.error('Failed to refresh RSS feeds')
      }
    } catch (err) {
      console.error('Failed to refresh RSS feeds:', err)
    } finally {
      setTimeout(() => setRefreshing(false), 2000)
    }
  }

  const handleAddFeed = async () => {
    if (!newFeedUrl.trim() || !newFeedLabel.trim()) return

    setAdding(true)
    try {
      const res = await fetch('/api/admin/rss-feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newFeedUrl.trim(),
          label: newFeedLabel.trim(),
          category: newFeedCategory.trim() || 'general',
          productTags: newFeedTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      })
      if (res.ok) {
        setNewFeedUrl('')
        setNewFeedLabel('')
        setNewFeedCategory('')
        setNewFeedTags('')
        setShowAddForm(false)
        await loadFeeds()
      }
    } catch (err) {
      console.error('Failed to add feed:', err)
    } finally {
      setAdding(false)
    }
  }

  const enabledCount = feeds.filter((f) => f.enabled).length
  const disabledCount = feeds.length - enabledCount

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">RSS Feeds</h2>
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-4">
        {/* Summary + Actions */}
        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-400">
            {feeds.length} feed{feeds.length !== 1 ? 's' : ''} ({enabledCount} enabled, {disabledCount} disabled)
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefreshAll}
              disabled={refreshing || feeds.length === 0}
              className="px-2.5 py-1 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white transition-colors flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>Refresh All</span>
            </button>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="px-2.5 py-1 text-xs font-medium rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors flex items-center gap-1.5"
            >
              {showAddForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              <span>{showAddForm ? 'Cancel' : 'Add Feed'}</span>
            </button>
          </div>
        </div>

        {/* Add Form */}
        {showAddForm && (
          <div className="bg-gray-900/50 border border-gray-600 rounded p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Feed URL *</label>
                <input
                  type="url"
                  value={newFeedUrl}
                  onChange={(e) => setNewFeedUrl(e.target.value)}
                  placeholder="https://example.com/feed.xml"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Label *</label>
                <input
                  type="text"
                  value={newFeedLabel}
                  onChange={(e) => setNewFeedLabel(e.target.value)}
                  placeholder="Red Hat Blog"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Category</label>
                <input
                  type="text"
                  value={newFeedCategory}
                  onChange={(e) => setNewFeedCategory(e.target.value)}
                  placeholder="blog"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Product Tags (comma-separated)</label>
                <input
                  type="text"
                  value={newFeedTags}
                  onChange={(e) => setNewFeedTags(e.target.value)}
                  placeholder="rhel, openshift, ansible"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleAddFeed}
                disabled={adding || !newFeedUrl.trim() || !newFeedLabel.trim()}
                className="px-3 py-1.5 text-xs font-medium rounded bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white transition-colors"
              >
                {adding ? 'Adding...' : 'Add Feed'}
              </button>
            </div>
          </div>
        )}

        {/* Feeds Table */}
        {loading ? (
          <div className="text-xs text-gray-500">Loading...</div>
        ) : feeds.length === 0 ? (
          <div className="text-xs text-gray-500">No RSS feeds configured</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="text-left py-2 pr-4">Label</th>
                  <th className="text-left py-2 pr-4">Category</th>
                  <th className="text-left py-2 pr-4">URL</th>
                  <th className="text-left py-2 pr-4">Tags</th>
                  <th className="text-center py-2 pr-4">Status</th>
                  <th className="text-right py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {feeds.map((feed) => (
                  <tr key={feed.url} className="border-b border-gray-700 text-gray-300">
                    <td className="py-2 pr-4">{feed.label}</td>
                    <td className="py-2 pr-4">
                      <span className="inline-block px-2 py-0.5 rounded bg-gray-700 text-gray-300">
                        {feed.category}
                      </span>
                    </td>
                    <td className="py-2 pr-4 truncate max-w-[200px]" title={feed.url}>
                      {feed.url}
                    </td>
                    <td className="py-2 pr-4">
                      {feed.productTags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {feed.productTags.map((tag) => (
                            <span key={tag} className="inline-block px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 text-[10px]">
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-center">
                      <button
                        onClick={() => handleToggleEnabled(feed)}
                        disabled={togglingUrl === feed.url}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                          feed.enabled
                            ? 'bg-green-900/40 text-green-300 hover:bg-green-900/60'
                            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                        } ${togglingUrl === feed.url ? 'opacity-50' : ''}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${feed.enabled ? 'bg-green-400' : 'bg-gray-500'}`} />
                        {feed.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => handleDelete(feed.url)}
                        disabled={deletingUrl === feed.url}
                        aria-label={`Delete ${feed.label}`}
                        className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-red-700 disabled:opacity-40 text-white transition-colors inline-flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        {deletingUrl === feed.url ? 'Deleting...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
