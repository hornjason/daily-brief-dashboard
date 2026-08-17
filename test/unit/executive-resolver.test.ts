/**
 * Executive Resolver Tests (#670)
 *
 * Tests the executive resolver module that finds real executives
 * by role at a company using Gemini grounding.
 */

import { describe, test, expect } from 'bun:test'
import { resolveExecutivesByRole, cleanExecutiveTitle, type ResolvedExecutive } from '../../src/lib/executive-resolver.ts'

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

describe('#1123 — cleanExecutiveTitle title spacing fix', () => {
  test('fixes "Officerof" → "Officer of"', () => {
    expect(cleanExecutiveTitle('Chief Financial Officerof A10 Networks'))
      .toBe('Chief Financial Officer of A10 Networks')
  })

  test('fixes "Directorat" → "Director at"', () => {
    expect(cleanExecutiveTitle('Directorat Google'))
      .toBe('Director at Google')
  })

  test('fixes "Headof" → "Head of"', () => {
    expect(cleanExecutiveTitle('Headof Information Security'))
      .toBe('Head of Information Security')
  })

  test('fixes "VPof" → "VP of"', () => {
    expect(cleanExecutiveTitle('VPof Engineering'))
      .toBe('VP of Engineering')
  })

  test('fixes "Presidentof" → "President of"', () => {
    expect(cleanExecutiveTitle('Presidentof Sales'))
      .toBe('President of Sales')
  })

  test('fixes "Managerof" → "Manager of"', () => {
    expect(cleanExecutiveTitle('Managerof Operations'))
      .toBe('Manager of Operations')
  })

  test('fixes "Officerat" → "Officer at"', () => {
    expect(cleanExecutiveTitle('Chief Technology Officerat Meta'))
      .toBe('Chief Technology Officer at Meta')
  })

  test('leaves correct spacing unchanged — "Head of Information Security/CIO"', () => {
    expect(cleanExecutiveTitle('Head of Information Security/CIO'))
      .toBe('Head of Information Security/CIO')
  })

  test('leaves correct spacing unchanged — "VP of Engineering"', () => {
    expect(cleanExecutiveTitle('VP of Engineering'))
      .toBe('VP of Engineering')
  })

  test('does not match non-title words — "proof of concept"', () => {
    expect(cleanExecutiveTitle('proof of concept'))
      .toBe('proof of concept')
  })

  test('handles multiple concatenations in one string', () => {
    expect(cleanExecutiveTitle('Directorof Engineering and Headof DevOps'))
      .toBe('Director of Engineering and Head of DevOps')
  })

  test('case insensitive — "directorof"', () => {
    expect(cleanExecutiveTitle('directorof Engineering'))
      .toBe('director of Engineering')
  })

  test('fixes "Analystfor" → "Analyst for"', () => {
    expect(cleanExecutiveTitle('Senior Analystfor Risk Management'))
      .toBe('Senior Analyst for Risk Management')
  })
})
