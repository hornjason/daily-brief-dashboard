/**
 * News Configuration — Externalized search and scoring config
 *
 * Reads from config/news-config.json with fallback to defaults.
 * Provides validation for runtime updates via admin API.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// ── Types ────────────────────────────────────────────────────────────────────

export interface NewsConfig {
  signalTypes: string[]
  criticalKeywords: string[]
  excludeKeywords: string[]
  defaultThreshold: number
  searchDepthDays: number
  significanceGuidelines: Record<string, string>
}

// ── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: NewsConfig = {
  signalTypes: [
    'leadership',
    'acquisition',
    'partnership',
    'earnings',
    'layoffs',
    'product launches',
    'regulatory issues',
    'major business developments',
    'thought leadership',
    'product announcement',
    'blog post',
    'company news',
    'security advisory',
    'competitive positioning',
  ],
  criticalKeywords: [
    'bankruptcy',
    'major acquisition',
    'C-suite departure',
    'acquisition',
    'earnings surprise',
    'cybersecurity',
    'AI',
    'digital transformation',
    'cloud migration',
    'infrastructure modernization',
  ],
  excludeKeywords: ['routine press release', 'minor mention'],
  defaultThreshold: 5,
  searchDepthDays: 14,
  significanceGuidelines: {
    '9-10': 'Critical (bankruptcy, major acquisition, C-suite departure)',
    '7-8': 'Important (new tech initiative, major partnership, earnings surprise)',
    '4-6': 'Notable (product launch, minor leadership change, industry report)',
    '1-3': 'Low (routine press release, minor mention)',
  },
}

// ── Config file path ─────────────────────────────────────────────────────────

const CONFIG_PATH = resolve(process.env.CONFIG_DIR ?? 'config', 'news-config.json')

// ── Load config ──────────────────────────────────────────────────────────────

let cachedConfig: NewsConfig | null = null

export function loadNewsConfig(): NewsConfig {
  // Return cached config if already loaded
  if (cachedConfig) {
    return cachedConfig
  }

  // If config file exists, read it
  if (existsSync(CONFIG_PATH)) {
    try {
      const data = readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(data)

      // Validate required fields
      if (!parsed.signalTypes || !Array.isArray(parsed.signalTypes)) {
        console.warn('[news-config] Invalid signalTypes in config file, using defaults')
        cachedConfig = DEFAULT_CONFIG
        return DEFAULT_CONFIG
      }

      if (!parsed.criticalKeywords || !Array.isArray(parsed.criticalKeywords)) {
        console.warn('[news-config] Invalid criticalKeywords in config file, using defaults')
        cachedConfig = DEFAULT_CONFIG
        return DEFAULT_CONFIG
      }

      if (!parsed.excludeKeywords || !Array.isArray(parsed.excludeKeywords)) {
        console.warn('[news-config] Invalid excludeKeywords in config file, using defaults')
        cachedConfig = DEFAULT_CONFIG
        return DEFAULT_CONFIG
      }

      if (typeof parsed.defaultThreshold !== 'number' || parsed.defaultThreshold < 1 || parsed.defaultThreshold > 10) {
        console.warn('[news-config] Invalid defaultThreshold in config file, using defaults')
        cachedConfig = DEFAULT_CONFIG
        return DEFAULT_CONFIG
      }

      if (typeof parsed.searchDepthDays !== 'number' || parsed.searchDepthDays < 1) {
        console.warn('[news-config] Invalid searchDepthDays in config file, using defaults')
        cachedConfig = DEFAULT_CONFIG
        return DEFAULT_CONFIG
      }

      cachedConfig = parsed as NewsConfig
      return cachedConfig
    } catch (e: any) {
      console.warn(`[news-config] Failed to read config file: ${e.message}, using defaults`)
      cachedConfig = DEFAULT_CONFIG
      return DEFAULT_CONFIG
    }
  }

  // If config file does not exist, use defaults
  console.log('[news-config] Config file not found, using defaults')
  cachedConfig = DEFAULT_CONFIG
  return DEFAULT_CONFIG
}

// ── Update config ────────────────────────────────────────────────────────────

export function updateNewsConfig(newConfig: Partial<NewsConfig>): { success: boolean; error?: string } {
  try {
    // Validate new config values before merging
    if (newConfig.signalTypes !== undefined) {
      if (!Array.isArray(newConfig.signalTypes) || newConfig.signalTypes.length === 0) {
        return { success: false, error: 'signalTypes must be a non-empty array' }
      }
    }

    if (newConfig.criticalKeywords !== undefined) {
      if (!Array.isArray(newConfig.criticalKeywords)) {
        return { success: false, error: 'criticalKeywords must be an array' }
      }
    }

    if (newConfig.excludeKeywords !== undefined) {
      if (!Array.isArray(newConfig.excludeKeywords)) {
        return { success: false, error: 'excludeKeywords must be an array' }
      }
    }

    if (newConfig.defaultThreshold !== undefined) {
      if (typeof newConfig.defaultThreshold !== 'number' || newConfig.defaultThreshold < 1 || newConfig.defaultThreshold > 10) {
        return { success: false, error: 'defaultThreshold must be a number between 1 and 10' }
      }
    }

    if (newConfig.searchDepthDays !== undefined) {
      if (typeof newConfig.searchDepthDays !== 'number' || newConfig.searchDepthDays < 1 || newConfig.searchDepthDays > 365) {
        return { success: false, error: 'searchDepthDays must be a number between 1 and 365' }
      }
    }

    // Load current config and merge with new values
    const current = loadNewsConfig()
    const updated: NewsConfig = {
      ...current,
      ...newConfig,
    }

    // Write to file
    writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 })

    // Update cache
    cachedConfig = updated

    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

// ── Get default config ───────────────────────────────────────────────────────

export function getDefaultConfig(): NewsConfig {
  return { ...DEFAULT_CONFIG }
}

// ── Reset cache (for testing) ────────────────────────────────────────────────

export function resetConfigCache(): void {
  cachedConfig = null
}
