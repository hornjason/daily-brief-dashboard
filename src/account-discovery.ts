// ── Account discovery helpers (M03 — extracted from server.ts) ──────────────
import { google } from 'googleapis'
import { normalizeForMatch } from './sheets.ts'

// Tab names that are structural (not customer names) in territory spreadsheets
const SKIP_TABS = new Set([
  'account list', 'supportable logins', 'account grouping', 'accounts',
  'summary', 'dashboard', 'instructions', 'readme', 'notes', 'overview',
  'template', 'totals', 'totals by ae', 'pivot', 'raw data', 'all accounts',
  'login', 'logins', 'data', 'index',
  // Pricing/model/lookup tabs common in Red Hat sales spreadsheets
  'deal details', 'initiatives', 'policies', 'synopsis', 'affiliates',
  'annual sub counts', 'bom', 'business justification', 'cloud spend',
  'monthlymodel', 'yearlymodel', 'tabindex', 'tableau', 'rde', 'support',
  'upgrademodel', 'raw data table',
])

function isCustomerTab(tab: string): boolean {
  const lower = tab.toLowerCase().trim()
  if (lower.length < 3) return false
  if (lower.includes('ccsp')) return false
  if (SKIP_TABS.has(lower)) return false
  // Generic sheet names
  if (/^sheet\d+$/i.test(tab)) return false
  // Month patterns: M1-M12
  if (/^m\d{1,2}$/i.test(tab)) return false
  // Internal code-prefixed tabs: DS_, DV_, CSV_, DD_, OVE_, CD_, etc.
  if (/^[a-z]{1,4}_/i.test(tab)) return false
  // Summary/model/data tabs ending in common suffixes
  if (/\b(model|summary|geo|revenue|tax|partner|count|report|raw)\b/i.test(tab)) return false
  return true
}

export type DiscoveredAccount = { name: string; ae: string; segment?: string; aliases?: string[]; supportableFileId?: string }

// BKL-M05: normalizeForDedup removed — use normalizeForMatch from ./sheets.ts (identical logic, single source of truth).

// Returns true if two normalized names likely refer to the same company.
// Uses word-level prefix overlap: "fred hutch" matches "fred hutchinson cancer center"
// because "hutch" is a prefix of "hutchinson". Threshold: all words in the shorter
// name must prefix-match a word in the longer name.
function namesLikelySame(a: string, b: string): boolean {
  if (a === b) return true
  const wa = a.split(' ').filter(Boolean)
  const wb = b.split(' ').filter(Boolean)
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  if (shorter.length === 0) return false
  const matches = shorter.filter(sw => longer.some(lw => lw.startsWith(sw) || sw.startsWith(lw)))
  return matches.length / shorter.length >= 0.8
}

// BFS within a single folder — returns all spreadsheets at any depth with their file names.
async function getSpreadsheetsUnderFolder(
  drive: ReturnType<typeof google.drive>,
  rootFolderId: string,
): Promise<{ id: string; name: string }[]> {
  const results: { id: string; name: string }[] = []
  const queue = [rootFolderId]
  const visited = new Set([rootFolderId])

  while (queue.length > 0) {
    const folderId = queue.shift()!

    const sheetsRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id,name)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as any[] } }))
    for (const f of (sheetsRes.data.files ?? [])) {
      if (f.id) results.push({ id: f.id, name: f.name ?? '' })
    }

    // Also pick up shortcuts pointing to spreadsheets
    const shortcutRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
      fields: 'files(id,name,shortcutDetails)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as any[] } }))
    for (const f of (shortcutRes.data.files ?? [])) {
      const targetMime = (f as any).shortcutDetails?.targetMimeType ?? ''
      const targetId   = (f as any).shortcutDetails?.targetId ?? ''
      if (targetMime === 'application/vnd.google-apps.spreadsheet' && targetId) {
        results.push({ id: targetId, name: f.name ?? '' })
      }
    }

    const subRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as any[] } }))
    for (const f of (subRes.data.files ?? [])) {
      if (f.id && !visited.has(f.id)) { visited.add(f.id); queue.push(f.id) }
    }
  }
  return results
}

// Discovers accounts from connected AE folders.
//
// Strategy:
//   PRIMARY  — Supportable/territory spreadsheet tabs (one tab per account).
//              These represent ALL accounts the AE manages, not just ones with open pipeline.
//              AE name comes from the folder the spreadsheet lives in.
//   SUPPLEMENT — Pipeline file (auto-discovered or explicit URL) adds any accounts
//              not already in the territory list. Keeps pipeline AE assignment for
//              accounts that don't appear in any Supportable file.
//
// Folder depth: BFS within each AE subfolder, so AE/Accounts/*.xlsx is found automatically.
export async function discoverAccountsFromFolders(
  drive: ReturnType<typeof google.drive>,
  sheets: ReturnType<typeof google.sheets>,
  parentIds: string[],
  explicitFileId?: string,
): Promise<{ accounts: DiscoveredAccount[]; source: 'territory+pipeline' | 'territory' | 'pipeline' | 'manual' }> {

  // Collect all spreadsheets grouped by AE folder name
  const byAe: { aeName: string; fileId: string; fileName: string }[] = []
  const autoDiscoveredPipelineIds: string[] = []

  for (const parentId of parentIds) {
    // Get the connected folder's own name to check if it IS the AE folder
    const selfMeta = await drive.files.get({ fileId: parentId, fields: 'id,name' }).catch(() => ({ data: { name: '' } }))
    const selfName = ((selfMeta.data as any).name ?? '').trim()
    const selfNameLower = selfName.toLowerCase()

    // Check direct children (sheets + shortcuts) of the connected folder
    const [selfSheetsRes, selfShortcutsRes] = await Promise.all([
      drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'files(id,name)', pageSize: 50,
      }).catch(() => ({ data: { files: [] as any[] } })),
      drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
        fields: 'files(id,name,shortcutDetails)', pageSize: 50,
      }).catch(() => ({ data: { files: [] as any[] } })),
    ])

    const selfFiles: { id: string; name: string }[] = [
      ...((selfSheetsRes.data as any).files ?? []).map((f: any) => ({ id: f.id, name: f.name ?? '' })),
      ...((selfShortcutsRes.data as any).files ?? [])
        .filter((f: any) => (f.shortcutDetails?.targetMimeType ?? '').includes('spreadsheet'))
        .map((f: any) => ({ id: f.shortcutDetails.targetId, name: f.name ?? '' })),
    ]

    // If this folder contains files named with the folder's own name, it IS the AE folder
    const isAeFolder = selfFiles.some(f => f.name.toLowerCase().startsWith(selfNameLower))

    if (isAeFolder) {
      for (const s of selfFiles) {
        console.log(`[discovery] AE="${selfName}" file="${s.name}"`)
        byAe.push({ aeName: selfName, fileId: s.id, fileName: s.name })
        if (s.name.toLowerCase().includes('pipeline')) autoDiscoveredPipelineIds.push(s.id)
      }
      continue
    }

    // Otherwise treat as a parent folder containing AE subfolders
    const foldersRes = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 50,
    }).catch(() => ({ data: { files: [] as any[] } }))

    for (const aeFolder of ((foldersRes.data as any).files ?? [])) {
      if (!aeFolder.id) continue
      const aeName = aeFolder.name ?? ''
      const spreadsheets = await getSpreadsheetsUnderFolder(drive, aeFolder.id)
      for (const s of spreadsheets) {
        console.log(`[discovery] AE="${aeName}" file="${s.name}"`)
        byAe.push({ aeName, fileId: s.id, fileName: s.name })
        if (s.name.toLowerCase().includes('pipeline')) autoDiscoveredPipelineIds.push(s.id)
      }
    }
  }

  // ── Primary: territory spreadsheet tabs ──────────────────────────────────────
  // If an AE has a file explicitly named "supportable", use only that file.
  // Otherwise fall back to: file with a Supportable/CCSP tab, or any file with 3+ customer tabs.
  // This prevents old multi-purpose territory spreadsheets from polluting the account list
  // once a properly named Supportable file is in place.
  const aesWithSupportableFile = new Set(
    byAe
      .filter(s => !s.fileName.toLowerCase().includes('pipeline') && s.fileName.toLowerCase().includes('supportable'))
      .map(s => s.aeName)
  )

  const territoryAccounts: DiscoveredAccount[] = []
  const seenNorm = new Set<string>()

  for (const { aeName, fileId, fileName } of byAe) {
    if (fileName.toLowerCase().includes('pipeline')) continue
    const fileNameLower = fileName.toLowerCase()
    if (fileNameLower.includes('ccsp')) continue  // skip CCSP files for account list

    const hasSupportableName = fileNameLower.includes('supportable')

    // If this AE already has a named Supportable file, skip all other files
    if (aesWithSupportableFile.has(aeName) && !hasSupportableName) continue

    const meta = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'sheets.properties.title' }).catch(() => null)
    const tabs = (meta?.data.sheets ?? []).map((s: any) => (s.properties?.title ?? '') as string)

    const hasSupportableTab = tabs.some(t => t.toLowerCase().includes('supportable'))
    const customerTabCount  = tabs.filter(t => isCustomerTab(t)).length
    const isTerritoryFile   = hasSupportableName || hasSupportableTab || customerTabCount >= 3
    if (!isTerritoryFile) continue

    // Prefer an explicit "Account List" / "Accounts" tab as source of truth.
    // Falls back to scanning all customer-looking tabs if no account tab found.
    const accountTab = tabs.find(t => /\baccount/i.test(t))
    if (accountTab) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: fileId, range: accountTab,
      }).catch(() => null)
      const rows = (res?.data.values ?? []) as string[][]
      if (rows.length >= 2) {
        const headers  = rows[0].map((h: string) => h.toLowerCase().trim())
        const nameIdx  = headers.findIndex(h => h.includes('account') && !h.includes('number') && !h.includes('no') && !h.includes('#'))
        const segIdx   = headers.findIndex(h => h.includes('segment'))
        const aliasIdx = headers.findIndex(h => h.includes('alias'))
        if (nameIdx >= 0) {
          for (const row of rows.slice(1)) {
            const name = String(row[nameIdx] ?? '').trim()
            if (!name) continue
            const norm = normalizeForMatch(name)
            if (seenNorm.has(norm)) continue
            seenNorm.add(norm)
            // Parse aliases (comma-separated) and add their norms to dedup set
            const aliasRaw = aliasIdx >= 0 ? String(row[aliasIdx] ?? '').trim() : ''
            const aliases  = aliasRaw ? aliasRaw.split(/[\n,]/).map(a => a.trim()).filter(Boolean) : undefined
            if (aliases) {
              for (const alias of aliases) seenNorm.add(normalizeForMatch(alias))
            }
            const segment = segIdx >= 0 ? String(row[segIdx] ?? '').trim() : undefined
            territoryAccounts.push({ name, ae: aeName, segment: segment || undefined, aliases, supportableFileId: fileId })
          }
          continue  // done with this file — account tab was authoritative
        }
      }
    }

    // Fallback: scan tabs for customer-looking names
    for (const tab of tabs) {
      if (!isCustomerTab(tab)) continue
      const norm = normalizeForMatch(tab)
      if (seenNorm.has(norm)) continue
      seenNorm.add(norm)
      territoryAccounts.push({ name: tab, ae: aeName })
    }
  }

  // ── Supplement: pipeline accounts not already in territory ────────────────────
  const pipelineFileIds = explicitFileId ? [explicitFileId] : autoDiscoveredPipelineIds
  const pipelineAccounts = await readPipelineAccounts(sheets, pipelineFileIds)

  const seenNormList = [...seenNorm]  // snapshot of territory norms for fuzzy check
  const supplementAccounts: DiscoveredAccount[] = []
  for (const pa of pipelineAccounts) {
    const norm = normalizeForMatch(pa.name)
    if (seenNorm.has(norm)) continue
    if (seenNormList.some(t => namesLikelySame(norm, t))) continue
    seenNorm.add(norm)
    supplementAccounts.push(pa)
  }

  const allAccounts = [...territoryAccounts, ...supplementAccounts]
  if (!allAccounts.length) return { accounts: [], source: 'territory' }

  const source = territoryAccounts.length > 0 && supplementAccounts.length > 0 ? 'territory+pipeline'
    : territoryAccounts.length > 0 ? 'territory'
    : explicitFileId ? 'manual'
    : 'pipeline'

  return { accounts: allAccounts, source }
}

export async function readPipelineAccounts(
  sheets: ReturnType<typeof google.sheets>,
  fileIds: string[],
): Promise<DiscoveredAccount[]> {
  const seen = new Set<string>()
  const accounts: DiscoveredAccount[] = []
  for (const fileId of fileIds) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'properties.title' }).catch(() => null)
    const fileName = meta?.data.properties?.title ?? fileId
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: 'A1:Z5000' }).catch(() => null)
    const rows = (res?.data.values ?? []) as string[][]
    if (rows.length < 2) continue
    const headers  = rows[0].map(String)
    const nameIdx  = headers.indexOf('Account Name')
    const ownerIdx = headers.indexOf('Opportunity Owner')
    if (nameIdx < 0) continue
    for (const row of rows.slice(1)) {
      const name = String(row[nameIdx] ?? '').trim()
      const ae   = ownerIdx >= 0 ? String(row[ownerIdx] ?? '').trim() : ''
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      accounts.push({ name, ae })
    }
  }
  return accounts
}
