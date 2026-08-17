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
  email?: string
  linkedinUrl?: string
  resolvedAt: string
  leadershipContext?: string  // Excerpt from intelligence Leadership section
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

// ── Title Cleaning ─────────────────────────────────────────────────────────

/**
 * Fix Gemini grounding concatenation artifacts where title words merge with
 * prepositions (e.g., "Officerof" → "Officer of"). (#1123)
 */
export function cleanExecutiveTitle(title: string): string {
  return title.replace(
    /(\b(?:Officer|Director|Manager|President|Head|VP|Chief|Executive|Analyst|Engineer|Architect|Specialist|Coordinator|Lead|Senior|Administrator))(of|at|for)\b/gi,
    '$1 $2'
  )
}

// ── Tier 1: Intelligence Brief Mining ───────────────────────────────────────

function cleanTitle(raw: string): string {
  return raw
    .replace(/,\s*(?:effective|replacing|succeeding)\b.*/i, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/,\s*(?:since|from|as of)\b.*/i, '')
    .trim()
}

/**
 * Extract per-contact context from the Leadership section of the intelligence brief.
 * Returns paragraph(s) mentioning the contact by name (up to 500 chars).
 */
export function extractContactContext(companyName: string, contactName: string): string | null {
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${companySlug(companyName)}.json`)
  if (!existsSync(intelPath)) return null

  try {
    const data = JSON.parse(readFileSync(intelPath, 'utf-8'))
    const companyText: string = data.company ?? ''

    const leadershipMatch = companyText.match(/##\s*Leadership[\s\S]*?(?=\n##\s|\n#\s|$)/i)
    if (!leadershipMatch) return null
    const section = leadershipMatch[0]

    const lastName = contactName.split(/\s+/).pop() ?? contactName
    const paragraphs = section.split(/\n\n+/)
    const relevant = paragraphs.filter(p => p.includes(contactName) || p.includes(lastName))

    if (relevant.length === 0) return null
    return relevant.join(' ').replace(/\*+/g, '').replace(/\s+/g, ' ').trim().slice(0, 500)
  } catch {
    return null
  }
}

/** Fallback roles to try when primary roles return no results */
const FALLBACK_ROLES = [
  'IT Operations Manager',
  'Cloud Architect',
  'Head of Engineering',
  'VP Engineering',
  'Director of Infrastructure',
  'Engineering Manager',
]

/**
 * Extract contacts from cached intelligence brief (Tier 1 — no API calls).
 * Parses the `## Leadership` section for name + title pairs.
 */
export function extractContactsFromIntelligence(companyName: string): ResolvedExecutive[] {
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${companySlug(companyName)}.json`)
  if (!existsSync(intelPath)) return []

  try {
    const data = JSON.parse(readFileSync(intelPath, 'utf-8'))
    const companyText: string = data.company ?? ''
    if (!companyText) return []

    // Find Leadership section
    const leadershipMatch = companyText.match(/##\s*Leadership[\s\S]*?(?=\n##\s|\n#\s|$)/i)
    if (!leadershipMatch) return []
    const section = leadershipMatch[0]

    const results: ResolvedExecutive[] = []
    const excludePatterns = /\b(terminated|departed|former|resigned|left|retired|stepping down)\b/i

    // Pattern 1: "Title Name" — e.g. "President and CEO Dhrupad Trivedi"
    const titleNamePattern = /(?:^|\n)\s*[-*]?\s*((?:President|CEO|CFO|COO|CTO|CIO|CISO|Chief|SVP|EVP|VP|Vice President|Director|Head of|General Manager|Managing Director)[^,\n]*?)\s+((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+))/gm
    let match: RegExpExecArray | null
    while ((match = titleNamePattern.exec(section)) !== null) {
      const surroundingText = section.substring(Math.max(0, match.index - 50), match.index + match[0].length + 50)
      if (excludePatterns.test(surroundingText)) continue
      const title = cleanTitle(match[1].trim())
      results.push({
        role: title,
        name: match[2].trim(),
        title,
        resolvedAt: new Date().toISOString(),
      })
    }

    // Pattern 2: "Name was appointed Title" — e.g. "Michelle Caron was appointed CFO"
    const appointedPattern = /((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+))\s+(?:was appointed|appointed as|named as|became|serves as|is the)\s+((?:President|CEO|CFO|COO|CTO|CIO|CISO|Chief|SVP|EVP|VP|Vice President|Director|Head of|General Manager)[^.;\n]*)/gi
    while ((match = appointedPattern.exec(section)) !== null) {
      const surroundingText = section.substring(Math.max(0, match.index - 50), match.index + match[0].length + 50)
      if (excludePatterns.test(surroundingText)) continue
      const title = cleanTitle(match[2].trim())
      results.push({
        role: title,
        name: match[1].trim(),
        title,
        resolvedAt: new Date().toISOString(),
      })
    }

    // Pattern 3: **Name**: Title (bold markdown)
    const boldPattern = /\*\*((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+))\*\*[:\s]+([^\n]+)/g
    while ((match = boldPattern.exec(section)) !== null) {
      const rawTitle = match[2].trim()
      const surroundingText = section.substring(Math.max(0, match.index - 50), match.index + match[0].length + 50)
      if (excludePatterns.test(surroundingText)) continue
      const title = cleanTitle(rawTitle)
      if (title.length > 5 && title.length < 100) {
        results.push({
          role: title,
          name: match[1].trim(),
          title,
          resolvedAt: new Date().toISOString(),
        })
      }
    }

    // Deduplicate by name, enrich with leadership context
    const seen = new Set<string>()
    return results.filter(r => {
      const key = r.name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map(r => ({
      ...r,
      leadershipContext: extractContactContext(companyName, r.name) ?? undefined,
    }))
  } catch {
    return []
  }
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve real executives for a list of persona roles at a company.
 * Three-tier resolution:
 *   Tier 1: Mine intelligence brief (local, no API calls)
 *   Tier 2: Gemini grounding search (primary + fallback roles)
 *   Tier 3: Email enrichment (infer email from company domain)
 *
 * Returns only successfully resolved executives (may be fewer than requested roles).
 */
export async function resolveExecutivesByRole(
  roles: string[],
  companyName: string,
  companyDomain?: string,
): Promise<ResolvedExecutive[]> {
  if (roles.length === 0) return []

  // ── Tier 1: Mine intelligence brief ────────────────────────────────────
  const intelContacts = extractContactsFromIntelligence(companyName)
  const results: ResolvedExecutive[] = [...intelContacts]
  const seenNames = new Set(results.map(r => r.name.toLowerCase()))

  if (intelContacts.length > 0) {
    console.log(`[executive-resolver] Tier 1: Found ${intelContacts.length} contacts from intelligence brief for ${companyName}`)
  }

  // Check cache for remaining roles
  const cached = readCache(companyName)
  const uncachedRoles: string[] = []

  for (const role of roles) {
    // Skip if Tier 1 already found someone for this role
    if (results.some(r => r.role.toLowerCase() === role.toLowerCase())) continue
    if (cached?.executives[role]) {
      const cachedExec = cached.executives[role]
      if (!seenNames.has(cachedExec.name.toLowerCase())) {
        results.push(cachedExec)
        seenNames.add(cachedExec.name.toLowerCase())
      }
    } else {
      uncachedRoles.push(role)
    }
  }

  // Calculate how many more we need
  const needed = 6 - results.length

  // ── Tier 2: Gemini grounding (primary + fallback roles) ────────────────
  if (needed > 0 && uncachedRoles.length > 0) {
    try {
      const { callGemini } = await import('../gemini-call.ts')

      // Try primary uncached roles first
      const rolesToSearch = [...uncachedRoles]

      // Add fallback roles if we still need more
      if (rolesToSearch.length < needed) {
        const existingRolesLower = new Set([...roles, ...results.map(r => r.role)].map(r => r.toLowerCase()))
        for (const fallback of FALLBACK_ROLES) {
          if (rolesToSearch.length >= needed) break
          if (!existingRolesLower.has(fallback.toLowerCase())) {
            rolesToSearch.push(fallback)
          }
        }
      }

      const roleList = rolesToSearch.map(r => `- ${r}`).join('\n')
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
          if (seenNames.has(entry.name.toLowerCase())) continue
          seenNames.add(entry.name.toLowerCase())
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
      console.warn(`[executive-resolver] Tier 2 grounding search failed for ${companyName}:`, e?.message ?? e)
    }
  }

  // ── Tier 3: Email enrichment ───────────────────────────────────────────
  if (companyDomain) {
    for (const exec of results) {
      if (exec.email) continue
      const nameParts = exec.name.trim().split(/\s+/)
      if (nameParts.length >= 2) {
        const firstInitial = nameParts[0][0].toLowerCase()
        const lastName = nameParts[nameParts.length - 1].toLowerCase()
        exec.email = `${firstInitial}${lastName}@${companyDomain}`
      }
    }
    console.log(`[executive-resolver] Tier 3: Enriched ${results.filter(r => r.email).length} contacts with inferred emails`)
  }

  return results.map(r => ({ ...r, title: cleanExecutiveTitle(r.title) }))
}
