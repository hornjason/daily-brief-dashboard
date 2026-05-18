/**
 * Release notes URL construction — maps product slug + version to official Red Hat docs.
 * Pure function, no side effects. Issue #249.
 */

const RELEASE_NOTES_PATTERNS: Record<string, (version: string) => string> = {
  ocp: (version) =>
    `https://docs.redhat.com/en/documentation/openshift_container_platform/${version}/html/release_notes/`,
  rhel: (version) => {
    // RHEL uses major version only (e.g., "9" not "9.6")
    const major = version.split('.')[0]
    return `https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/${major}/html/release_notes/`
  },
  aap: (version) =>
    `https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/${version}/html/release_notes/`,
}

/**
 * Get the official Red Hat release notes URL for a product.
 * Returns null if the product slug is unknown or version is missing.
 */
export function getReleaseNotesUrl(slug: string, version: string | null): string | null {
  if (!version) return null
  const builder = RELEASE_NOTES_PATTERNS[slug]
  if (!builder) return null
  return builder(version)
}
