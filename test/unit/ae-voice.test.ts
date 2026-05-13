import { describe, test, expect } from 'bun:test'
import { toSlug } from '../../src/cache-layer.ts'

describe('AE voice profile slug generation', () => {
  test('generates consistent slugs for AE names', () => {
    expect(toSlug('Carolanne Farrell')).toBe('carolanne-farrell')
    expect(toSlug('Elmer Alvarez')).toBe('elmer-alvarez')
    expect(toSlug('John Q. Smith')).toBe('john-q-smith')
  })

  test('handles special characters and spaces', () => {
    expect(toSlug("O'Brien")).toBe('obrien')
    expect(toSlug('María García')).toBe('mara-garca')
    expect(toSlug('Test  Multiple   Spaces')).toBe('test-multiple-spaces')
  })
})

describe('Voice profile markdown parsing (hypothetical)', () => {
  test('extracts prompt instruction section', () => {
    const markdown = `# Voice Profile: Test AE

## Voice Characteristics
- Bullet 1
- Bullet 2

## Prompt Instruction

When generating emails in Test's voice:
- Do this
- Do that

## Example`

    const promptMatch = markdown.match(/## Prompt Instruction\n\n([\s\S]+?)(?=\n##|$)/)
    expect(promptMatch).not.toBeNull()
    expect(promptMatch![1]).toContain('When generating emails')
  })

  test('extracts voice characteristics bullets', () => {
    const markdown = `## Voice Characteristics

- **Strategic and confident** — speaks like a senior advisor
- **Opens with industry-level threats** — frames around market
- **Names customer products by name** — shows deep homework

## Prompt Instruction`

    const charMatch = markdown.match(/## Voice Characteristics\n\n([\s\S]+?)(?=\n##|$)/)
    expect(charMatch).not.toBeNull()
    const bullets = charMatch![1].split('\n').filter(l => l.trim().startsWith('-'))
    expect(bullets.length).toBe(3)
    expect(bullets[0]).toContain('Strategic and confident')
  })
})
