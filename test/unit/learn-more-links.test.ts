/**
 * Learn More link validation (Issue #76)
 *
 * Tests that FeatureDetailPanel "Learn More" button uses feature-specific documentation URLs
 * from sourceUrls/enrichmentUrls. If those are empty but releaseNotesSection exists,
 * should construct a deep link to that section.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('FeatureDetailPanel Learn More links', () => {
  it('should use feature.sourceUrls[0] when available', () => {
    const componentPath = join(__dirname, '../../dashboard/src/components/FeatureDetailPanel.tsx')
    const componentSource = readFileSync(componentPath, 'utf-8')

    // Verify that primaryUrl is derived from sourceUrls or enrichmentUrls
    expect(componentSource).toContain('feature.sourceUrls')
    expect(componentSource).toContain('feature.enrichmentUrls')

    // Verify the Learn More link uses primaryUrl (not a hardcoded generic URL)
    const primaryUrlAssignment = componentSource.match(
      /const\s+primaryUrl\s*=[\s\S]*?(?=\n\s*return)/
    )
    expect(primaryUrlAssignment).toBeTruthy()

    const primaryUrlCode = primaryUrlAssignment![0]

    // Must prioritize sourceUrls first
    const sourceUrlsIndex = primaryUrlCode.indexOf('sourceUrls')
    const enrichmentUrlsIndex = primaryUrlCode.indexOf('enrichmentUrls')
    expect(sourceUrlsIndex).toBeGreaterThan(-1)
    expect(enrichmentUrlsIndex).toBeGreaterThan(-1)
    expect(sourceUrlsIndex).toBeLessThan(enrichmentUrlsIndex) // sourceUrls comes before enrichmentUrls

    // Must NOT contain any hardcoded generic URLs
    expect(primaryUrlCode).not.toContain('access.redhat.com/')
    expect(primaryUrlCode).not.toContain('/products/')
    expect(primaryUrlCode).not.toContain('redhat.com/en/technologies')

    // Verify Learn More href uses primaryUrl variable
    const learnMoreHref = componentSource.match(/href=\{primaryUrl\}/)
    expect(learnMoreHref).toBeTruthy()
  })

  it('should hide Learn More button when no URLs are available', () => {
    const componentPath = join(__dirname, '../../dashboard/src/components/FeatureDetailPanel.tsx')
    const componentSource = readFileSync(componentPath, 'utf-8')

    // Verify conditional rendering based on primaryUrl
    const learnMoreSection = componentSource.match(
      /\{primaryUrl\s+&&[\s\S]*?Learn More[\s\S]*?\}/
    )
    expect(learnMoreSection).toBeTruthy()
  })

  it('should prefer sourceUrls over enrichmentUrls', () => {
    const componentPath = join(__dirname, '../../dashboard/src/components/FeatureDetailPanel.tsx')
    const componentSource = readFileSync(componentPath, 'utf-8')

    const primaryUrlAssignment = componentSource.match(
      /const\s+primaryUrl\s*=[\s\S]*?(?=\n\s*return)/
    )!

    // Check that sourceUrls.find comes before enrichmentUrls.find in the logical OR chain
    const code = primaryUrlAssignment[0]
    const sourceMatch = code.match(/sourceUrls\.find/)
    const enrichMatch = code.match(/enrichmentUrls\.find/)

    expect(sourceMatch).toBeTruthy()
    expect(enrichMatch).toBeTruthy()
    expect(sourceMatch!.index).toBeLessThan(enrichMatch!.index!)
  })

  it('should filter for valid HTTP/HTTPS URLs only', () => {
    const componentPath = join(__dirname, '../../dashboard/src/components/FeatureDetailPanel.tsx')
    const componentSource = readFileSync(componentPath, 'utf-8')

    const primaryUrlAssignment = componentSource.match(
      /const\s+primaryUrl\s*=[\s\S]*?(?=\n\s*return)/
    )!

    // Must use regex test or match to filter for http/https URLs
    const code = primaryUrlAssignment[0]
    // Check for either .test() or .match() with http/https pattern
    const hasHttpFilter = code.includes('https?') || code.includes('http://')
    expect(hasHttpFilter).toBe(true)
  })

  it('should construct deep link from releaseNotesSection when sourceUrls/enrichmentUrls are empty', () => {
    const componentPath = join(__dirname, '../../dashboard/src/components/FeatureDetailPanel.tsx')
    const componentSource = readFileSync(componentPath, 'utf-8')

    // Check for fallback logic that uses releaseNotesSection to construct URL
    const primaryUrlAssignment = componentSource.match(
      /const\s+primaryUrl\s*=[\s\S]*?(?=\n\s*return)/
    )!

    const code = primaryUrlAssignment[0]

    // Should use releaseNotesSection to construct URL when sourceUrls/enrichmentUrls empty
    // The primaryUrl assignment should include releaseNotesSection-based URL construction
    const hasReleaseNotesFallback = code.includes('releaseNotesSection')

    // This test MUST fail initially - releaseNotesSection should be in primaryUrl logic
    expect(hasReleaseNotesFallback).toBe(true)
  })
})
