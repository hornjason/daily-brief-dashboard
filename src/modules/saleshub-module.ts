/**
 * SalesHub Knowledge Base Module — GitHub Issue #424
 *
 * Registers SalesHub as a FeatureModule so the admin panel's
 * "Refresh SalesHub" button can track status and trigger reloads.
 *
 * On hero/L3 installs, syncNow() re-reads the JSON files from the
 * config directory (no scraping needed — data comes from pre-built files).
 * On primary/Mac Mini nodes, the existing scrape trigger path is preserved.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { resetKnowledgeCache, getKnowledgeStats } from '../lib/saleshub-knowledge-loader.ts'
import { downloadSaleshubFromDrive } from '../lib/saleshub-drive-sync.ts'
import { resolve } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

function getCacheDir(): string {
  return process.env.CACHE_DIR ?? 'data/cache'
}

function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/\.(pdf|pptx|docx|xlsx)$/i, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function buildDriveLookup(): Map<string, { name: string; driveUrl: string; textLen: number }> {
  const lookup = new Map<string, { name: string; driveUrl: string; textLen: number }>()
  const drivePath = resolve(getCacheDir(), 'saleshub', 'drive-content.json')
  if (!existsSync(drivePath)) return lookup
  try {
    const data = JSON.parse(readFileSync(drivePath, 'utf-8'))
    for (const f of data.files ?? []) {
      if (f.driveUrl) {
        const key = normalizeForMatch(f.name ?? '')
        lookup.set(key, { name: f.name, driveUrl: f.driveUrl, textLen: (f.extractedText ?? '').length })
      }
    }
  } catch { /* ignore */ }
  return lookup
}

function loadKnowledgeForSignals(): any {
  const paths = [resolve(getConfigDir(), 'saleshub-knowledge.json')]
  if (!process.env.CONFIG_DIR) paths.push(resolve('config-templates', 'saleshub-knowledge.json'))
  for (const p of paths) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'))
    } catch { /* try next */ }
  }
  return null
}

FeatureModuleRegistry.register({
  name: 'saleshub',
  displayName: 'SalesHub Knowledge',
  refreshEndpoint: '/api/saleshub/refresh',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days — data from Drive sync

  refreshInterval: null, // on-demand only

  async ensureFresh(_customerSlug: string): Promise<void> {
    const configPath = resolve(getConfigDir(), 'saleshub-knowledge.json')
    try {
      const stat = statSync(configPath)
      if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }
    await this.syncNow('')
  },

  cachePaths: () => [
    resolve(getConfigDir(), 'saleshub-knowledge.json'),
    resolve(getConfigDir(), 'saleshub-content-index.json'),
  ],

  async fetch(_customerName: string): Promise<void> {
    // SalesHub is portfolio-wide, not customer-specific
    // Download fresh data from Drive before reading from disk
    try {
      await downloadSaleshubFromDrive()
    } catch (e: any) {
      console.warn(`[saleshub-module] Drive download failed during fetch — falling back to disk: ${e.message}`)
    }
    resetKnowledgeCache()
    const stats = getKnowledgeStats()
    FeatureModuleRegistry.recordOutcome('saleshub', {
      success: true,
      recordCount: stats.tdpCount + stats.salesPlayCount + stats.tacticCount,
    })
  },

  async signals(_customerSlug: string): Promise<Signal[]> {
    const kb = loadKnowledgeForSignals()
    if (!kb) return []

    const driveLookup = buildDriveLookup()
    const signals: Signal[] = []

    // Emit one signal per tactic (25 tactics)
    for (const tactic of kb.tactics ?? []) {
      const assets: Array<{ name: string; url: string; type: string }> = []
      for (const item of tactic.whatToShare ?? []) {
        if (item.name) assets.push({ name: item.name, url: item.url ?? '', type: 'share' })
      }
      signals.push({
        source: 'saleshub-tactics',
        type: 'recommendation',
        headline: tactic.name ?? 'Unknown Tactic',
        detail: `TDP: ${tactic.parentTdp ?? 'Unknown'}`,
        rawRelevance: 0.3,
        timestamp: kb.scrapedAt ?? new Date().toISOString(),
        metadata: {
          parentTdp: tactic.parentTdp ?? '',
          playType: 'tactic',
          assets,
        },
      })
    }

    // Emit one signal per sales play (5 plays)
    for (const play of kb.salesPlays ?? []) {
      const persona = play.personaSection ?? {}
      const docs = (play.documents ?? []).map((doc: any) => {
        const docName = doc.name ?? doc.title ?? ''
        const key = normalizeForMatch(docName)
        const driveMatch = driveLookup.get(key)
        return {
          name: docName,
          driveUrl: doc.driveUrl ?? doc.url ?? driveMatch?.driveUrl ?? '',
        }
      })

      signals.push({
        source: 'saleshub-plays',
        type: 'recommendation',
        headline: play.name ?? 'Unknown Play',
        detail: play.description ?? '',
        rawRelevance: 0.4,
        timestamp: kb.scrapedAt ?? new Date().toISOString(),
        metadata: {
          tdpAlignment: play.tdpAlignment ?? [],
          playType: 'strategic',
          personaRoles: persona.roles ?? [],
          painPoints: persona.painPoints ?? [],
          discoveryQuestions: persona.discoveryQuestions ?? [],
          valueProps: persona.valueProps ?? [],
          whatWinsThemOver: persona.whatWinsThemOver ?? [],
          documents: docs,
          regionalCampaigns: play.regionalCampaigns ?? [],
        },
      })
    }

    return signals
  },

  async cleanup(_customerName: string): Promise<void> {
    // No-op: SalesHub data is shared config, not per-customer cache
  },

  async syncNow(_customerName: string): Promise<void> {
    // Download fresh data from Drive before re-reading from disk
    try {
      await downloadSaleshubFromDrive()
    } catch (e: any) {
      console.warn(`[saleshub-module] Drive download failed during syncNow — falling back to disk: ${e.message}`)
    }
    // Force re-read of JSON files from disk by resetting the mtime cache
    resetKnowledgeCache()
    const stats = getKnowledgeStats()
    const totalRecords = stats.tdpCount + stats.salesPlayCount + stats.tacticCount
    if (totalRecords === 0) {
      console.warn(`[saleshub-module] zero-record guard: 0 TDPs + plays + tactics loaded`)
      FeatureModuleRegistry.recordOutcome('saleshub', { success: false, error: 'No records loaded' })
      return
    }
    console.log(
      `[saleshub-module] reloaded: ${stats.tdpCount} TDPs, ${stats.salesPlayCount} plays, ${stats.tacticCount} tactics`
    )
    FeatureModuleRegistry.recordOutcome('saleshub', {
      success: true,
      recordCount: totalRecords,
    })
  },
})
