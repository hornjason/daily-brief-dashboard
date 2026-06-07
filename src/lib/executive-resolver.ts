/**
 * Executive Resolver — Find real executives by role at a company (#670)
 *
 * Uses Gemini grounding to search for executives matching campaign persona roles
 * (e.g., "VP Infrastructure" at "A10 Networks"). Caches results per company domain
 * to avoid redundant grounding calls.
 *
 * Falls back gracefully — returns empty array when grounding fails.
 */

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from './atomic-write.ts'
import { CACHE_DIR } from './paths.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedExecutive {
  role: string        // Original persona role (e.g., "VP Infrastructure")
  name: string        // Found executive name
  title: string       // Actual title at the company
  linkedinUrl?: string
  resolvedAt: string
}

interface ExecutiveCache {
  companyName: string
  resolvedAt: string
  executives: Record<string, ResolvedExecutive>  // keyed by role
}

// ── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days — executives don't change often

function getCacheDir(): string {
  const dir = resolve(CACHE_DIR, 'executive-profiles')
  mkdirSync(dir, { recursive: true })
  return dir
}

function companySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function readCache(companyName: string): ExecutiveCache | null {
  const path = resolve(getCacheDir(), `${companySlug(companyName)}.json`)
  if (!existsSync(path)) return null
  try {
    const data: ExecutiveCache = JSON.parse(readFileSync(path, 'utf-8'))
    // Check TTL
    const age = Date.now() - new Date(data.resolvedAt).getTime()
    if (age > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function writeCache(companyName: string, executives: Record<string, ResolvedExecutive>): void {
  const path = resolve(getCacheDir(), `${companySlug(companyName)}.json`)
  const cache: ExecutiveCache = {
    companyName,
    resolvedAt: new Date().toISOString(),
    executives,
  }
  writeJsonAtomic(path, cache)
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve real executives for a list of persona roles at a company.
 * Uses Gemini grounding to search LinkedIn. Caches results.
 *
 * Returns only successfully resolved executives (may be fewer than requested roles).
 */
export async function resolveExecutivesByRole(
  roles: string[],
  companyName: string,
): Promise<ResolvedExecutive[]> {
  if (roles.length === 0) return []

  // Check cache first
  const cached = readCache(companyName)
  const results: ResolvedExecutive[] = []
  const uncachedRoles: string[] = []

  for (const role of roles) {
    if (cached?.executives[role]) {
      results.push(cached.executives[role])
    } else {
      uncachedRoles.push(role)
    }
  }

  // If all roles are cached, return immediately
  if (uncachedRoles.length === 0) return results

  // Batch resolve uncached roles via Gemini grounding
  try {
    const { callGemini } = await import('../gemini-call.ts')

    const roleList = uncachedRoles.map(r => `- ${r}`).join('\n')
    const result = await callGemini(
      'You are a professional identity researcher. Given a company name and a list of executive roles, find the real people who hold these positions. Search LinkedIn and public sources. Return ONLY a JSON array of objects with fields: role (the requested role), name (person\'s full name), title (their actual title), linkedinUrl (full LinkedIn profile URL). If you cannot find someone for a role with certainty, omit that role from the array. Never guess — only include confirmed matches.',
      `Find the current executives at "${companyName}" for these roles:\n${roleList}\n\nSearch LinkedIn for each: "{role}" site:linkedin.com/in "${companyName}"\nReturn JSON array: [{"role":"...","name":"...","title":"...","linkedinUrl":"..."}]`,
      {
        callType: 'executive-role-resolution',
        customerName: companyName,
        grounding: true,
        timeoutMs: 45_000,
      }
    )

    // Parse JSON array from response
    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed: Array<{ role: string; name: string; title: string; linkedinUrl?: string }> = JSON.parse(jsonMatch[0])
      const newExecs: Record<string, ResolvedExecutive> = {}

      for (const entry of parsed) {
        if (!entry.name || !entry.role) continue
        const exec: ResolvedExecutive = {
          role: entry.role,
          name: entry.name,
          title: entry.title ?? entry.role,
          linkedinUrl: entry.linkedinUrl || undefined,
          resolvedAt: new Date().toISOString(),
        }
        newExecs[entry.role] = exec
        results.push(exec)
      }

      // Merge with existing cache and persist
      const mergedExecs = { ...(cached?.executives ?? {}), ...newExecs }
      writeCache(companyName, mergedExecs)
    }
  } catch (e: any) {
    console.warn(`[executive-resolver] Grounding search failed for ${companyName}:`, e?.message ?? e)
    // Non-fatal — return whatever we have from cache
  }

  return results
}
