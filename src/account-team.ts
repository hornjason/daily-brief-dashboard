/**
 * Account Team Data Contract
 *
 * Provides account team member information (AE + operator) for campaigns and account plans.
 * Uses user-settings.json for operator profile configuration.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getUserSettingsPath } from './config-reconciler.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { aes } from './server-state.ts'
import type { Customer, AccountTeamMember, AccountTeamRole, TerritoryTeamsCache, TerritoryTeamEntry, AE } from './types.ts'

// Module-level cache for territory teams data
let teamCacheData: TerritoryTeamsCache | null = null

/**
 * Invalidate the in-memory team cache.
 * Called after cache file updates to force re-read on next getAccountTeam() call.
 */
export function invalidateTeamCache(): void {
  teamCacheData = null
}

/**
 * Get the operator profile from user-settings.json
 * Returns null if no operator profile is configured
 */
export function getOperatorProfile(): AccountTeamMember | null {
  const settingsPath = getUserSettingsPath()

  if (!existsSync(settingsPath)) {
    return null
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const operatorName = settings.operatorName
    const operatorTitle = settings.operatorTitle

    if (!operatorName || !operatorTitle) {
      return null
    }

    // Derive role from title
    let role: AccountTeamRole = 'asa' // default
    const titleLower = operatorTitle.toLowerCase()

    if (titleLower.includes('ssp') || titleLower.includes('sales specialist')) {
      role = 'ssp'
    } else if (titleLower.includes('ssa')) {
      role = 'ssa'
    } else if (titleLower.includes('manager')) {
      role = 'manager'
    } else if (titleLower.includes('account solution architect')) {
      role = 'asa'
    }

    return {
      name: operatorName,
      title: operatorTitle,
      role,
    }
  } catch (e) {
    console.warn('[account-team] Failed to read operator profile:', e)
    return null
  }
}

export interface AccountTeamFilter {
  products?: string[]
}

/**
 * Get the full account team for a customer.
 * Returns array with AE first, then ASA (from territory data if available,
 * else operator profile), then pod specialists (SSP/SSA).
 *
 * Optional filter.products limits specialists to matching products only.
 * AE, ASA, Partner Sales, and Consulting Manager are always included.
 */
export function getAccountTeam(customer: Customer, filter?: AccountTeamFilter): AccountTeamMember[] {
  const team: AccountTeamMember[] = []

  // AE first
  if (customer.ae) {
    team.push({
      name: customer.ae,
      title: 'Account Executive',
      role: 'ae',
    })
  }

  // Load territory team data from cache (read once, cache in memory)
  if (!teamCacheData) {
    const cacheDir = process.env.CACHE_DIR ?? resolve(process.env.DATA_DIR ?? 'data', 'cache')
    const teamCachePath = resolve(cacheDir, 'territory-teams.json')

    if (existsSync(teamCachePath)) {
      try {
        teamCacheData = JSON.parse(readFileSync(teamCachePath, 'utf-8'))
      } catch {
        // Cache stays null, fall through to operator profile
      }
    }
  }

  // Find territory entry for this customer
  let territoryEntry: TerritoryTeamEntry | undefined
  if (teamCacheData) {
    const entries = Object.values(teamCacheData.teams)

    // Try territory code lookup first (more robust than name matching)
    const ae = aes.find(a => a.name === customer.ae)
    if (ae?.tableauTerritories?.length) {
      territoryEntry = teamCacheData.teams[ae.tableauTerritories[0]]
    }

    // Fallback to name matching if no territory code match
    if (!territoryEntry) {
      territoryEntry = entries.find(e => e.aeName === customer.ae)
    }
  }

  // ASA: use territory data if available, else operator profile
  if (territoryEntry?.asa) {
    team.push({
      name: territoryEntry.asa.name,
      title: 'Account Solution Architect',
      role: 'asa',
    })
  } else {
    const operator = getOperatorProfile()
    if (operator) {
      team.push(operator)
    }
  }

  // Add pod-level specialists (SSP/SSA), filtered by product if specified
  if (territoryEntry?.specialists) {
    const productFilter = filter?.products?.map(p => p.toLowerCase())
    for (const spec of territoryEntry.specialists) {
      if (productFilter && !productFilter.some(p => spec.product.toLowerCase().includes(p))) continue
      const title = `${spec.product} ${spec.role.toUpperCase()}`
      team.push({
        name: spec.name,
        title,
        role: spec.role,
      })
    }
  }

  // Add partner sales and consulting manager if present
  if (territoryEntry?.partnerSales) {
    team.push({
      name: territoryEntry.partnerSales.name,
      title: 'Partner Sales Executive',
      role: 'manager',
    })
  }

  if (territoryEntry?.consultingManager) {
    team.push({
      name: territoryEntry.consultingManager.name,
      title: 'Consulting Services Manager',
      role: 'manager',
    })
  }

  return team
}

/**
 * Persist territory team data to cache.
 * Writes to territory-teams.json and updates the in-memory cache.
 */
export function persistTeamCache(teamData: Record<string, TerritoryTeamEntry>): void {
  const cacheDir = process.env.CACHE_DIR ?? resolve(process.env.DATA_DIR ?? 'data', 'cache')
  const teamCachePath = resolve(cacheDir, 'territory-teams.json')
  const cache: TerritoryTeamsCache = {
    updatedAt: new Date().toISOString(),
    teams: teamData,
  }
  writeJsonAtomic(teamCachePath, cache)
  teamCacheData = cache  // update in-memory cache directly
  console.log(`[account-team] persisted team data for ${Object.keys(teamData).length} territories`)
}

/**
 * Convert account team to prompt-friendly context format.
 * Returns empty string if no team members.
 */
export function toPromptContext(team: AccountTeamMember[]): string {
  if (team.length === 0) return ''
  const lines = team.map(m => `- ${m.title}: ${m.name}`)
  return `## Account Team\n${lines.join('\n')}`
}
