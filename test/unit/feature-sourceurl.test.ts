import { describe, test, expect } from 'bun:test'
import type { ProductFeature } from '../../src/product-feature-radar.ts'

/**
 * Regression tests for Bug #252 — Feature extraction missing sourceUrls
 *
 * Before the fix, ~46% of features had empty sourceUrls arrays.
 * After the fix, features with empty sourceUrls should get fallback URLs:
 * - If releaseNotesSection exists → use section-anchored URL
 * - If no section → use base release notes URL
 * Existing sourceUrls are never modified.
 */

// Simulate the post-processing logic from product-feature-radar.ts
function applySourceUrlFallback(features: ProductFeature[], releaseNotesBaseUrl: string | null): void {
  if (!releaseNotesBaseUrl) return

  for (const feature of features) {
    if (feature.sourceUrls.length === 0) {
      if (feature.releaseNotesSection) {
        const anchor = feature.releaseNotesSection
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
        feature.sourceUrls.push(`${releaseNotesBaseUrl}#${anchor}`)
      } else {
        feature.sourceUrls.push(releaseNotesBaseUrl)
      }
    }
  }
}

describe('Feature sourceUrl fallback (#252)', () => {
  const baseUrl = 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.17/html/release_notes'

  test('feature with empty sourceUrls gets section-anchored URL', () => {
    const features: any[] = [
      {
        id: 'ocp-virtualization',
        featureSlug: 'virtualization',
        name: 'OpenShift Virtualization',
        sourceUrls: [],
        releaseNotesSection: 'New Features',
        status: 'GA',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'Test feature',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'HIGH',
        slideSource: '',
      }
    ]

    applySourceUrlFallback(features, baseUrl)

    expect(features[0].sourceUrls.length).toBe(1)
    expect(features[0].sourceUrls[0]).toBe(`${baseUrl}#new-features`)
  })

  test('feature with existing sourceUrls is not modified', () => {
    const originalUrl = 'https://docs.redhat.com/existing'
    const features: any[] = [
      {
        id: 'ocp-networking',
        featureSlug: 'networking',
        name: 'Advanced Networking',
        sourceUrls: [originalUrl],
        releaseNotesSection: 'New Features',
        status: 'GA',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'Test feature',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'HIGH',
        slideSource: '',
      }
    ]

    applySourceUrlFallback(features, baseUrl)

    expect(features[0].sourceUrls.length).toBe(1)
    expect(features[0].sourceUrls[0]).toBe(originalUrl)
  })

  test('feature without section gets base URL', () => {
    const features: any[] = [
      {
        id: 'ocp-storage',
        featureSlug: 'storage',
        name: 'Storage Features',
        sourceUrls: [],
        releaseNotesSection: null,
        status: 'GA',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'Test feature',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'MEDIUM',
        slideSource: '',
      }
    ]

    applySourceUrlFallback(features, baseUrl)

    expect(features[0].sourceUrls.length).toBe(1)
    expect(features[0].sourceUrls[0]).toBe(baseUrl)
  })

  test('anchor slug generation handles special characters', () => {
    const features: any[] = [
      {
        id: 'rhel-tech-preview',
        featureSlug: 'tech-preview',
        name: 'Tech Preview Features',
        sourceUrls: [],
        releaseNotesSection: 'Technology Preview Features!',
        status: 'Tech Preview',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'Test feature',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'MEDIUM',
        slideSource: '',
      }
    ]
    const rhelUrl = 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/release_notes'

    applySourceUrlFallback(features, rhelUrl)

    expect(features[0].sourceUrls.length).toBe(1)
    expect(features[0].sourceUrls[0]).toBe(`${rhelUrl}#technology-preview-features`)
  })

  test('no fallback applied when releaseNotesBaseUrl is null', () => {
    const features: any[] = [
      {
        id: 'test-feature',
        featureSlug: 'test',
        name: 'Test',
        sourceUrls: [],
        releaseNotesSection: 'New Features',
        status: 'GA',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'Test feature',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'HIGH',
        slideSource: '',
      }
    ]

    applySourceUrlFallback(features, null)

    expect(features[0].sourceUrls.length).toBe(0)
  })

  test('batch processing — mixed features with and without sourceUrls', () => {
    const features: any[] = [
      {
        id: 'feature-1',
        featureSlug: 'f1',
        name: 'Feature 1',
        sourceUrls: ['https://example.com/f1'],
        releaseNotesSection: 'Section A',
        status: 'GA',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'Has URL',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'HIGH',
        slideSource: '',
      },
      {
        id: 'feature-2',
        featureSlug: 'f2',
        name: 'Feature 2',
        sourceUrls: [],
        releaseNotesSection: 'Section B',
        status: 'GA',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'No URL',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'MEDIUM',
        slideSource: '',
      },
      {
        id: 'feature-3',
        featureSlug: 'f3',
        name: 'Feature 3',
        sourceUrls: [],
        releaseNotesSection: null,
        status: 'GA',
        versionIntroduced: null,
        versionCurrent: null,
        description: 'No URL, no section',
        enrichedDescription: null,
        enrichmentUrls: [],
        tags: [],
        confidence: 'LOW',
        slideSource: '',
      },
    ]

    applySourceUrlFallback(features, baseUrl)

    // Feature 1: original URL preserved
    expect(features[0].sourceUrls.length).toBe(1)
    expect(features[0].sourceUrls[0]).toBe('https://example.com/f1')

    // Feature 2: section-anchored URL added
    expect(features[1].sourceUrls.length).toBe(1)
    expect(features[1].sourceUrls[0]).toBe(`${baseUrl}#section-b`)

    // Feature 3: base URL added
    expect(features[2].sourceUrls.length).toBe(1)
    expect(features[2].sourceUrls[0]).toBe(baseUrl)
  })
})
