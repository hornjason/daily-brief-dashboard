/**
 * GitHub Issue #451 — Cloud marketplace L3 Drive-shared upgrade
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MODULE_PATH = resolve(import.meta.dir, '../../src/modules/cloud-marketplace-module.ts')
const content = readFileSync(MODULE_PATH, 'utf-8')

describe('Cloud marketplace L3 upgrade (#451)', () => {

  test('export uses type-aware mimeType selection', () => {
    expect(content).toContain("exportMime = 'text/html'")
    expect(content).toContain("exportMime = 'text/plain'")
    expect(content).toContain("fileMeta.data.mimeType")
  })

  test('extractCloudData accepts slideText, htmlBody, and newsletterDate', () => {
    expect(content).toContain('async function extractCloudData(slideText: string, htmlBody: string, newsletterDate: string)')
  })

  test('EXTRACTION_PROMPT instructs extraction of URLs, pricing, and availability', () => {
    expect(content).toContain('url')
    expect(content).toContain('pricing')
    expect(content).toContain('availability')
  })

  test('CloudOffering type has url, pricing, availability fields', () => {
    const offeringMatch = content.match(/interface CloudOffering \{[\s\S]*?\}/)
    expect(offeringMatch).not.toBeNull()
    const block = offeringMatch![0]
    expect(block).toContain('url?: string')
    expect(block).toContain('pricing?: string')
    expect(block).toContain('availability?: string')
  })

  test('CloudProgram type has url field', () => {
    const programMatch = content.match(/interface CloudProgram \{[\s\S]*?\}/)
    expect(programMatch).not.toBeNull()
    expect(programMatch![0]).toContain('url?: string')
  })

  test('CloudIncentive type has url field', () => {
    const incentiveMatch = content.match(/interface CloudIncentive \{[\s\S]*?\}/)
    expect(incentiveMatch).not.toBeNull()
    expect(incentiveMatch![0]).toContain('url?: string')
  })

  test('responseSchema includes url, pricing, availability in offerings', () => {
    const schemaSection = content.slice(content.indexOf('const RESPONSE_SCHEMA'))
    expect(schemaSection).toContain("url: { type: 'string' }")
    expect(schemaSection).toContain("pricing: { type: 'string' }")
    expect(schemaSection).toContain("availability: { type: 'string' }")
  })

  test('ensureCloudMarketplaceFolder function exists', () => {
    expect(content).toContain('async function ensureCloudMarketplaceFolder(parentFolderId: string): Promise<string>')
  })

  test('uploadCloudMarketplaceJson function exists', () => {
    expect(content).toContain('async function uploadCloudMarketplaceJson(folderId: string, data: CloudMarketplaceCache): Promise<void>')
  })

  test('copySlideDecksToFolder function exists', () => {
    expect(content).toContain('async function copySlideDecksToFolder(folderId: string, fileIds: string[]): Promise<void>')
  })

  test('syncFromDrive function exists for L3 read path', () => {
    expect(content).toContain('async function syncFromDrive(): Promise<boolean>')
  })

  test('ensureFresh tries Drive sync before Gmail fallback', () => {
    const ensureFreshStart = content.indexOf('async ensureFresh(')
    const ensureFreshBlock = content.slice(ensureFreshStart, content.indexOf('async fetch(', ensureFreshStart))
    expect(ensureFreshBlock).toContain('syncFromDrive()')
    expect(ensureFreshBlock).toContain("this.syncNow('')")
  })

  test('syncNow passes htmlBody to extractCloudData', () => {
    expect(content).toContain('extractCloudData(slideText, htmlBody, newsletterDate)')
  })

  test('syncNow writes to Drive after local cache write', () => {
    const syncNowStart = content.indexOf('async syncNow()')
    const syncNowBlock = content.slice(syncNowStart)
    expect(syncNowBlock).toContain('ensureCloudMarketplaceFolder(parentId)')
    expect(syncNowBlock).toContain('copySlideDecksToFolder(cmFolder, fileIds)')
    expect(syncNowBlock).toContain('uploadCloudMarketplaceJson(cmFolder, cache)')
  })

  test('tech-stack cloud detection for customers without CCSP spend', () => {
    expect(content).toContain('techStackClouds')
    expect(content).toContain('hasCloudIntel')
    expect(content).toContain("tech-stack")
  })

  test('signals skip providers with no customer relationship (#434)', () => {
    // Providers with no CCSP spend and no tech-stack cloud intel are skipped
    expect(content).toContain('if (!hasSpend && !hasCloudIntel) continue')
    // Providers with tech-stack intel but no spend get a positioning headline
    expect(content).toContain('position Red Hat solutions')
  })
})
