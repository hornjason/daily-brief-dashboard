import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Plus, X, Trash2, ChevronDown, ChevronRight, ExternalLink, Edit2, Save, XCircle } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

interface RSSFeed {
  url: string
  label: string
  category: string
  productTags: string[]
  enabled: boolean
  source: string
}

interface FeedStats {
  articleCount: number
  lastArticleDate: string | null
}

interface EditingFeed {
  url: string
  label: string
  category: string
  productTags: string[]
}

// ── Collapsible Section ────────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? `Collapse ${title} section` : `Expand ${title} section`}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-700/50 transition-colors"
      >
        <span className="text-sm font-medium text-gray-200">{title}</span>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-400" />
        )}
      </button>
      {isOpen && <div className="px-4 pb-4 border-t border-gray-700 pt-4">{children}</div>}
    </div>
  )
}

// ── RSS Feeds Management Section ──────────────────────────────────────────────

export function RSSFeedsManagementSection() {
  const [feeds, setFeeds] = useState<RSSFeed[]>([])
  const [stats, setStats] = useState<Record<string, FeedStats>>({})
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null)
  const [togglingUrl, setTogglingUrl] = useState<string | null>(null)
  const [editingFeed, setEditingFeed] = useState<EditingFeed | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

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

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/rss-feeds/stats')
      if (res.ok) {
        const data = await res.json()
        setStats(data.stats ?? {})
      }
    } catch (err) {
      console.error('Failed to load RSS stats:', err)
    }
  }, [])

  useEffect(() => {
    loadFeeds()
    loadStats()
  }, [loadFeeds, loadStats])

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

  const handleTryFeed = (url: string) => {
    window.open(`/api/admin/rss-feeds/preview?url=${encodeURIComponent(url)}`, '_blank')
  }

  const handleEditFeed = (feed: RSSFeed) => {
    setEditingFeed({
      url: feed.url,
      label: feed.label,
      category: feed.category,
      productTags: [...feed.productTags],
    })
  }

  const handleCancelEdit = () => {
    setEditingFeed(null)
  }

  const handleSaveEdit = async (originalUrl: string) => {
    if (!editingFeed) return

    setSavingEdit(true)
    try {
      const res = await fetch('/api/admin/rss-feeds', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: originalUrl,
          label: editingFeed.label,
          category: editingFeed.category,
          productTags: editingFeed.productTags,
          newUrl: editingFeed.url !== originalUrl ? editingFeed.url : undefined,
        }),
      })
      if (res.ok) {
        setEditingFeed(null)
        await loadFeeds()
      }
    } catch (err) {
      console.error('Failed to save feed edits:', err)
    } finally {
      setSavingEdit(false)
    }
  }

  const enabledCount = feeds.filter((f) => f.enabled).length
  const disabledCount = feeds.length - enabledCount

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">RSS Feeds</h2>
      <CollapsibleSection title={`RSS Feeds (${feeds.length})`} defaultOpen={false}>
        <div className="space-y-4">
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
                  <th className="text-center py-2 pr-4">Articles</th>
                  <th className="text-center py-2 pr-4">Latest</th>
                  <th className="text-center py-2 pr-4">Status</th>
                  <th className="text-right py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {feeds.map((feed) => {
                  const isEditing = editingFeed?.url === feed.url
                  const feedStats = stats[feed.source]

                  return (
                    <tr key={feed.url} className="border-b border-gray-700 text-gray-300">
                      {/* Label */}
                      <td className="py-2 pr-4">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editingFeed.label}
                            onChange={(e) => setEditingFeed({ ...editingFeed, label: e.target.value })}
                            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                          />
                        ) : (
                          feed.label
                        )}
                      </td>

                      {/* Category */}
                      <td className="py-2 pr-4">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editingFeed.category}
                            onChange={(e) => setEditingFeed({ ...editingFeed, category: e.target.value })}
                            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                          />
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded bg-gray-700 text-gray-300">
                            {feed.category}
                          </span>
                        )}
                      </td>

                      {/* URL */}
                      <td className="py-2 pr-4">
                        {isEditing ? (
                          <input
                            type="url"
                            value={editingFeed.url}
                            onChange={(e) => setEditingFeed({ ...editingFeed, url: e.target.value })}
                            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                          />
                        ) : (
                          <span className="truncate max-w-[200px] block" title={feed.url}>
                            {feed.url}
                          </span>
                        )}
                      </td>

                      {/* Tags */}
                      <td className="py-2 pr-4">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editingFeed.productTags.join(', ')}
                            onChange={(e) =>
                              setEditingFeed({
                                ...editingFeed,
                                productTags: e.target.value
                                  .split(',')
                                  .map((t) => t.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="rhel, openshift, ansible"
                            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
                          />
                        ) : feed.productTags.length > 0 ? (
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

                      {/* Article Count */}
                      <td className="py-2 pr-4 text-center text-gray-400">
                        {feedStats?.articleCount ?? '—'}
                      </td>

                      {/* Latest Article Date */}
                      <td className="py-2 pr-4 text-center text-gray-400">
                        {feedStats?.lastArticleDate ? formatRelTime(feedStats.lastArticleDate) : '—'}
                      </td>

                      {/* Status */}
                      <td className="py-2 pr-4 text-center">
                        <button
                          onClick={() => handleToggleEnabled(feed)}
                          disabled={togglingUrl === feed.url || isEditing}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                            feed.enabled
                              ? 'bg-green-900/40 text-green-300 hover:bg-green-900/60'
                              : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                          } ${togglingUrl === feed.url || isEditing ? 'opacity-50' : ''}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${feed.enabled ? 'bg-green-400' : 'bg-gray-500'}`} />
                          {feed.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                      </td>

                      {/* Actions */}
                      <td className="py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {isEditing ? (
                            <>
                              <button
                                onClick={() => handleSaveEdit(feed.url)}
                                disabled={savingEdit}
                                aria-label="Save changes"
                                className="px-2 py-1 text-xs rounded bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white transition-colors inline-flex items-center gap-1"
                              >
                                <Save className="w-3 h-3" />
                                {savingEdit ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                disabled={savingEdit}
                                aria-label="Cancel editing"
                                className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors inline-flex items-center gap-1"
                              >
                                <XCircle className="w-3 h-3" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => handleTryFeed(feed.url)}
                                aria-label={`Preview ${feed.label}`}
                                className="px-2 py-1 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors inline-flex items-center gap-1"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Try
                              </button>
                              <button
                                onClick={() => handleEditFeed(feed)}
                                aria-label={`Edit ${feed.label}`}
                                className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors inline-flex items-center gap-1"
                              >
                                <Edit2 className="w-3 h-3" />
                                Edit
                              </button>
                              <button
                                onClick={() => handleDelete(feed.url)}
                                disabled={deletingUrl === feed.url}
                                aria-label={`Delete ${feed.label}`}
                                className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-red-700 disabled:opacity-40 text-white transition-colors inline-flex items-center gap-1"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </CollapsibleSection>
    </div>
  )
}
