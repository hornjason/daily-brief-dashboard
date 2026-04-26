import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, Lock, XCircle } from 'lucide-react'

/**
 * Bootstrap configuration block — region + territory sheet + POD selector + auto-filled SF Report ID.
 *
 * BKL-ARCH-01: Region selector renders only when more than one region is
 * configured. Single-region installs (current default: West Commercial) see
 * no visible change.
 *
 * The SF Report ID is shown read-only because it is auto-filled from the
 * `podSfReportMap` — users never type it directly. POD labels are taken from
 * `podLabels` (server-supplied via settings.json) when present.
 */
export interface BootstrapConfigBlockProps {
  selectedPod: string
  setSelectedPod: (pod: string) => void
  sfReportId: string
  podSfReportMap: Record<string, string>
  territorySheetUrl: string
  /** POD options to render in the dropdown. Provided by the parent via useBootstrapConfig. */
  podOptions: ReadonlyArray<{ value: string; label: string }>
  /** POD key → human label map (server-supplied). Overrides opt.label when present. */
  podLabels?: Record<string, string>
  /** Available regions. Selector hidden when length <= 1. */
  regions?: ReadonlyArray<{ id: string; label: string; type: string }>
  /** Currently selected region id. */
  selectedRegion?: string
  /** Setter for the selected region id. */
  setSelectedRegion?: (region: string) => void
  /**
   * When provided, renders the Parent Drive Folder field in Full POD mode.
   * The field is editable, has a Validate button, and shows a Drive
   * scaffolding preview once the folder is validated. The validated folder is
   * persisted to settings.json via POST /api/sf-bookings/pod-folder and the
   * parent is notified via `onParentFolderChange` so its local state stays in
   * sync for the next bootstrap run.
   */
  parentFolderId?: string
  /** Callback fired after a successful validate + save so the parent's
   *  podBookingsFolderId state picks up the corrected value. */
  onParentFolderChange?: (folderId: string) => void
  /** AE names that will be bootstrapped for the currently selected POD.
   *  Used to render the Drive scaffolding preview (folder tree) below the
   *  validated parent folder field. When empty, the preview renders a
   *  generic "AE subfolders" placeholder. */
  previewAeNames?: ReadonlyArray<string>
  /** BKL-UX86: when true AND `parentFolderId` is empty, render a
   *  placeholder scaffolding preview rooted at `📁 My Drive /` so the user
   *  can see where bootstrap will create folders before they paste a parent.
   *  Bootstrap is still allowed with no folder (server defaults to Drive root). */
  showRootFallback?: boolean
  /** BKL-CONN-SF-REPORT-01: when no podSfReportMap entry exists for the
   *  selected POD, the SF Report ID becomes editable so the user can supply
   *  their own. This callback is fired on every keystroke. */
  onSfReportIdChange?: (id: string) => void
  /** BKL-UX-FOLDER-LOCK-01: First-wins parent folder. When a non-empty
   *  lockedFolderId is provided (sourced from existing AE records on the
   *  server), the editable input + Validate button are replaced with a
   *  locked read-only display. The component fires onParentFolderChange
   *  on mount so the parent's podBookingsFolderId/podFolderValidated state
   *  is set without any user action. A "Change" button drops the lock
   *  after a confirmation warning. When empty (fresh install), the
   *  existing editable behavior (BKL-UX84) is preserved exactly. */
  lockedFolderId?: string
}

export function BootstrapConfigBlock(props: BootstrapConfigBlockProps) {
  const {
    selectedPod,
    setSelectedPod,
    sfReportId,
    podSfReportMap,
    territorySheetUrl,
    podOptions,
    podLabels,
    regions,
    selectedRegion,
    setSelectedRegion,
    parentFolderId,
    onParentFolderChange,
    previewAeNames,
    showRootFallback,
    onSfReportIdChange,
    lockedFolderId,
  } = props

  // BKL-UX-FOLDER-LOCK-01: lock active when a non-empty lockedFolderId is
  // supplied AND the user has not explicitly clicked "Change" to override.
  const [lockOverride, setLockOverride] = useState<boolean>(false)
  const isFolderLocked = !!lockedFolderId && lockedFolderId.trim().length > 0 && !lockOverride

  // BKL-UX-FOLDER-LOCK-01: when the lock is active, push the locked id up
  // to the parent on mount (and whenever the locked id changes) so
  // podBookingsFolderId + podFolderValidated are set without a user action.
  useEffect(() => {
    if (isFolderLocked && lockedFolderId) {
      onParentFolderChange?.(lockedFolderId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFolderLocked, lockedFolderId])

  // ── Parent Drive Folder editable field state (Full POD mode only) ──────────
  // BKL-UX84: The field ALWAYS starts empty — never pre-filled from any
  // settings.json value. The user must paste a URL and click Validate every
  // session before the Bootstrap Full POD button unlocks. This prevents a
  // wrong/dangerous value in settings.json from silently unlocking Bootstrap.
  // `folderResolvedId` starts null and is set only by a successful
  // `validateParentFolder()` call in the current session.
  const [folderDraft, setFolderDraft] = useState<string>('')
  const [folderName, setFolderName] = useState<string | null>(null)
  const [folderResolvedId, setFolderResolvedId] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [folderValidating, setFolderValidating] = useState<boolean>(false)
  // parentFolderValidated = folderResolvedId !== null
  // Flows to the parent via onParentFolderChange to gate the Bootstrap Full POD
  // button. folderResolvedId is cleared on every input change so re-pasting a
  // URL resets the validated state and re-disables Bootstrap (BKL-UX84).

  const validateParentFolder = async () => {
    const val = folderDraft.trim()
    setFolderError(null)
    setFolderName(null)
    if (!val) {
      setFolderError('Paste a Google Drive folder URL or folder ID')
      return
    }
    setFolderValidating(true)
    try {
      // POST /api/aes/validate-folder accepts either a full URL (extracts
      // /folders/<id>) or — as a convenience — we send the raw value and let
      // the server's regex handle it. If it's a bare ID, we synthesize a URL
      // so the existing server regex matches it.
      const folderUrl = /\/folders\//.test(val) ? val : `https://drive.google.com/drive/folders/${val}`
      const res = await fetch('/api/aes/validate-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderUrl }),
      })
      const data = await res.json().catch(() => ({} as { folderId?: string; folderName?: string; error?: string }))
      if (!res.ok || data.error || !data.folderId) {
        setFolderError(data.error ?? 'Folder not found — check the URL or your Google connection')
        setFolderResolvedId(null)
        return
      }
      const resolvedId = String(data.folderId)
      const resolvedName = String(data.folderName ?? resolvedId)
      setFolderResolvedId(resolvedId)
      setFolderName(resolvedName)

      // Persist to settings.json so next session has the corrected value.
      // BKL-UX75 endpoint: POST /api/sf-bookings/pod-folder { folderId }.
      try {
        const saveRes = await fetch('/api/sf-bookings/pod-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId: resolvedId }),
        })
        if (!saveRes.ok) {
          const d = await saveRes.json().catch(() => ({} as { error?: string }))
          setFolderError(d.error ?? `Could not save folder to settings (${saveRes.status})`)
          return
        }
        // Notify parent so its local podBookingsFolderId state picks up the
        // new value without waiting for a reload / re-fetch of pod-config.
        onParentFolderChange?.(resolvedId)
      } catch (e: any) {
        setFolderError(e?.message ?? 'Could not save folder to settings')
      }
    } catch (e: any) {
      setFolderError(e?.message ?? 'Could not reach Drive API')
      setFolderResolvedId(null)
    } finally {
      setFolderValidating(false)
    }
  }

  const driveFolderUrl = folderResolvedId
    ? `https://drive.google.com/drive/folders/${folderResolvedId}`
    : null
  const showScaffoldPreview = folderResolvedId !== null && !folderError
  // BKL-UX86: show a "My Drive /" placeholder scaffolding preview when no
  // parent folder is configured yet (fresh install, or no AE has a
  // parentFolderId). Lets the user see where bootstrap will land before
  // they paste a custom parent. Suppressed once a real folder is validated.
  const showRootFallbackPreview =
    !!showRootFallback &&
    !showScaffoldPreview &&
    !folderDraft.trim() &&
    !(parentFolderId ?? '').trim()
  const previewAes: ReadonlyArray<string> =
    previewAeNames && previewAeNames.length > 0 ? previewAeNames : []

  const hasReportForPod = selectedPod.length > 0 && Boolean(podSfReportMap[selectedPod])
  const showRegionSelector = !!regions && regions.length > 1 && !!setSelectedRegion

  // Selected region label (used in the territory sheet row when multi-region)
  const selectedRegionLabel = regions?.find(r => r.id === selectedRegion)?.label ?? 'Territory Sheet'

  return (
    <div className="space-y-3">
      {/* 0 — Region selector (only when more than one region is configured) */}
      {showRegionSelector && (
        <div>
          <label className="block text-xs text-text-secondary mb-1">Region *</label>
          <select
            value={selectedRegion ?? ''}
            onChange={e => setSelectedRegion?.(e.target.value)}
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent"
          >
            {regions!.map(r => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* 1 — Territory sheet selector */}
      <div>
        <label className="block text-xs text-text-secondary mb-1">Territory Sheet *</label>
        <div className="flex gap-2">
          <select
            value={territorySheetUrl}
            onChange={() => { /* single option per region — driven by region selector */ }}
            className={`flex-1 bg-surface border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent ${territorySheetUrl ? 'border-border' : 'bg-blue-600/40 border-blue-500/60'}`}
          >
            <option value={territorySheetUrl}>{selectedRegionLabel} Territory Sheet</option>
          </select>
          <a
            href={territorySheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open territory sheet in a new tab"
            className="flex items-center justify-center px-3 bg-surface border border-border rounded-lg text-text-secondary hover:text-accent hover:border-accent transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* 2 — POD dropdown (auto-fills SF Report ID on change) */}
      <div>
        <label className="block text-xs text-text-secondary mb-1">POD / Region *</label>
        <select
          data-testid="pod-select"
          value={selectedPod}
          onChange={e => setSelectedPod(e.target.value)}
          className={`w-full bg-surface border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent ${selectedPod ? 'border-border' : 'bg-blue-600/40 border-blue-500/60'}`}
        >
          <option value="">Select POD…</option>
          {podOptions.map(opt => {
            const label = (podLabels && podLabels[opt.value]) ? podLabels[opt.value] : opt.label
            return <option key={opt.value} value={opt.value}>{label}</option>
          })}
        </select>
      </div>

      {/* 3 — SF Report ID (read-only when POD map provides it; editable otherwise) */}
      <div>
        <label className="block text-xs text-text-secondary mb-1">
          {hasReportForPod ? 'SF Report ID (auto-filled)' : 'SF Report ID'}
        </label>
        {hasReportForPod ? (
          <input
            type="text"
            value={sfReportId}
            readOnly
            placeholder={selectedPod ? '' : 'Select a POD to auto-fill'}
            className="w-full bg-surface/50 border border-border rounded-lg px-3 py-2 text-sm text-text-secondary font-mono cursor-not-allowed focus:outline-none"
          />
        ) : (
          <input
            type="text"
            value={sfReportId}
            onChange={(e) => onSfReportIdChange?.(e.target.value)}
            placeholder={selectedPod ? 'Paste SF Report ID' : 'Select a POD first'}
            className="w-full bg-surface/50 border border-border rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
          />
        )}
        {selectedPod && !hasReportForPod && (
          <p className="text-xs text-warning mt-1">Enter your SF Report ID above, or contact ops if you don't have one.</p>
        )}
      </div>

      {/* 4 — Parent Drive Folder (editable, Full POD mode only) ─────────── */}
      {/* Editable URL/ID field + Validate button. On successful validate we: */}
      {/*   (a) show the folder name + clickable Drive link                  */}
      {/*   (b) persist to settings.json via POST /api/sf-bookings/pod-folder */}
      {/*   (c) notify the parent so local podBookingsFolderId state updates */}
      {/*   (d) render a Drive scaffolding preview (folder tree) below       */}
      {parentFolderId !== undefined && isFolderLocked && lockedFolderId && (
        <div data-testid="parent-drive-folder-block-locked">
          <label className="block text-xs text-text-secondary mb-1">Parent Drive Folder *</label>
          <div className="flex items-center justify-between gap-2 bg-surface/50 border border-border rounded-lg px-3 py-2">
            <div className="flex items-center gap-2 min-w-0 text-sm">
              <Lock className="w-3.5 h-3.5 text-text-secondary shrink-0" />
              <span className="text-text-secondary shrink-0">Using existing folder:</span>
              <a
                href={`https://drive.google.com/drive/folders/${lockedFolderId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline truncate inline-flex items-center gap-1"
                data-testid="parent-folder-locked-link"
              >
                <span className="truncate font-mono">{lockedFolderId}</span>
                <ExternalLink className="w-3 h-3 shrink-0" />
              </a>
            </div>
            <button
              type="button"
              data-testid="parent-folder-change"
              onClick={() => {
                const ok = typeof window !== 'undefined' && window.confirm(
                  'Changing the parent folder will create new AE Drive folders in a different location. Existing AEs will not be moved. Continue?'
                )
                if (!ok) return
                setLockOverride(true)
                // Clear parent state so Bootstrap re-disables until re-validated.
                onParentFolderChange?.('')
              }}
              className="text-xs text-text-secondary hover:text-white underline transition-colors shrink-0"
            >
              Change
            </button>
          </div>
        </div>
      )}
      {parentFolderId !== undefined && !isFolderLocked && (
        <div data-testid="parent-drive-folder-block">
          <label className="block text-xs text-text-secondary mb-1">Parent Drive Folder *</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={folderDraft}
              onChange={e => {
                setFolderDraft(e.target.value)
                setFolderName(null)
                setFolderResolvedId(null)
                setFolderError(null)
                // BKL-UX84: notify parent so it clears podFolderValidated and
                // podBookingsFolderId — re-disables Bootstrap POD on any edit.
                onParentFolderChange?.('')
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void validateParentFolder() }
              }}
              placeholder="Paste Google Drive folder URL or folder ID"
              data-testid="parent-folder-input"
              className={`flex-1 bg-surface border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary font-mono focus:outline-none focus:border-accent ${folderError ? 'border-critical' : folderName ? 'border-success' : 'border-border'}`}
            />
            <button
              type="button"
              onClick={() => void validateParentFolder()}
              disabled={folderValidating || !folderDraft.trim()}
              data-testid="parent-folder-validate"
              className="flex items-center gap-1.5 px-3 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {folderValidating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {folderValidating ? 'Validating…' : 'Validate'}
            </button>
          </div>

          {/* Success state — green check + folder name + clickable link */}
          {folderName && folderResolvedId && !folderError && (
            <p
              data-testid="parent-folder-success"
              className="text-xs text-success mt-1.5 flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>Validated:&nbsp;</span>
              {driveFolderUrl ? (
                <a
                  href={driveFolderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-success/80 inline-flex items-center gap-1"
                >
                  {folderName}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <span>{folderName}</span>
              )}
            </p>
          )}

          {/* Error state — red X + message */}
          {folderError && (
            <p
              data-testid="parent-folder-error"
              className="text-xs text-critical mt-1.5 flex items-center gap-1.5"
            >
              <XCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{folderError}</span>
            </p>
          )}

          {/* Drive scaffolding preview — only after successful validate */}
          {showScaffoldPreview && (
            <div
              data-testid="scaffold-preview"
              className="mt-3 bg-bg border border-border rounded-lg p-3 text-xs font-mono space-y-0.5"
            >
              <p className="text-text-secondary mb-1 font-sans text-xs font-medium">
                What will be created in this folder:
              </p>
              <p className="text-text-primary">
                📁 {driveFolderUrl ? (
                  <a href={driveFolderUrl} target="_blank" rel="noopener noreferrer" className="text-success underline">
                    {folderName ?? 'Parent folder'}
                  </a>
                ) : (
                  <span className="text-success">{folderName ?? 'Parent folder'}</span>
                )}/
              </p>
              {previewAes.length > 0 ? (
                previewAes.slice(0, 8).map((ae, i) => {
                  const isLast = i === Math.min(previewAes.length, 8) - 1 && previewAes.length <= 8
                  return (
                    <div key={`${ae}-${i}`}>
                      <p className="text-text-primary pl-4">{isLast ? '└──' : '├──'} 📁 {ae}/</p>
                      <p className="text-text-secondary pl-10">├── 📄 SF Bookings Sheet</p>
                      <p className="text-text-secondary pl-10">├── 📄 CCSP Sheet</p>
                      <p className="text-text-secondary pl-10">└── 📄 Pipeline Sheet</p>
                    </div>
                  )
                })
              ) : (
                <>
                  <p className="text-text-primary pl-4">└── 📁 AE subfolders/</p>
                  <p className="text-text-secondary pl-10">├── 📄 SF Bookings Sheet</p>
                  <p className="text-text-secondary pl-10">├── 📄 CCSP Sheet</p>
                  <p className="text-text-secondary pl-10">└── 📄 Pipeline Sheet</p>
                </>
              )}
              {previewAes.length > 8 && (
                <p className="text-text-secondary pl-4">… and {previewAes.length - 8} more AE folder(s)</p>
              )}
            </div>
          )}

          {/* BKL-UX86: root fallback preview — shown when no parent folder is
              configured so the user can see where bootstrap will land. Rooted
              at "📁 My Drive /" (no link, just text). Bootstrap is still
              allowed with no folder (server creates in Drive root). */}
          {showRootFallbackPreview && (
            <div
              data-testid="scaffold-preview-root-fallback"
              className="mt-3 bg-bg border border-border rounded-lg p-3 text-xs font-mono space-y-0.5"
            >
              <p className="text-text-secondary mb-1 font-sans text-xs font-medium">
                Default: Drive root — paste a folder URL to change
              </p>
              <p className="text-text-primary">📁 My Drive /</p>
              {previewAes.length > 0 ? (
                previewAes.slice(0, 8).map((ae, i) => {
                  const isLast = i === Math.min(previewAes.length, 8) - 1 && previewAes.length <= 8
                  return (
                    <div key={`root-${ae}-${i}`}>
                      <p className="text-text-primary pl-4">{isLast ? '└──' : '├──'} 📁 {ae}/</p>
                      <p className="text-text-secondary pl-10">├── 📄 SF Bookings Sheet</p>
                      <p className="text-text-secondary pl-10">├── 📄 CCSP Sheet</p>
                      <p className="text-text-secondary pl-10">└── 📄 Pipeline Sheet</p>
                    </div>
                  )
                })
              ) : (
                <>
                  <p className="text-text-primary pl-4">└── 📁 AE subfolders/</p>
                  <p className="text-text-secondary pl-10">├── 📄 SF Bookings Sheet</p>
                  <p className="text-text-secondary pl-10">├── 📄 CCSP Sheet</p>
                  <p className="text-text-secondary pl-10">└── 📄 Pipeline Sheet</p>
                </>
              )}
              {previewAes.length > 8 && (
                <p className="text-text-secondary pl-4">… and {previewAes.length - 8} more AE folder(s)</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 5 — Regional availability disclaimer (only in single-region mode) */}
      {!showRegionSelector && (
        <p className="text-xs text-text-secondary/70 italic">
          Territory sheets are currently available for WEST Commercial territories only. Additional regions will be added in a future update.
        </p>
      )}
    </div>
  )
}
