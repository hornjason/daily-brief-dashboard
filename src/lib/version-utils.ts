/**
 * Version comparison utilities (GitHub issue #73)
 *
 * Pure functions for comparing semantic versions and determining
 * whether to show an update notification.
 */

/**
 * Compare two semantic version strings.
 *
 * @returns 1 if `latest` is newer, 0 if same or dev build, -1 if current is newer
 */
export function compareVersions(current: string, latest: string): number {
  // Dev builds never trigger update checks
  if (current.includes('-dev')) return 0

  const parseCurrent = parseVersion(current)
  const parseLatest = parseVersion(latest)

  // Major version comparison
  if (parseLatest.major > parseCurrent.major) return 1
  if (parseLatest.major < parseCurrent.major) return -1

  // Minor version comparison
  if (parseLatest.minor > parseCurrent.minor) return 1
  if (parseLatest.minor < parseCurrent.minor) return -1

  // Patch version comparison
  if (parseLatest.patch > parseCurrent.patch) return 1
  if (parseLatest.patch < parseCurrent.patch) return -1

  // Prerelease comparison (RC, beta, alpha, etc.)
  // Stable > any prerelease
  if (!parseLatest.prerelease && parseCurrent.prerelease) return 1
  if (parseLatest.prerelease && !parseCurrent.prerelease) return -1

  // Both are prereleases — compare prerelease identifiers
  if (parseLatest.prerelease && parseCurrent.prerelease) {
    if (parseLatest.prerelease > parseCurrent.prerelease) return 1
    if (parseLatest.prerelease < parseCurrent.prerelease) return -1
  }

  return 0 // Versions are equal
}

/**
 * Determines whether to show update notification banner.
 */
export function shouldShowUpdate(current: string, latest: string): boolean {
  return compareVersions(current, latest) === 1
}

/**
 * Parse a semantic version string into components.
 */
function parseVersion(version: string): {
  major: number
  minor: number
  patch: number
  prerelease: string | null
} {
  // Remove 'v' prefix if present
  const clean = version.startsWith('v') ? version.slice(1) : version

  // Split on '-' to separate main version from prerelease
  const [mainVersion, prerelease] = clean.split('-')

  // Split main version into major.minor.patch
  const [major = '0', minor = '0', patch = '0'] = mainVersion.split('.')

  return {
    major: parseInt(major, 10) || 0,
    minor: parseInt(minor, 10) || 0,
    patch: parseInt(patch, 10) || 0,
    prerelease: prerelease ?? null,
  }
}
