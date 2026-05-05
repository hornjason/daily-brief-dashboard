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
 *   pod       = WEST_COMM_CORP_NORTHWEST  (all but last segment)
 *   segment   = Commercial
 *   region    = NA_COMM_COMMERCIAL
 *
 * Enterprise (4-part): CENTRAL_ENT_TOLA_TERR02
 *   subregion = CENTRAL_ENT_TOLA          (first 3 segments)
 *   pod       = CENTRAL_ENT_TOLA_POD      (first 3 + _POD suffix — required by Tableau)
 *   segment   = Enterprise
 *   region    = CENTRAL                   (first segment)
 */
export function parseTerritoryParts(territory: string): {
  pod: string; subregion: string; segment: string; subsegment: string; region: string
} {
  if (!/^[A-Z0-9_]+$/i.test(territory)) {
    throw new Error(`Invalid territory format: ${territory}`)
  }
  const parts = territory.split('_')
  const segType = parts[1] ?? ''
  const isEnterprise = segType === 'ENT'

  const subregion = parts.slice(0, 3).join('_')
  // Enterprise PODs carry a _POD suffix in Tableau; commercial do not
  const pod = isEnterprise ? subregion + '_POD' : parts.slice(0, -1).join('_')
  const segment = isEnterprise ? 'Enterprise' : 'Commercial'
  const region = isEnterprise ? (parts[0] ?? 'CENTRAL') : 'NA_COMM_COMMERCIAL'

  return { pod, subregion, segment, subsegment: segment, region }
}
