# Auto-Bootstrap UI Design Spec

> Designed for DailyBriefDashboard SetupPage.tsx
> Last validated: 2026-04-15 | Trigger: BKL-UX85 — AutoBootstrapForm props + normalization note
> Dark theme: slate-800/900 bg, slate-300/400 text, emerald-400 success, red-400 error, indigo-600 primary
> Implements within the existing `AEsCustomersSection` component

---

## 1. Component Architecture

```
AEsCustomersSection
  +-- ModeToggle (segmented control: "Auto Setup" | "Manual / Existing")
  +-- AutoBootstrapForm (when mode === 'auto')
  |     +-- form fields (idle state)
  |     +-- TerritoryPicker (text input + Discover button + multi-select list)
  |     +-- BootstrapProgress (replaces form after submit)
  |           +-- StepRow[] (5 steps, each with status icon + label + detail)
  |           +-- CompletionCard (on finish: summary + links + "Add Another AE")
  +-- ManualAEForm (when mode === 'manual', existing implementation)
```

---

## 2. Types & Interfaces

```tsx
// Step status finite states
type StepStatus = 'pending' | 'running' | 'done' | 'error'

interface BootstrapStep {
  id: string                           // e.g. 'create-folder'
  label: string                        // e.g. 'Create Drive Folder'
  status: StepStatus
  detail?: string                      // e.g. 'Folder ID: 1xABC...'
  error?: string                       // e.g. 'Permission denied on Drive API'
}

interface BootstrapResult {
  folderId?: string
  folderUrl?: string
  supportableSheetId?: string
  supportableSheetUrl?: string
  ccspSheetId?: string
  ccspSheetUrl?: string
  pipelineSheetId?: string
  pipelineSheetUrl?: string
  customerFolders?: Record<string, { id: string; url: string }>  // customer name → folder (added 2026-03-30)
  accountNumbers?: Record<string, string[]>  // customer -> account numbers
}

interface AutoBootstrapState {
  phase: 'idle' | 'running' | 'complete' | 'complete-with-errors'
  aeName: string | null
  steps: BootstrapStep[]
  result: BootstrapResult | null
  startedAt: string | null
  completedAt: string | null
}

interface AutoBootstrapFormData {
  aeName: string
  sfReportId: string
  territories: string[]
  customerNames: string[]
  parentFolderId: string              // optional
}
```

---

## 3. State Machine

```
                     [Submit]
  IDLE  --------------------------> RUNNING
   ^                                   |
   |   [Add Another AE]              [poll /api/bootstrap/auto/status]
   |                                   |
   +--- COMPLETE <---------------------+--- all steps done/error
   |                                   |
   +--- COMPLETE_WITH_ERRORS <---------+--- at least one step errored
```

### Transitions

| From | Event | To | Side Effect |
|------|-------|----|-------------|
| idle | form submit | running | POST `/api/bootstrap/auto`, start polling |
| running | poll: step updates | running | update step statuses from response |
| running | poll: all steps done | complete | stop polling, show CompletionCard |
| running | poll: done + errors | complete-with-errors | stop polling, show CompletionCard with warnings |
| complete / complete-with-errors | "Add Another AE" click | idle | reset form + state |

### Polling

- Interval: 2000ms (not 3000ms -- snappier feedback matters)
- Endpoint: `GET /api/bootstrap/auto/status`
- Stop condition: response `running === false`

---

## 4. Component: ModeToggle

Already exists at line 922 of SetupPage.tsx. Current implementation is correct. No changes needed.

### Existing classes (reference)

```tsx
// Container
"flex items-center gap-1 bg-slate-800 rounded-lg p-1 w-fit"

// Active tab
"px-3 py-1.5 rounded-md text-sm font-medium transition-colors bg-indigo-600 text-white"

// Inactive tab
"px-3 py-1.5 rounded-md text-sm font-medium transition-colors text-slate-400 hover:text-white"
```

---

## 5. Component: AutoBootstrapForm

### Props

Receives shared state from the parent `AEsCustomersSection` (introduced BKL-UX85):

| Prop | Type | Notes |
|------|------|-------|
| `sharedParentFolderId` | `string` | Bare folder ID (not full URL) from `BootstrapConfigBlock.onParentFolderChange`. The handleSetupAE pre-check normalizes this to a full URL before sending to `/api/aes/validate-folder` (see BKL-UX85). |
| `sharedPod` | `string` | Currently selected POD |
| `sharedSfReportId` | `string` | SF Report ID auto-derived from POD |
| `sharedTerritorySheetUrl` | `string` | Territory sheet URL |
| `sharedPodOptions` | `array` | POD dropdown options |
| `onAeNameChange` | `(name: string) => void` | Pushes derived AE name up for BootstrapConfigBlock scaffolding preview |

> **⚠️ Normalization note (BKL-UX85):** `sharedParentFolderId` arrives as a bare Google Drive folder ID (e.g. `1BV0uRHei3oRvGYVE…`), not a full URL. `BootstrapConfigBlock` returns the resolved ID from its validate call. `handleSetupAE` must synthesize the full URL before sending to `/api/aes/validate-folder`:
> ```ts
> const folderUrl = /\/folders\//.test(folderVal)
>   ? folderVal
>   : `https://drive.google.com/drive/folders/${folderVal}`
> ```

### Form Fields

| Field | Type | Required | Placeholder | Notes |
|-------|------|----------|-------------|-------|
| AE Name | text input | yes | "Jane Smith" | |
| SF Report ID | text input | yes | "00OPe..." | |
| Territory Picker | text + Discover btn | yes | "WEST_COMM_CORP..." | See section 5a |
| Customer Names | textarea | yes | "Acme Corp\nGlobex..." | One per line, show count |
| Parent Drive Folder ID | text input | no | "Leave blank for My Drive root" | |

### 5a. Territory Picker States

**Pre-discovery (default):**
- Text input with comma-separated territory names
- "Discover" button to the right fetches `/api/bootstrap/tableau/territories`
- On error: red-400 error text below input

**Post-discovery (territories loaded):**
- Replace text input with scrollable checkbox list
- Max height 192px (max-h-48) with overflow-y-auto
- Show count badge: "{n} selected" in emerald-400
- "Switch to manual input" link below to revert

### Validation

`canSubmit` = all required fields non-empty AND (territory input has values OR selected territories > 0)

### Submit Button

Right-aligned. Disabled state at 50% opacity. Spinner replaces icon while starting.

---

## 6. Component: BootstrapProgress (primary deliverable)

This is the most important component. It replaces the form after submit and shows real-time step progress.

### Step Definitions (ordered)

```tsx
const BOOTSTRAP_STEPS: Array<{ id: string; label: string }> = [
  { id: 'create-folder',          label: 'Create Drive Folder' },
  { id: 'create-customer-folders', label: 'Create Customer Folders' },  // added 2026-03-30
  { id: 'discover-accounts',      label: 'Discover Account Numbers' },
  { id: 'create-supportable',     label: 'Create Supportable Sheet' },
  { id: 'create-ccsp',            label: 'Create CCSP Sheet' },
  { id: 'sync-pipeline',          label: 'Sync Pipeline Sheet' },
]
```

### Layout

Vertical step list with a left-aligned connector line. Each step is a row with:
- Status icon (left)
- Step label (center)
- Detail text or error message (right / below on mobile)

### Visual Design Per Status

**pending** -- muted, not yet reached
```tsx
// Icon: empty circle outline
<span className="inline-flex items-center justify-center w-6 h-6 rounded-full border-2 border-slate-600" />
// Label
<span className="text-slate-500">Create Drive Folder</span>
```

**running** -- highlighted, active spinner
```tsx
// Icon: animated spinner with indigo glow
<div className="inline-flex items-center justify-center w-6 h-6">
  <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
</div>
// Label: white text, slightly bolder
<span className="text-white font-medium">Discover Account Numbers</span>
// Row background highlight
"bg-slate-800/60 rounded-lg px-3 py-2.5 -mx-3"
```

**done** -- green check with optional detail
```tsx
// Icon: filled green check
<CheckCircle className="w-5 h-5 text-emerald-400" />
// Label
<span className="text-emerald-400">Create Supportable Sheet</span>
// Detail (truncated, right side)
<span className="text-xs text-slate-500 ml-auto truncate max-w-[200px]">
  Sheet ID: 1xABC...
</span>
```

**error** -- red X with error message, non-blocking (next steps continue)
```tsx
// Icon: red X
<XCircle className="w-5 h-5 text-red-400" />
// Label
<span className="text-red-400">Create CCSP Sheet</span>
// Error detail (below label, wrapping)
<p className="text-xs text-red-400/80 mt-0.5 ml-8">
  Permission denied: service account lacks editor role on target folder
</p>
```

### Connector Line

A thin vertical line connecting step icons, using a pseudo-element or absolute-positioned div:

```tsx
// Each step row (except last) has a connector
<div className="relative pl-8">
  {/* Connector line from this step to next */}
  {!isLast && (
    <div className="absolute left-[11px] top-8 w-0.5 h-6 bg-slate-700" />
  )}
  {/* Step icon positioned absolutely at left:0 */}
  <div className="absolute left-0 top-1">{statusIcon}</div>
  {/* Content */}
  <div className="min-h-[2rem] flex items-center gap-2">
    {label}
    {detail}
  </div>
</div>
```

### Elapsed Time

While running, show a subtle timer below the header:

```tsx
<p className="text-xs text-slate-500">Running... {elapsed}s</p>
```

---

## 7. Component: CompletionCard

Shown when `phase === 'complete' || phase === 'complete-with-errors'`. Appears below the step list.

### Success State (all steps done)

```tsx
<div className="mt-4 bg-emerald-950/30 border border-emerald-800/50 rounded-xl p-5 space-y-4">
  {/* Header */}
  <div className="flex items-center gap-2">
    <CheckCircle className="w-5 h-5 text-emerald-400" />
    <span className="text-base font-semibold text-white">
      {aeName} is ready
    </span>
  </div>

  {/* Links grid */}
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    {result.folderUrl && (
      <a
        href={result.folderUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-300 transition-colors"
      >
        <ExternalLink className="w-4 h-4 text-slate-400" />
        Drive Folder
      </a>
    )}
    {/* Same pattern for supportableSheetUrl, ccspSheetUrl, pipelineSheetUrl */}
  </div>

  {/* Account numbers summary */}
  {result.accountNumbers && (
    <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
      <p className="text-xs text-slate-400 mb-2">Discovered Account Numbers</p>
      {Object.entries(result.accountNumbers).map(([customer, nums]) => (
        <div key={customer} className="flex justify-between text-sm py-0.5">
          <span className="text-slate-300">{customer}</span>
          <span className="text-slate-500 font-mono text-xs">
            {nums.join(', ')}
          </span>
        </div>
      ))}
    </div>
  )}

  {/* Action buttons */}
  <div className="flex gap-3 pt-1">
    <button
      onClick={resetForm}
      className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
    >
      <Plus className="w-4 h-4" />
      Add Another AE
    </button>
    <button
      onClick={() => setMode('manual')}
      className="text-sm text-slate-400 hover:text-white transition-colors"
    >
      View in Manual Mode
    </button>
  </div>
</div>
```

### Complete-With-Errors State

Same structure but with amber border and a warning line:

```tsx
<div className="mt-4 bg-amber-950/20 border border-amber-800/50 rounded-xl p-5 space-y-4">
  <div className="flex items-center gap-2">
    <XCircle className="w-5 h-5 text-amber-400" />
    <span className="text-base font-semibold text-white">
      {aeName} setup completed with errors
    </span>
  </div>
  <p className="text-sm text-slate-400">
    Some steps failed but others succeeded. You can fix errors in Manual mode
    or retry Auto Setup.
  </p>
  {/* Same links grid, but only show links for steps that succeeded */}
  {/* Action buttons: "Retry Failed Steps" (indigo) + "Fix in Manual Mode" (ghost) */}
</div>
```

---

## 8. Full JSX Snapshots

### 8a. Idle Form State

```tsx
<div className="space-y-4">
  <p className="text-sm text-slate-400">
    Automatically create a Drive folder, discover account numbers, and generate
    all data sheets for a new AE.
  </p>

  <div className="grid grid-cols-1 gap-3">
    {/* AE Name */}
    <div>
      <label className="block text-xs text-slate-400 mb-1">AE Name *</label>
      <input
        type="text"
        value={aeName}
        onChange={e => setAeName(e.target.value)}
        placeholder="Jane Smith"
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
      />
    </div>

    {/* SF Report ID */}
    <div>
      <label className="block text-xs text-slate-400 mb-1">SF Report ID *</label>
      <input
        type="text"
        value={sfReportId}
        onChange={e => setSfReportId(e.target.value)}
        placeholder="00OPe..."
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
      />
    </div>

    {/* Territory Picker */}
    <div>
      <label className="block text-xs text-slate-400 mb-1">
        Account Territories *
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={territoryInput}
          onChange={e => setTerritoryInput(e.target.value)}
          placeholder="WEST_COMM_CORP_NORTHWEST_TERR01 (comma-separated)"
          className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <button
          onClick={discoverTerritories}
          disabled={discoveringTerritories}
          className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          {discoveringTerritories
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <ExternalLink className="w-4 h-4" />}
          Discover
        </button>
      </div>
    </div>

    {/* Customer Names */}
    <div>
      <label className="block text-xs text-slate-400 mb-1">
        Customer Names * (one per line)
      </label>
      <textarea
        value={customerText}
        onChange={e => setCustomerText(e.target.value)}
        placeholder={"Acme Corp\nGlobex Industries\nStark Enterprises"}
        rows={5}
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-y"
      />
      {customerNames.length > 0 && (
        <p className="text-xs text-slate-500 mt-1">
          {customerNames.length} customer(s)
        </p>
      )}
    </div>

    {/* Parent Folder ID */}
    <div>
      <label className="block text-xs text-slate-400 mb-1">
        Parent Drive Folder ID (optional)
      </label>
      <input
        type="text"
        value={parentFolderId}
        onChange={e => setParentFolderId(e.target.value)}
        placeholder="Leave blank to create in My Drive root"
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
      />
    </div>
  </div>

  <div className="flex justify-end pt-1">
    <button
      onClick={startBootstrap}
      disabled={!canSubmit || starting}
      className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
    >
      {starting
        ? <Loader2 className="w-4 h-4 animate-spin" />
        : <CheckCircle className="w-4 h-4" />}
      {starting ? 'Starting...' : 'Set Up AE'}
    </button>
  </div>
</div>
```

### 8b. Running State (Step 2 Active)

```tsx
<div className="space-y-1">
  <div className="flex items-center justify-between mb-3">
    <p className="text-sm font-semibold text-white">
      Setting up Jane Smith
    </p>
    <p className="text-xs text-slate-500">12s</p>
  </div>

  {/* Step 1: done */}
  <div className="relative pl-8 pb-3">
    <div className="absolute left-[11px] top-7 w-0.5 h-5 bg-emerald-800/50" />
    <div className="absolute left-0 top-0.5">
      <CheckCircle className="w-5 h-5 text-emerald-400" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem]">
      <span className="text-sm text-emerald-400">Create Drive Folder</span>
      <span className="text-xs text-slate-500 ml-auto truncate max-w-[200px]">
        1xABCdef...
      </span>
    </div>
  </div>

  {/* Step 2: running (highlighted row) */}
  <div className="relative pl-8 pb-3 bg-slate-800/60 rounded-lg px-3 py-2.5 -mx-1">
    <div className="absolute left-[14px] top-[2.25rem] w-0.5 h-5 bg-slate-700" />
    <div className="absolute left-[3px] top-[0.4rem]">
      <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem] ml-5">
      <span className="text-sm text-white font-medium">
        Discover Account Numbers
      </span>
    </div>
  </div>

  {/* Step 3: pending */}
  <div className="relative pl-8 pb-3">
    <div className="absolute left-[11px] top-7 w-0.5 h-5 bg-slate-700" />
    <div className="absolute left-0 top-0.5">
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border-2 border-slate-600" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem]">
      <span className="text-sm text-slate-500">Create Supportable Sheet</span>
    </div>
  </div>

  {/* Step 4: pending */}
  <div className="relative pl-8 pb-3">
    <div className="absolute left-[11px] top-7 w-0.5 h-5 bg-slate-700" />
    <div className="absolute left-0 top-0.5">
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border-2 border-slate-600" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem]">
      <span className="text-sm text-slate-500">Create CCSP Sheet</span>
    </div>
  </div>

  {/* Step 5: pending (last, no connector) */}
  <div className="relative pl-8">
    <div className="absolute left-0 top-0.5">
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border-2 border-slate-600" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem]">
      <span className="text-sm text-slate-500">Sync Pipeline Sheet</span>
    </div>
  </div>
</div>
```

### 8c. Error on Step 3, Steps 4-5 Continue

```tsx
<div className="space-y-1">
  <div className="flex items-center justify-between mb-3">
    <p className="text-sm font-semibold text-white">
      Setting up Jane Smith
    </p>
    <p className="text-xs text-slate-500">34s</p>
  </div>

  {/* Step 1: done */}
  <div className="relative pl-8 pb-3">
    <div className="absolute left-[11px] top-7 w-0.5 h-5 bg-emerald-800/50" />
    <div className="absolute left-0 top-0.5">
      <CheckCircle className="w-5 h-5 text-emerald-400" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem]">
      <span className="text-sm text-emerald-400">Create Drive Folder</span>
      <span className="text-xs text-slate-500 ml-auto truncate max-w-[200px]">
        1xABCdef...
      </span>
    </div>
  </div>

  {/* Step 2: done */}
  <div className="relative pl-8 pb-3">
    <div className="absolute left-[11px] top-7 w-0.5 h-5 bg-emerald-800/50" />
    <div className="absolute left-0 top-0.5">
      <CheckCircle className="w-5 h-5 text-emerald-400" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem]">
      <span className="text-sm text-emerald-400">Discover Account Numbers</span>
      <span className="text-xs text-slate-500 ml-auto">3 accounts found</span>
    </div>
  </div>

  {/* Step 3: ERROR (non-blocking) */}
  <div className="relative pl-8 pb-3">
    <div className="absolute left-[11px] top-7 w-0.5 h-5 bg-red-900/30" />
    <div className="absolute left-0 top-0.5">
      <XCircle className="w-5 h-5 text-red-400" />
    </div>
    <div className="min-h-[1.75rem]">
      <span className="text-sm text-red-400">Create Supportable Sheet</span>
      <p className="text-xs text-red-400/70 mt-0.5">
        Google Sheets API quota exceeded. Retry in 60 seconds.
      </p>
    </div>
  </div>

  {/* Step 4: running (continues despite step 3 error) */}
  <div className="relative pl-8 pb-3 bg-slate-800/60 rounded-lg px-3 py-2.5 -mx-1">
    <div className="absolute left-[14px] top-[2.25rem] w-0.5 h-5 bg-slate-700" />
    <div className="absolute left-[3px] top-[0.4rem]">
      <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem] ml-5">
      <span className="text-sm text-white font-medium">Create CCSP Sheet</span>
    </div>
  </div>

  {/* Step 5: pending */}
  <div className="relative pl-8">
    <div className="absolute left-0 top-0.5">
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border-2 border-slate-600" />
    </div>
    <div className="flex items-center gap-2 min-h-[1.75rem]">
      <span className="text-sm text-slate-500">Sync Pipeline Sheet</span>
    </div>
  </div>
</div>
```

### 8d. Complete State (Success)

```tsx
<div className="space-y-1">
  <div className="mb-3">
    <p className="text-sm font-semibold text-white">
      Setting up Jane Smith
    </p>
    <p className="text-xs text-slate-500">Completed in 47s</p>
  </div>

  {/* All 5 steps shown as done (same pattern as 8b step 1) */}
  {/* ... steps omitted for brevity, all with CheckCircle emerald-400 ... */}

  {/* Completion Card */}
  <div className="mt-4 bg-emerald-950/30 border border-emerald-800/50 rounded-xl p-5 space-y-4">
    <div className="flex items-center gap-2">
      <CheckCircle className="w-5 h-5 text-emerald-400" />
      <span className="text-base font-semibold text-white">
        Jane Smith is ready
      </span>
    </div>

    {/* Resource links */}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <a
        href="https://drive.google.com/drive/folders/1xABC"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-300 transition-colors"
      >
        <ExternalLink className="w-4 h-4 text-slate-400" />
        Drive Folder
      </a>
      <a
        href="https://docs.google.com/spreadsheets/d/1xDEF"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-300 transition-colors"
      >
        <ExternalLink className="w-4 h-4 text-slate-400" />
        Supportable Sheet
      </a>
      <a
        href="https://docs.google.com/spreadsheets/d/1xGHI"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-300 transition-colors"
      >
        <ExternalLink className="w-4 h-4 text-slate-400" />
        CCSP Sheet
      </a>
      <a
        href="https://docs.google.com/spreadsheets/d/1xJKL"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-300 transition-colors"
      >
        <ExternalLink className="w-4 h-4 text-slate-400" />
        Pipeline Sheet
      </a>
    </div>

    {/* Account numbers */}
    <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
      <p className="text-xs text-slate-400 mb-2">Discovered Account Numbers</p>
      <div className="space-y-0.5">
        <div className="flex justify-between text-sm">
          <span className="text-slate-300">Acme Corp</span>
          <span className="text-slate-500 font-mono text-xs">0012345, 0012346</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-slate-300">Globex Industries</span>
          <span className="text-slate-500 font-mono text-xs">0098765</span>
        </div>
      </div>
    </div>

    {/* Actions */}
    <div className="flex gap-3 pt-1">
      <button
        onClick={resetForm}
        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
      >
        <Plus className="w-4 h-4" />
        Add Another AE
      </button>
      <button
        onClick={() => setMode('manual')}
        className="text-sm text-slate-400 hover:text-white transition-colors"
      >
        View in Manual Mode
      </button>
    </div>
  </div>
</div>
```

---

## 9. Lucide Icons Required

All already imported in SetupPage.tsx:

- `CheckCircle` -- done state
- `XCircle` -- error state
- `Loader2` -- running state (with `animate-spin`)
- `ExternalLink` -- resource links, Discover button
- `Plus` -- "Add Another AE" button
- `ChevronDown` / `ChevronRight` -- accordion (existing)

---

## 10. Accessibility Notes

- All form inputs have associated `<label>` elements
- Disabled buttons use `disabled` attribute (not just visual styling)
- Error messages use `role="alert"` for screen readers
- Step status communicated via `aria-label` on icons (not just color)
- Territory checkboxes are native `<input type="checkbox">` for keyboard nav
- Focus visible ring on all interactive elements via Tailwind `focus:outline-none focus:border-indigo-500`
- Progress area should have `aria-live="polite"` so screen readers announce step changes

Add to step container:
```tsx
<div aria-live="polite" aria-atomic="false" className="space-y-1">
```

Add to each step icon:
```tsx
<CheckCircle className="w-5 h-5 text-emerald-400" aria-label="Completed" />
<Loader2 className="w-5 h-5 animate-spin text-indigo-400" aria-label="In progress" />
<XCircle className="w-5 h-5 text-red-400" aria-label="Failed" />
```

---

## 11. Implementation Checklist

- [ ] Refactor `AutoBootstrapProgress` to use connector-line layout (section 6)
- [ ] Add `BootstrapResult` type with sheet URLs for CompletionCard
- [ ] Add elapsed time display during running phase
- [ ] Add CompletionCard with resource links grid (section 7)
- [ ] Add "Add Another AE" and "View in Manual Mode" buttons
- [ ] Add `aria-live="polite"` to progress container
- [ ] Add `aria-label` to all status icons
- [ ] Add `role="alert"` to error messages
- [ ] Change polling interval from 3000ms to 2000ms
- [ ] Backend: return `result` object with sheet URLs in status endpoint
- [ ] Handle complete-with-errors state (amber variant of CompletionCard)
