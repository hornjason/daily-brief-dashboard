import { useState, useEffect } from 'react'
import { X, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react'

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
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

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
      .catch(() => {})
  }, [])

  const handleDismiss = () => {
    if (!updateInfo) return
    localStorage.setItem(DISMISS_KEY, JSON.stringify({
      version: updateInfo.latestVersion,
      timestamp: Date.now(),
    }))
    setDismissed(true)
  }

  const upgradeCommand = updateInfo
    ? `curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/upgrade.sh -o upgrade.sh && bash upgrade.sh --version=${updateInfo.latestVersion}`
    : ''

  const handleCopy = async () => {
    await navigator.clipboard.writeText(upgradeCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!updateInfo || !updateInfo.updateAvailable || dismissed) {
    return null
  }

  return (
    <div data-testid="update-banner">
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
        <button
          data-testid="upgrade-toggle"
          onClick={() => setExpanded(!expanded)}
          className="text-amber-300 hover:text-amber-200 text-xs flex items-center gap-1 transition-colors"
        >
          Upgrade {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        <div className="flex-1" />
        <button
          onClick={handleDismiss}
          className="text-amber-400 hover:text-amber-300 transition-colors"
          aria-label="Dismiss update notification"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {expanded && (
        <div
          data-testid="upgrade-instructions"
          className="bg-amber-900/30 border-b border-amber-700/50 px-6 py-3"
        >
          <p className="text-amber-300 text-xs mb-2">Run this command to upgrade:</p>
          <div className="relative border border-amber-700/30 rounded bg-black/40 px-4 py-3 pr-12 font-mono text-xs text-amber-200 break-all">
            {upgradeCommand}
            <button
              data-testid="copy-upgrade-cmd"
              onClick={handleCopy}
              className="absolute top-2 right-2 text-amber-400 hover:text-amber-200 transition-colors"
              aria-label="Copy upgrade command"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-amber-400/70 text-xs mt-2">
            Your data and settings are preserved — only the application code updates.
          </p>
        </div>
      )}
    </div>
  )
}
