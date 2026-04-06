/**
 * ProductSourcesAdmin — Admin section for managing product intelligence custom sources.
 *
 * Allows Jason to add/remove custom URLs and toggle followLinks for each product
 * without editing JSON files directly.
 */

import { useState, useEffect } from 'react'

interface ProductConfig {
  slug: string
  displayName: string
  shortName: string
  followLinks: boolean
  customSources: string[]
}

interface ProductCardProps {
  product: ProductConfig
  onUpdate: (slug: string, patch: { customSources?: string[]; followLinks?: boolean }) => Promise<string | null>
}

function ProductCard({ product, onUpdate }: ProductCardProps) {
  const [sources, setSources] = useState<string[]>(product.customSources)
  const [followLinks, setFollowLinks] = useState(product.followLinks)
  const [newUrl, setNewUrl] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Keep local state in sync if parent re-fetches
  useEffect(() => {
    setSources(product.customSources)
    setFollowLinks(product.followLinks)
  }, [product])

  const patch = async (nextSources: string[], nextFollowLinks: boolean) => {
    setSaving(true)
    setSaveError(null)
    const err = await onUpdate(product.slug, {
      customSources: nextSources,
      followLinks: nextFollowLinks,
    })
    setSaving(false)
    if (err) setSaveError(err)
  }

  const handleAddUrl = async () => {
    setUrlError(null)
    const trimmed = newUrl.trim()
    if (!trimmed) return
    if (!trimmed.startsWith('https://')) {
      setUrlError('URL must start with https://')
      return
    }
    if (sources.includes(trimmed)) {
      setUrlError('URL already added')
      return
    }
    const nextSources = [...sources, trimmed]
    setSources(nextSources)
    setNewUrl('')
    await patch(nextSources, followLinks)
  }

  const handleRemove = async (url: string) => {
    const nextSources = sources.filter(s => s !== url)
    setSources(nextSources)
    await patch(nextSources, followLinks)
  }

  const handleFollowLinksToggle = async (checked: boolean) => {
    setFollowLinks(checked)
    await patch(sources, checked)
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
      {/* Card header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-200">{product.shortName}</span>
        {saving && <span className="text-xs text-gray-500">Saving...</span>}
        {saveError && !saving && <span className="text-xs text-red-400 truncate max-w-[200px]" title={saveError}>{saveError}</span>}
      </div>

      {/* Follow links toggle */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={followLinks}
          disabled={saving}
          onChange={e => handleFollowLinksToggle(e.target.checked)}
          className="rounded border-gray-600 bg-gray-700 text-red-600 focus:ring-0 focus:ring-offset-0 disabled:opacity-50"
        />
        <span className="text-xs text-gray-400">Follow embedded .redhat.com links (slower)</span>
      </label>

      {/* Custom sources list */}
      <div className="space-y-1">
        {sources.length === 0 && (
          <p className="text-xs text-gray-500">No custom sources — add URLs below</p>
        )}
        {sources.map(url => (
          <div key={url} className="flex items-center gap-2 group">
            <span
              className="flex-1 text-xs text-gray-300 truncate min-w-0"
              title={url}
            >
              {url}
            </span>
            <button
              onClick={() => handleRemove(url)}
              disabled={saving}
              className="shrink-0 text-gray-600 hover:text-red-400 disabled:opacity-40 transition-colors text-xs font-medium"
              aria-label={`Remove ${url}`}
              title="Remove"
            >
              x
            </button>
          </div>
        ))}
      </div>

      {/* Add URL row */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="https://..."
            value={newUrl}
            onChange={e => { setNewUrl(e.target.value); setUrlError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') handleAddUrl() }}
            disabled={saving}
            className="flex-1 min-w-0 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-gray-400 disabled:opacity-50"
          />
          <button
            onClick={handleAddUrl}
            disabled={saving || !newUrl.trim()}
            className="shrink-0 px-2.5 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors"
          >
            Add
          </button>
        </div>
        {urlError && <p className="text-xs text-red-400">{urlError}</p>}
      </div>
    </div>
  )
}

export function ProductSourcesAdmin() {
  const [products, setProducts] = useState<ProductConfig[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/products/config')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ProductConfig[] = await res.json()
      setProducts(data)
    } catch (e: any) {
      setLoadError(e.message ?? 'Failed to load product config')
    }
  }

  useEffect(() => {
    loadConfig()
  }, [])

  const handleUpdate = async (
    slug: string,
    patch: { customSources?: string[]; followLinks?: boolean },
  ): Promise<string | null> => {
    try {
      const res = await fetch(`/api/products/${slug}/sources`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await res.json()
      if (!res.ok) return data.error ?? `HTTP ${res.status}`
      // Sync the updated product back into local state
      if (data.product) {
        setProducts(prev =>
          prev ? prev.map(p => (p.slug === slug ? { ...p, ...data.product } : p)) : prev,
        )
      }
      return null
    } catch (e: any) {
      return e.message ?? 'Save failed'
    }
  }

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
        Product Intelligence Sources
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Add URLs to enrich product summaries. Custom sources are fetched on every refresh.
      </p>

      {loadError && (
        <div className="text-xs text-red-400 mb-3">{loadError}</div>
      )}

      {products === null && !loadError && (
        <div className="text-xs text-gray-500">Loading...</div>
      )}

      {products !== null && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map(p => (
            <ProductCard key={p.slug} product={p} onUpdate={handleUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}
