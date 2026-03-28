import { google } from 'googleapis'
import { resolve } from 'path'
import { makeAuth } from './google.ts'

const CONFIG_DIR_PATH   = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')

export interface PipelineRecord {
  oppNumber:        string
  oppId?:           string   // 18-char SF record ID — enables direct opp link
  accountName:      string
  oppName:          string
  acv:              number
  closeDate:        string
  forecastCategory: string
  owner:            string
  renewal:          boolean
  offeringGroup:    string
  probability:      number
  products:         string[]
}

const STAGE_ORDER = ['Commit', 'Best Case', 'Pipeline', 'Omitted']

// ── Row parser (shared between XLSX-era and Sheets-era) ────────────────────────

export function parsePipelineRows(rawRows: any[][]): PipelineRecord[] {
  if (rawRows.length < 2) return []
  const headers = (rawRows[0] ?? []).map(String)

  function col(row: any[], name: string): any {
    const i = headers.indexOf(name)
    return i >= 0 ? row[i] : null
  }

  // First pass: collect product descriptions per opp number
  const productsByOpp = new Map<string, string[]>()
  for (const row of rawRows.slice(1)) {
    if (!row.some((v: any) => v != null && v !== '')) continue
    const oppNum = String(col(row, 'Opportunity Number') ?? '')
    const desc   = String(col(row, 'Product Description') ?? '').trim()
    if (!oppNum) continue
    const arr = productsByOpp.get(oppNum) ?? []
    if (desc && !arr.includes(desc)) arr.push(desc)
    productsByOpp.set(oppNum, arr)
  }

  // Second pass: one record per opp
  const seen = new Set<string>()
  const records: PipelineRecord[] = []

  for (const row of rawRows.slice(1)) {
    if (!row.some((v: any) => v != null && v !== '')) continue

    const oppNumber = String(col(row, 'Opportunity Number') ?? '')
    if (seen.has(oppNumber)) continue
    seen.add(oppNumber)

    const fc = String(col(row, 'Forecast Category') ?? '').trim()
    const rawAcv = String(col(row, 'ACV Opportunity') ?? '').replace(/[^0-9.-]/g, '')
    const acv = rawAcv ? Number(rawAcv) : 0
    const rawDate = col(row, 'Close Date')
    const closeDate = rawDate instanceof Date
      ? rawDate.toISOString().slice(0, 10)
      : String(rawDate ?? '').slice(0, 10)

    const rawOppId = String(col(row, 'Opportunity ID') ?? '').trim()

    records.push({
      oppNumber,
      oppId:            rawOppId || undefined,
      accountName:      String(col(row, 'Account Name') ?? '').trim(),
      oppName:          String(col(row, 'Opportunity Name') ?? '').trim(),
      acv,
      closeDate,
      forecastCategory: fc,
      owner:            String(col(row, 'Opportunity Owner') ?? '').trim(),
      renewal:          (() => {
        const r = String(col(row, 'Renewal') ?? '').toLowerCase().trim()
        return r === '1' || r === 'true' || r === 'yes' || (r.includes('included') && !r.includes('not'))
      })(),
      offeringGroup:    String(col(row, 'Offering Group') ?? '').trim(),
      probability:      Number(col(row, 'Probability (%)') ?? 0),
      products:         productsByOpp.get(oppNumber) ?? [],
    })
  }

  return records
}

// ── Auto-discover pipeline spreadsheets using recursive ancestors search ──────
// Uses 'in ancestors' so any folder depth works — connect at /Sales root or
// any level; pipeline sheets at any depth beneath are found in one API call.

async function discoverPipelineFileIds(drive: ReturnType<typeof google.drive>): Promise<string[]> {
  const raw = process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? ''
  const rootIds = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (!rootIds.length) return []

  const fileIds: string[] = []

  for (const rootId of rootIds) {
    // BFS through folders to find pipeline files — 'in ancestors' can silently
    // return empty on some Drive configs, so we walk the tree with 'in parents'.
    const folderQueue = [rootId]
    const visited = new Set<string>([rootId])
    while (folderQueue.length > 0) {
      const folderId = folderQueue.shift()!
      const res = await drive.files.list({
        q: `'${folderId}' in parents and name contains 'pipeline' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'files(id,name)', pageSize: 20,
      }).catch(() => ({ data: { files: [] as { id?: string; name?: string }[] } }))
      for (const f of res.data.files ?? []) {
        if (f.id) fileIds.push(f.id)
      }
      // Shortcuts to pipeline spreadsheets
      const scRes = await drive.files.list({
        q: `'${folderId}' in parents and name contains 'pipeline' and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
        fields: 'files(id,name,shortcutDetails)', pageSize: 20,
      }).catch(() => ({ data: { files: [] as any[] } }))
      for (const f of scRes.data.files ?? []) {
        const targetMime = f.shortcutDetails?.targetMimeType ?? ''
        const targetId   = f.shortcutDetails?.targetId ?? ''
        if (targetMime === 'application/vnd.google-apps.spreadsheet' && targetId) fileIds.push(targetId)
      }
      const subRes = await drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)', pageSize: 50,
      }).catch(() => ({ data: { files: [] as { id?: string }[] } }))
      for (const f of subRes.data.files ?? []) {
        if (f.id && !visited.has(f.id)) { visited.add(f.id); folderQueue.push(f.id) }
      }
    }
  }

  return fileIds
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function fetchPipelineData(): Promise<{ records: PipelineRecord[]; fileIds: string[] }> {
  const auth   = makeAuth(GDRIVE_TOKEN_PATH)
  const drive  = google.drive({ version: 'v3', auth })
  const sheets = google.sheets({ version: 'v4', auth })

  // Collect file IDs: auto-discovered first, then PIPELINE_FILE_ID fallback
  const autoIds = await discoverPipelineFileIds(drive)
  const manualId = process.env.PIPELINE_FILE_ID
  const allIds = [...new Set([...autoIds, ...(manualId ? [manualId] : [])])]

  if (!allIds.length) return { records: [], fileIds: [] }

  const allRecords: PipelineRecord[] = []

  for (const fileId of allIds) {
    try {
      // PIPELINE_FILE_ID is written by the SF scraper into a "Pipeline" tab
      const range = fileId === manualId ? 'Pipeline!A1:Z5000' : 'A1:Z5000'
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: fileId,
        range,
      })
      const rows = (res.data.values ?? []) as string[][]
      allRecords.push(...parsePipelineRows(rows))
    } catch (e: any) {
      console.warn(`[pipeline] failed to read ${fileId}: ${e.message}`)
    }
  }

  return { records: allRecords, fileIds: allIds }
}

// ── Summary builder ───────────────────────────────────────────────────────────

export function buildPipelineSummary(records: PipelineRecord[], cachedAt: string | null) {
  const open   = records.filter(r => r.forecastCategory.toLowerCase() !== 'closed')
  const closed = records.filter(r => r.forecastCategory.toLowerCase() === 'closed')

  const totalAcv   = open.reduce((s, r) => s + r.acv, 0)
  const renewalAcv = open.filter(r => r.renewal).reduce((s, r) => s + r.acv, 0)
  const newAcv     = totalAcv - renewalAcv

  const stageMap = new Map<string, { acv: number; count: number }>()
  for (const r of open) {
    const s = stageMap.get(r.forecastCategory) ?? { acv: 0, count: 0 }
    s.acv += r.acv; s.count++
    stageMap.set(r.forecastCategory, s)
  }
  const byStage = STAGE_ORDER.filter(s => stageMap.has(s)).map(s => ({ stage: s, ...stageMap.get(s)! }))

  const ownerMap = new Map<string, { acv: number; count: number }>()
  for (const r of open) {
    const o = ownerMap.get(r.owner) ?? { acv: 0, count: 0 }
    o.acv += r.acv; o.count++
    ownerMap.set(r.owner, o)
  }
  const byOwner = [...ownerMap.entries()].map(([owner, v]) => ({ owner, ...v })).sort((a, b) => b.acv - a.acv)

  const topOpps       = [...open].sort((a, b) => b.acv - a.acv)
  const closedOpps    = [...closed].sort((a, b) => b.closeDate.localeCompare(a.closeDate))
  const techWinsNeeded = open.filter(r => r.acv >= 100_000).sort((a, b) => b.acv - a.acv)

  function closeQuarter(iso: string): string {
    if (!iso) return ''
    const d = new Date(iso)
    const m = d.getMonth() + 1
    const y = d.getFullYear()
    const q = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4
    return `Q${q} ${y}`
  }

  const qMap = new Map<string, { commit: number; bestCase: number; pipeline: number }>()
  for (const r of records) {
    const q = closeQuarter(r.closeDate)
    if (!q) continue
    const slot = qMap.get(q) ?? { commit: 0, bestCase: 0, pipeline: 0 }
    if (r.forecastCategory === 'Commit')         slot.commit   += r.acv
    else if (r.forecastCategory === 'Best Case') slot.bestCase += r.acv
    else if (r.forecastCategory === 'Pipeline')  slot.pipeline += r.acv
    qMap.set(q, slot)
  }
  const byQuarterStage = [...qMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([quarter, v]) => ({ quarter, ...v }))

  return { totalAcv, openCount: open.length, renewalAcv, newAcv, byStage, byOwner, byQuarterStage, topOpps, closedOpps, techWinsNeeded, cachedAt }
}
