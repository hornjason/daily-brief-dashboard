/**
 * src/lib/territory.ts
 *
 * Pure territory-string parser extracted from ccsp-scraper.ts to break the
 * circular dependency between `ccsp-scraper.ts` and `ccsp-tableau-fetch.ts`.
 *
 * Territory format examples:
 *
 * Commercial (5-part): WEST_COMM_CORP_NORTHWEST_TERR01
 *   subregion = WEST_COMM_CORP            (first 3 segments)
 *   pod       = WEST_COMM_CORP_NORTHWEST  (all but TERR suffix)
 *   segment   = Commercial
 *   region    = NA_COMM_COMMERCIAL
 *
 * Enterprise (4-part): CENTRAL_ENT_TOLA_TERR02
 *   subregion = CENTRAL_ENT_TOLA          (all segments before TERR)
 *   pod       = CENTRAL_ENT_TOLA_POD      (subregion + _POD suffix — required by Tableau)
 *   segment   = Enterprise
 *   region    = CENTRAL                   (first segment)
 *
 * Enterprise (5-part, multi-word): CENTRAL_ENT_HIGH_PLAINS_TERR03
 *   subregion = CENTRAL_ENT_HIGH_PLAINS   (all segments before TERR)
 *   pod       = CENTRAL_ENT_HIGH_PLAINS_POD
 *   segment   = Enterprise
 *   region    = CENTRAL
 */
export type TerritoryParts = {
  pod: string; subregion: string; segment: string; subsegment: string; region: string
}

export function parseTerritoryParts(territory: string): TerritoryParts {
  if (!/^[A-Z0-9_]+$/i.test(territory)) {
    throw new Error(`Invalid territory format: ${territory}`)
  }
  const parts = territory.split('_')
  const segType = parts[1] ?? ''
  const isEnterprise = segType === 'ENT'

  // Strip the TERR\d+ suffix to get base parts
  const terrIdx = parts.findIndex(p => /^TERR\d+$/i.test(p))
  const baseParts = terrIdx >= 0 ? parts.slice(0, terrIdx) : parts.slice(0, -1)

  if (isEnterprise) {
    // Enterprise: subregion is everything before TERR (handles multi-word like HIGH_PLAINS)
    const subregion = baseParts.join('_')
    const pod = subregion + '_POD'
    const region = parts[0] ?? 'CENTRAL'
    return { pod, subregion, segment: 'Enterprise', subsegment: 'Enterprise', region }
  } else {
    // Commercial: subregion is always first 3 segments; pod is everything before TERR
    const subregion = parts.slice(0, 3).join('_')
    const pod = baseParts.join('_')
    return { pod, subregion, segment: 'Commercial', subsegment: 'Commercial', region: 'NA_COMM_COMMERCIAL' }
  }
}

/**
 * Extract unique pod filter sets from a list of territory strings.
 *
 * When an AE has territories in multiple pods (e.g., CENTRAL_ENT_TOLA_TERR05
 * and WEST_COMM_CORP_NORTHWEST_TERR01), this returns one TerritoryParts per
 * unique pod so the caller can fetch CCSP data for each pod independently.
 *
 * De-duplicates by pod name — territories that map to the same pod
 * (e.g., CENTRAL_ENT_TOLA_TERR02 and CENTRAL_ENT_TOLA_TERR05) produce
 * only one entry.
 *
 * Returns an empty array if no valid territories are provided.
 */
export function getUniquePodFilters(territories: string[]): TerritoryParts[] {
  const seen = new Set<string>()
  const result: TerritoryParts[] = []
  for (const t of territories) {
    const parts = parseTerritoryParts(t)
    if (!seen.has(parts.pod)) {
      seen.add(parts.pod)
      result.push(parts)
    }
  }
  return result
}
