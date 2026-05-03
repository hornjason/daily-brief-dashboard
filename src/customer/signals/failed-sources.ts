// BKL-ARCH-23: Failed-source self-closing tags. Emits <source ... count="0" />
// for any scraper whose status is failed AND whose corresponding bundle has
// no rows. Byte-identical to legacy customer.ts emission.

import type { ScraperName, ScraperStatusMap } from '../../scraper-status-store.ts'
import type { SignalBundle, RenderContext } from './types.ts'

const FAILED_SOURCE_MAP: Array<[ScraperName, string, SignalBundle['kind']]> = [
  ['supportable', 'subscriptions', 'subscriptions'],
  ['rh-cases',    'support_cases', 'cases'],
  ['sf-pipeline', 'pipeline',      'pipeline'],
  ['ccsp',        'cloud_spend',   'ccsp'],
]

/**
 * Determine whether a bundle of `kind` carries any rows. The discriminated
 * union puts items under different fields per kind — `subscriptions` uses
 * `summary` + `detailed`; everything else uses `items`.
 */
function bundleHasData(bundle: SignalBundle | null | undefined): boolean {
  if (!bundle) return false
  if (bundle.kind === 'subscriptions') {
    return bundle.summary.length > 0 || bundle.detailed.length > 0
  }
  // Other kinds — look up `items` length.
  // (`docs`, `cases`, `meetings`, `emails`, `pipeline`, `ccsp` all expose `items`.)
  return ((bundle as { items?: { length: number } }).items?.length ?? 0) > 0
}

export function renderFailedSources(
  bundles: ReadonlyArray<SignalBundle | null>,
  scraperStatus: ScraperStatusMap,
  ctx: RenderContext,
): string {
  const { escapeXml } = ctx
  let xml = ''
  for (const [scraper, sourceType, kind] of FAILED_SOURCE_MAP) {
    const matching = bundles.find(b => b?.kind === kind)
    if (bundleHasData(matching)) continue
    const entry = scraperStatus[scraper]
    if (entry && (entry.lastError || entry.state === 'failed')) {
      xml += `<source type="${sourceType}" status="scraper_failed" last_success="${escapeXml(entry.lastSuccess ?? 'never')}" count="0" />\n\n`
    }
  }
  return xml
}
