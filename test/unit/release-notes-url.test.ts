import { describe, it, expect } from 'bun:test'
import { getReleaseNotesUrl } from '../../dashboard/src/lib/release-notes-url'

describe('getReleaseNotesUrl', () => {
  it('returns OCP release notes URL with full version', () => {
    const url = getReleaseNotesUrl('ocp', '4.17')
    expect(url).toBe('https://docs.redhat.com/en/documentation/openshift_container_platform/4.17/html/release_notes/')
  })

  it('returns RHEL release notes URL with major version only', () => {
    const url = getReleaseNotesUrl('rhel', '9.6')
    expect(url).toBe('https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/release_notes/')
  })

  it('returns AAP release notes URL', () => {
    const url = getReleaseNotesUrl('aap', '2.5')
    expect(url).toBe('https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.5/html/release_notes/')
  })

  it('returns null for unknown product slug', () => {
    expect(getReleaseNotesUrl('unknown-product', '1.0')).toBeNull()
  })

  it('returns null when version is null', () => {
    expect(getReleaseNotesUrl('ocp', null)).toBeNull()
  })
})
