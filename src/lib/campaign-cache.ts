/**
 * Campaign Cache — persistence and staleness logic for campaign results.
 *
 * Extracted from campaign-service.ts (Phase 5b, #1163).
 * ADR-046 §4: shared module — reusable by meeting prep, account plans.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { CACHE_DIR } from './paths.ts'
import type { QualityScorecard } from '../gemini-quality-gate.ts'
import type { Signal } from '../feature-module-registry.ts'
import type { CustomerSignals } from './signal-loader.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CampaignCacheEntry {
  id: string
  materialTitle: string
  materialUrl: string
  customerName: string
  markdown: string
  htmlContent: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
  driveFileId?: string
  driveHtmlFileId?: string
  signalsLoaded?: string[]
  signalsMissing?: string[]
  signalCompleteness?: number
  qualityScorecard?: QualityScorecard
  qualityWarnings?: Array<{ email: number; category: string; message: string }>
  campaignDirective?: string
}

export interface CampaignListItem {
  id: string
  materialTitle: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
}

// ── Constants ────────────────────────────────────────────────────────────────

export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// ── Cache CRUD ───────────────────────────────────────────────────────────────

export function saveCampaignToCache(
  customerSlug: string,
  entry: CampaignCacheEntry,
): void {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  mkdirSync(campaignsDir, { recursive: true })

  const campaignPath = resolve(campaignsDir, `${customerSlug}-${entry.id}.json`)
  writeFileSync(campaignPath, JSON.stringify(entry, null, 2), { mode: 0o600 })
  console.log(`[campaigns] Saved to cache: ${campaignPath}`)
}

export function loadCampaignsFromCache(customerSlug: string): CampaignListItem[] {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  if (!existsSync(campaignsDir)) return []

  const files = readdirSync(campaignsDir).filter(f => f.startsWith(`${customerSlug}-`) && f.endsWith('.json'))
  const campaigns: CampaignListItem[] = []

  for (const file of files) {
    try {
      const entry: CampaignCacheEntry = JSON.parse(readFileSync(resolve(campaignsDir, file), 'utf-8'))
      campaigns.push({
        id: entry.id,
        materialTitle: entry.materialTitle,
        generatedAt: entry.generatedAt,
        driveUrl: entry.driveUrl,
        htmlUrl: entry.htmlUrl,
      })
    } catch (e: any) {
      console.warn(`[campaigns] Failed to read ${file}:`, e.message)
    }
  }

  campaigns.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  return campaigns
}

export function loadCampaignFromCache(customerSlug: string, campaignId: string): CampaignCacheEntry | null {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  const campaignPath = resolve(campaignsDir, `${customerSlug}-${campaignId}.json`)

  if (!existsSync(campaignPath)) return null

  try {
    return JSON.parse(readFileSync(campaignPath, 'utf-8'))
  } catch (e: any) {
    console.error(`[campaigns] Failed to read campaign ${campaignId}:`, e.message)
    return null
  }
}

export function deleteCampaignFromCache(customerSlug: string, campaignId: string): boolean {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  const campaignPath = resolve(campaignsDir, `${customerSlug}-${campaignId}.json`)

  if (!existsSync(campaignPath)) return false

  try {
    unlinkSync(campaignPath)
    console.log(`[campaigns] Deleted from cache: ${campaignPath}`)
    return true
  } catch (e: any) {
    console.error(`[campaigns] Failed to delete campaign ${campaignId}:`, e.message)
    return false
  }
}

// ── Drive file ID lookup (scans cache for prior uploads) ─────────────────────

export function findExistingDriveFileIds(
  customerSlug: string,
  materialUrl: string,
): { driveFileId?: string; driveHtmlFileId?: string } | null {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  if (!existsSync(campaignsDir)) return null

  const files = readdirSync(campaignsDir).filter(f => f.startsWith(`${customerSlug}-`) && f.endsWith('.json'))
  let latest: CampaignCacheEntry | null = null

  for (const file of files) {
    try {
      const entry: CampaignCacheEntry = JSON.parse(readFileSync(resolve(campaignsDir, file), 'utf-8'))
      if (entry.materialUrl === materialUrl && (entry.driveFileId || entry.driveHtmlFileId)) {
        if (!latest || new Date(entry.generatedAt) > new Date(latest.generatedAt)) {
          latest = entry
        }
      }
    } catch { /* skip corrupt entries */ }
  }

  return latest ? { driveFileId: latest.driveFileId, driveHtmlFileId: latest.driveHtmlFileId } : null
}

// ── Intelligence cache staleness ─────────────────────────────────────────────

export function isIntelligenceStale(slug: string): boolean {
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
  if (!existsSync(intelPath)) return true

  try {
    const intelData = JSON.parse(readFileSync(intelPath, 'utf-8'))
    const cachedAt = intelData.cachedAt ? new Date(intelData.cachedAt).getTime() : 0
    return Date.now() - cachedAt > STALE_THRESHOLD_MS
  } catch {
    return true
  }
}

// ── Signal enrichment from cache ─────────────────────────────────────────────

export async function enrichSignalsFromCache(
  signals: CustomerSignals,
  slug: string,
  subSignals: Signal[],
  registrySignals: Signal[],
): Promise<CustomerSignals> {
  const enriched: any = { ...signals }
  try {
    const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
    if (existsSync(intelPath)) enriched.intelligence = JSON.parse(readFileSync(intelPath, 'utf-8'))
    const planPath = resolve(CACHE_DIR, 'intelligence', `${slug}-account-plan.md`)
    if (existsSync(planPath)) enriched.accountPlan = readFileSync(planPath, 'utf-8')
  } catch { /* silent */ }
  if (subSignals.length > 0) {
    enriched.subscriptions = subSignals.map(s => ({
      productName: s.metadata?.product ?? s.headline,
      quantity: s.metadata?.quantity ?? 1,
      status: 'Active',
    }))
  }
  const caseSignals = registrySignals.filter(s => s.source === 'cases')
  if (caseSignals.length > 0) enriched.cases = caseSignals
  return enriched
}
