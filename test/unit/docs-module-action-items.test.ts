/**
 * GitHub Issue #912 — extractActionItems() unit tests
 * Tests the action item extraction function added to docs-module.ts
 * RED phase: written before implementation
 */

import { describe, it, expect } from 'bun:test'
import { extractActionItems } from '../../src/modules/docs-module.ts'

describe('extractActionItems', () => {
  it('extracts lines containing TODO', () => {
    const text = 'Some intro text\n- TODO: review the proposal by Friday\nMore text'
    const items = extractActionItems(text)
    expect(items.length).toBe(1)
    expect(items[0]).toContain('review the proposal by Friday')
  })

  it('extracts lines containing "action item"', () => {
    const text = 'Notes:\n* Action item: schedule follow-up with engineering team\n* General note'
    const items = extractActionItems(text)
    expect(items.length).toBe(1)
    expect(items[0]).toContain('schedule follow-up with engineering team')
  })

  it('extracts lines containing "task:" pattern', () => {
    const text = 'Meeting output:\n- Task: complete security review\n- Discussion about budget'
    const items = extractActionItems(text)
    expect(items.length).toBe(1)
    expect(items[0]).toContain('complete security review')
  })

  it('extracts lines containing deadline patterns', () => {
    const text = [
      'Items:',
      '- Deadline: submit report by March 15',
      '- Due by end of quarter for compliance review',
      '- Due date: April 1 for final deliverable',
    ].join('\n')
    const items = extractActionItems(text)
    expect(items.length).toBe(3)
  })

  it('extracts lines containing assignment patterns', () => {
    const text = [
      '- Assigned to: Mike for infrastructure review',
      '- Follow up by: Sarah on vendor evaluation',
      '- Complete by next sprint',
      '- Deliver by Friday the deployment package',
    ].join('\n')
    const items = extractActionItems(text)
    expect(items.length).toBe(4)
  })

  it('extracts numbered items with action verbs', () => {
    const text = [
      '1. Review the architecture proposal with the team',
      '2. Schedule a meeting with the vendor',
      '3. Send the updated SOW to procurement',
      '4. This is just a note without an action verb',
    ].join('\n')
    const items = extractActionItems(text)
    expect(items.length).toBe(3)
    expect(items[0]).toContain('Review the architecture proposal')
    expect(items[1]).toContain('Schedule a meeting')
    expect(items[2]).toContain('Send the updated SOW')
  })

  it('strips bullet and number prefixes', () => {
    const text = '- TODO: fix the login bug\n1. Deploy the hotfix to staging'
    const items = extractActionItems(text)
    for (const item of items) {
      expect(item).not.toMatch(/^[\d]+\./)
      expect(item).not.toMatch(/^[-*]/)
    }
  })

  it('returns max 10 items', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `- TODO: task number ${i + 1}`)
    const text = lines.join('\n')
    const items = extractActionItems(text)
    expect(items.length).toBe(10)
  })

  it('returns empty array for text with no action items', () => {
    const text = 'This is a general discussion about the project.\nNo tasks or deadlines mentioned.'
    const items = extractActionItems(text)
    expect(items.length).toBe(0)
  })

  it('does not duplicate items matched by multiple patterns', () => {
    const text = '- TODO: assigned to Mike, complete by Friday'
    const items = extractActionItems(text)
    expect(items.length).toBe(1)
  })

  it('handles empty string input', () => {
    expect(extractActionItems('')).toEqual([])
  })

  it('action verbs include review, schedule, send, complete, prepare, submit, update, create, fix, deploy', () => {
    const verbs = ['review', 'schedule', 'send', 'complete', 'prepare', 'submit', 'update', 'create', 'fix', 'deploy']
    for (const verb of verbs) {
      const text = `1. ${verb.charAt(0).toUpperCase() + verb.slice(1)} the document for the team`
      const items = extractActionItems(text)
      expect(items.length).toBeGreaterThanOrEqual(1)
    }
  })
})
