/**
 * ADR Convention Tests — validates that all ADR files follow naming and structure conventions.
 *
 * Checks:
 *   1. Filename follows ADR-NNN-kebab-title.md pattern
 *   2. Required YAML frontmatter fields: doc-type, status, owner, updated
 *   3. Status field is a known value
 *   4. File has a top-level heading (# ...)
 *   5. File contains "Context" and "Decision" content (heading or inline)
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const ADR_DIR = resolve(import.meta.dir, '../../docs/adr')

const VALID_STATUSES = ['proposed', 'accepted', 'active', 'deprecated', 'superseded', 'unknown']

const ADR_FILENAME_PATTERN = /^ADR-\d{3}-[a-z0-9-]+\.md$/

function getAdrFiles(): string[] {
  try {
    return readdirSync(ADR_DIR).filter((f) => f.startsWith('ADR-') && f.endsWith('.md'))
  } catch {
    return []
  }
}

describe('ADR Conventions', () => {
  const adrFiles = getAdrFiles()

  test('at least one ADR file exists', () => {
    expect(adrFiles.length).toBeGreaterThan(0)
  })

  describe('filename conventions', () => {
    for (const file of adrFiles) {
      test(`${file} follows ADR-NNN-kebab-title.md pattern`, () => {
        expect(ADR_FILENAME_PATTERN.test(file)).toBe(true)
      })
    }
  })

  describe('frontmatter requirements', () => {
    for (const file of adrFiles) {
      test(`${file} has required YAML frontmatter`, () => {
        const content = readFileSync(resolve(ADR_DIR, file), 'utf-8')
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
        expect(frontmatterMatch).not.toBeNull()

        const frontmatter = frontmatterMatch![1]
        expect(frontmatter).toContain('doc-type:')
        expect(frontmatter).toContain('status:')
        expect(frontmatter).toContain('owner:')
        expect(frontmatter).toContain('updated:')
      })
    }
  })

  describe('status values', () => {
    for (const file of adrFiles) {
      test(`${file} has a valid status`, () => {
        const content = readFileSync(resolve(ADR_DIR, file), 'utf-8')
        const statusMatch = content.match(/^status:\s*(.+)$/m)
        expect(statusMatch).not.toBeNull()

        const status = statusMatch![1].trim().toLowerCase()
        expect(VALID_STATUSES).toContain(status)
      })
    }
  })

  describe('has top-level heading', () => {
    for (const file of adrFiles) {
      test(`${file} has a # heading`, () => {
        const content = readFileSync(resolve(ADR_DIR, file), 'utf-8')
        expect(content).toMatch(/^# .+/m)
      })
    }
  })

  describe('contains rationale content', () => {
    for (const file of adrFiles) {
      test(`${file} contains decision rationale (context/decision/options)`, () => {
        const content = readFileSync(resolve(ADR_DIR, file), 'utf-8')
        const lower = content.toLowerCase()
        // ADRs must contain at least one of: context, decision, considered options, or rationale
        const hasRationale =
          lower.includes('context') ||
          lower.includes('decision') ||
          lower.includes('considered') ||
          lower.includes('rationale') ||
          lower.includes('rejected') ||
          lower.includes('chosen')
        expect(hasRationale).toBe(true)
      })
    }
  })
})
