// test/unit/tech-stack-grounded.test.ts
// GitHub Issue #386 — Verify grounded search in extractTechnologies()
// Tests that the Gemini request body includes google search tools and source attribution.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MODULE_PATH = resolve(import.meta.dir, '../../src/modules/tech-stack-module.ts')
const moduleSource = readFileSync(MODULE_PATH, 'utf-8')

describe('tech-stack-module grounded search (#386)', () => {

  test('AC-1: extractTechnologies request includes tools: [{ googleSearch: {} }]', () => {
    // The extractTechnologies function must include google search tool in request body
    // Find the extractTechnologies function and verify it has googleSearch in its body
    const fnStart = moduleSource.indexOf('async function extractTechnologies')
    expect(fnStart).toBeGreaterThan(-1)

    // Find the end of the function (next top-level async function or module registration)
    const fnEnd = moduleSource.indexOf('async function enrichProprietaryTech', fnStart)
    const fnBody = moduleSource.slice(fnStart, fnEnd)

    // Must have tools with googleSearch
    expect(fnBody).toContain('googleSearch')
    expect(fnBody).toMatch(/tools:\s*\[\s*\{\s*googleSearch:\s*\{\s*\}\s*\}\s*\]/)
  })

  test('AC-2: system prompt instructs active research from job postings, case studies, partner announcements', () => {
    const fnStart = moduleSource.indexOf('async function extractTechnologies')
    const fnEnd = moduleSource.indexOf('async function enrichProprietaryTech', fnStart)
    const fnBody = moduleSource.slice(fnStart, fnEnd)

    expect(fnBody).toContain('job posting')
    expect(fnBody).toContain('case stud')
    expect(fnBody).toContain('partner announcement')
    expect(fnBody).toContain('engineering blog')
  })

  test('AC-3: user prompt asks for source URL attribution', () => {
    const fnStart = moduleSource.indexOf('async function extractTechnologies')
    const fnEnd = moduleSource.indexOf('async function enrichProprietaryTech', fnStart)
    const fnBody = moduleSource.slice(fnStart, fnEnd)

    // JSON schema in the prompt must include source field
    expect(fnBody).toContain('"source"')
    // Must instruct to include URL or source
    expect(fnBody).toMatch(/source.*[Uu][Rr][Ll]|[Uu][Rr][Ll].*source/)
  })

  test('AC-4: TechEntry interface includes source?: string', () => {
    const interfaceStart = moduleSource.indexOf('interface TechEntry {')
    expect(interfaceStart).toBeGreaterThan(-1)
    const interfaceEnd = moduleSource.indexOf('}', interfaceStart)
    const interfaceBody = moduleSource.slice(interfaceStart, interfaceEnd)

    expect(interfaceBody).toContain('source?: string')
  })

  test('AC-5: parsed response extracts source from response text', () => {
    const fnStart = moduleSource.indexOf('async function extractTechnologies')
    const fnEnd = moduleSource.indexOf('async function enrichProprietaryTech', fnStart)
    const fnBody = moduleSource.slice(fnStart, fnEnd)

    // The mapping must include source extraction
    expect(fnBody).toMatch(/source:\s*String\(t\.source/)
  })

  test('AC-6: signals() includes source in Signal metadata', () => {
    const signalsStart = moduleSource.indexOf('async signals(customerSlug: string)')
    expect(signalsStart).toBeGreaterThan(-1)
    const signalsEnd = moduleSource.indexOf('async syncNow', signalsStart)
    const signalsBody = moduleSource.slice(signalsStart, signalsEnd)

    expect(signalsBody).toContain('source: tech.source')
  })

  test('AC-7: JSON output schema in prompt includes source field', () => {
    const fnStart = moduleSource.indexOf('async function extractTechnologies')
    const fnEnd = moduleSource.indexOf('async function enrichProprietaryTech', fnStart)
    const fnBody = moduleSource.slice(fnStart, fnEnd)

    // The JSON example in the user prompt must show the source field
    expect(fnBody).toContain('"source":')
  })

  test('AC-8: timeout increased to 60_000 for grounded search', () => {
    const fnStart = moduleSource.indexOf('async function extractTechnologies')
    const fnEnd = moduleSource.indexOf('async function enrichProprietaryTech', fnStart)
    const fnBody = moduleSource.slice(fnStart, fnEnd)

    expect(fnBody).toContain('AbortSignal.timeout(60_000)')
    expect(fnBody).not.toContain('AbortSignal.timeout(45_000)')
  })

  test('AC-A1: lookupPositioning function unchanged', () => {
    // Verify lookupPositioning still exists and has its core logic
    expect(moduleSource).toContain('function lookupPositioning(techName: string)')
    expect(moduleSource).toContain('tool.name.toLowerCase() === needle')
    expect(moduleSource).toContain('tool.aliases.some')
  })

  test('AC-A2: enrichProprietaryTech function unchanged', () => {
    // Verify enrichProprietaryTech still exists with its core structure
    expect(moduleSource).toContain('async function enrichProprietaryTech(customerName: string, tech: TechEntry)')
    expect(moduleSource).toContain('tech-stack-enrich')
    expect(moduleSource).toContain('redHatPositioning: parsed.redHatPositioning')
  })

  test('AC-A3: cache invalidation / content hash logic unchanged', () => {
    // Verify content hash creation is intact
    expect(moduleSource).toContain("createHash('sha256')")
    expect(moduleSource).toContain("intel?.company.slice(0, 1000) ?? ''")
    expect(moduleSource).toContain('.digest(\'hex\')')
    expect(moduleSource).toContain('.slice(0, 16)')
  })

  test('grounding metadata extraction: parses groundingChunks from response', () => {
    const fnStart = moduleSource.indexOf('async function extractTechnologies')
    const fnEnd = moduleSource.indexOf('async function enrichProprietaryTech', fnStart)
    const fnBody = moduleSource.slice(fnStart, fnEnd)

    // Must reference groundingMetadata or groundingChunks for source extraction
    expect(fnBody).toContain('groundingMetadata')
  })
})
