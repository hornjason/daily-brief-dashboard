/**
 * Executive Resolver Tests (#670)
 *
 * Tests the executive resolver module that finds real executives
 * by role at a company using Gemini grounding.
 */

import { describe, test, expect } from 'bun:test'
import { resolveExecutivesByRole, type ResolvedExecutive } from '../../src/lib/executive-resolver.ts'

describe('#670 — executive resolver', () => {
  test('resolveExecutivesByRole returns empty array for empty roles', async () => {
    const result = await resolveExecutivesByRole([], 'TestCorp')
    expect(result).toEqual([])
  })

  test('ResolvedExecutive type has required fields', () => {
    const exec: ResolvedExecutive = {
      role: 'VP Infrastructure',
      name: 'John Doe',
      title: 'Vice President, Infrastructure',
      resolvedAt: new Date().toISOString(),
    }
    expect(exec.role).toBe('VP Infrastructure')
    expect(exec.name).toBe('John Doe')
    expect(exec.title).toBe('Vice President, Infrastructure')
    expect(exec.linkedinUrl).toBeUndefined()
  })

  test('ResolvedExecutive type supports optional linkedinUrl', () => {
    const exec: ResolvedExecutive = {
      role: 'CIO',
      name: 'Jane Smith',
      title: 'Chief Information Officer',
      linkedinUrl: 'https://linkedin.com/in/janesmith',
      resolvedAt: new Date().toISOString(),
    }
    expect(exec.linkedinUrl).toBe('https://linkedin.com/in/janesmith')
  })
})
