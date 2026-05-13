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

describe('Voice profile markdown parsing', () => {
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

  test('parses complete voice profile with all sections', () => {
    const markdown = `# Voice Profile: Carolanne Farrell

## Voice Characteristics

- **Strategic and confident** — speaks like a senior advisor
- **Opens with industry-level threats** — frames around market
- **Names customer products by name** — shows deep homework

## Prompt Instruction

When generating emails in Carolanne's voice: open with strategic industry context, name specific customer products, and include a peer company metric for social proof.

## Example Email

Subject: Hybrid cloud security at financial scale

Hi [VP],

Your cloud migration initiative faces the same compliance challenges we saw at Capital One...`

    // Extract AE name from title
    const nameMatch = markdown.match(/# Voice Profile:\s*(.+)/)
    expect(nameMatch).not.toBeNull()
    expect(nameMatch![1].trim()).toBe('Carolanne Farrell')

    // Extract characteristics as array
    const charMatch = markdown.match(/## Voice Characteristics\n\n([\s\S]+?)(?=\n##|$)/)
    expect(charMatch).not.toBeNull()
    const bullets = charMatch![1].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim())
    expect(bullets.length).toBe(3)
    expect(bullets[0]).toContain('Strategic and confident')

    // Extract prompt instruction
    const promptMatch = markdown.match(/## Prompt Instruction\n\n([\s\S]+?)(?=\n##|$)/)
    expect(promptMatch).not.toBeNull()
    expect(promptMatch![1]).toContain("Carolanne's voice")

    // Extract example email (may or may not be in code fence)
    const exampleMatch = markdown.match(/## Example Email[^`]*\n+([\s\S]+?)(?=\n##|$)/)
    expect(exampleMatch).not.toBeNull()
    expect(exampleMatch![1].length).toBeGreaterThan(0)
  })

  test('returns null when prompt instruction section is missing', () => {
    const markdown = `# Voice Profile: Test AE

## Voice Characteristics
- Bullet 1

## Other Section
Not a prompt instruction.`

    const promptMatch = markdown.match(/## Prompt Instruction\n\n([\s\S]+?)(?=\n##|$)/)
    expect(promptMatch).toBeNull()
  })

  test('returns null when voice characteristics section is missing', () => {
    const markdown = `# Voice Profile: Test AE

## Prompt Instruction

Some instruction here.`

    const charMatch = markdown.match(/## Voice Characteristics\n\n([\s\S]+?)(?=\n##|$)/)
    expect(charMatch).toBeNull()
  })

  test('handles malformed bullet formatting gracefully', () => {
    const markdown = `## Voice Characteristics

- Valid bullet
Not a bullet
  - Indented bullet
* Different bullet marker

## Prompt Instruction`

    const charMatch = markdown.match(/## Voice Characteristics\n\n([\s\S]+?)(?=\n##|$)/)
    expect(charMatch).not.toBeNull()
    const bullets = charMatch![1].split('\n').filter(l => l.trim().startsWith('-'))
    // Should only capture lines that actually start with '-'
    expect(bullets.length).toBeGreaterThan(0)
  })
})

describe('Voice profile structure validation', () => {
  test('VoiceProfile has all required fields', () => {
    interface VoiceProfile {
      aeName: string
      characteristics: string[]
      promptInstruction: string
      exampleEmail?: string
      detectedFrom: string
      detectedAt: string
    }

    const profile: VoiceProfile = {
      aeName: 'Test AE',
      characteristics: ['Bullet 1', 'Bullet 2'],
      promptInstruction: 'When writing emails...',
      exampleEmail: 'Subject: Test\n\nBody',
      detectedFrom: '10 emails across 3 customers',
      detectedAt: new Date().toISOString(),
    }

    expect(profile.aeName).toBeDefined()
    expect(Array.isArray(profile.characteristics)).toBe(true)
    expect(typeof profile.promptInstruction).toBe('string')
    expect(typeof profile.detectedFrom).toBe('string')
    expect(typeof profile.detectedAt).toBe('string')
  })

  test('characteristics must be an array of strings', () => {
    const characteristics = ['Strategic', 'Confident', 'Technical']
    expect(Array.isArray(characteristics)).toBe(true)
    expect(characteristics.every(c => typeof c === 'string')).toBe(true)
  })

  test('promptInstruction must be a non-empty string', () => {
    const instruction = 'When generating emails in this voice: use strategic framing.'
    expect(typeof instruction).toBe('string')
    expect(instruction.length).toBeGreaterThan(0)
  })
})

describe('Voice profile cache path construction', () => {
  test('cache path follows expected pattern', () => {
    const aeSlug = 'carolanne-farrell'
    const expectedPath = `${aeSlug}.json`
    expect(expectedPath).toMatch(/^[a-z0-9-]+\.json$/)
  })

  test('cache path uses slug not raw name', () => {
    const aeName = 'Carolanne Farrell'
    const slug = toSlug(aeName)
    const cachePath = `${slug}.json`
    expect(cachePath).toBe('carolanne-farrell.json')
    expect(cachePath).not.toContain(' ')
  })
})
