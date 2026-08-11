/**
 * Update notification banner (GitHub issue #73)
 *
 * Shows an amber banner when a new version is available.
 * Dismissal stored in localStorage, expires after 7 days.
 */
import { useState, useEffect } from 'react'
import { X } from 'lucide-react'

interface UpdateInfo {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
}

const DISMISS_KEY = 'update-banner-dismissed'
const DISMISS_EXPIRY_DAYS = 7

export function UpdateBanner() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    fetch('/api/updates/check')
      .then(res => res.json())
      .then((data: UpdateInfo) => {
        setUpdateInfo(data)

        const dismissedData = localStorage.getItem(DISMISS_KEY)
        if (dismissedData) {
          try {
            const { version, timestamp } = JSON.parse(dismissedData)
            const now = Date.now()
            const expiryMs = DISMISS_EXPIRY_DAYS * 24 * 60 * 60 * 1000
            if (version === data.latestVersion && timestamp && (now - timestamp) < expiryMs) {
              setDismissed(true)
            }
          } catch {
            localStorage.removeItem(DISMISS_KEY)
          }
        }
      })
      .catch(() => {
        // Silently fail - no banner if check fails
      })
  }, [])

  const handleDismiss = () => {
    if (!updateInfo) return

    // Store dismissal with version and timestamp
    localStorage.setItem(DISMISS_KEY, JSON.stringify({
      version: updateInfo.latestVersion,
      timestamp: Date.now(),
    }))

    setDismissed(true)
  }

  // Don't render if no update, already dismissed, or still loading
  if (!updateInfo || !updateInfo.updateAvailable || dismissed) {
    return null
  }

  return (
    <div className="bg-amber-900/40 border-b border-amber-700/50 px-6 py-2.5 flex items-center gap-3 text-sm">
      <span className="text-amber-400 font-medium shrink-0">
        New version available: {updateInfo.currentVersion} → {updateInfo.latestVersion}
      </span>
      <a
        href={updateInfo.releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-amber-300 hover:text-amber-200 underline text-xs"
      >
        View Release Notes
      </a>
      <div className="flex-1" />
      <button
        onClick={handleDismiss}
        className="text-amber-400 hover:text-amber-300 transition-colors"
        aria-label="Dismiss update notification"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
