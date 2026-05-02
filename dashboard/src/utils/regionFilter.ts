/**
 * Shared filter utilities for hero install region/pod access.
 * Used in SetupPage to filter podOptions down to the user's selected pods.
 */

/** Returns true only when value is a non-empty string array (pod filter is active). */
export function isPodFilterActive(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
}

/**
 * Extract the bare pod key from a qualified key: "${regionId}.${podKey}".
 * Handles regionIds that contain hyphens but no dots.
 * e.g. "west-commercial.WEST_COMM_CORP_NORTHWEST" → "WEST_COMM_CORP_NORTHWEST"
 */
export function podKeyFromQualified(qualifiedKey: string): string {
  const idx = qualifiedKey.indexOf('.')
  if (idx === -1 || idx === qualifiedKey.length - 1) return qualifiedKey
  return qualifiedKey.slice(idx + 1)
}

/**
 * Filter podOptions down to only the enabled pods.
 * If enabledPods is inactive (undefined / null / []) returns the full list.
 */
export function filterPodOptions<T extends { value: string }>(
  options: ReadonlyArray<T>,
  enabledPods: string[] | undefined,
): ReadonlyArray<T> {
  if (!isPodFilterActive(enabledPods)) return options
  const enabledKeys = new Set(enabledPods.map(podKeyFromQualified))
  return options.filter(o => enabledKeys.has(o.value))
}
