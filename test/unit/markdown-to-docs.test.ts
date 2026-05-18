import { describe, it, expect } from 'bun:test'
import { markdownToDocsRequests } from '../../src/lib/markdown-to-docs'

describe('markdownToDocsRequests', () => {
  // ── Heading detection ──────────────────────────────────────────────────

  it('converts H1 heading to HEADING_1 paragraph style', () => {
    const { requests, plainText } = markdownToDocsRequests('# My Title')
    expect(plainText).toBe('My Title\n')
    // First request is insertText
    expect(requests[0]).toEqual({
      insertText: { location: { index: 1 }, text: 'My Title\n' },
    })
    // Second request styles it as HEADING_1
    const headingReq = requests.find(
      (r: any) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    expect(headingReq).toBeTruthy()
    expect(headingReq!.updateParagraphStyle.range.startIndex).toBe(1)
    // "My Title\n" is 9 chars. startIndex=1, endIndex=1+9=10 (Docs API Range endIndex is exclusive)
    expect(headingReq!.updateParagraphStyle.range.endIndex).toBe(10)
  })

  it('converts H2 heading to HEADING_2 paragraph style', () => {
    const { requests, plainText } = markdownToDocsRequests('## Section')
    expect(plainText).toBe('Section\n')
    const headingReq = requests.find(
      (r: any) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_2',
    )
    expect(headingReq).toBeTruthy()
  })

  it('converts H3 heading to HEADING_3 paragraph style', () => {
    const { requests, plainText } = markdownToDocsRequests('### Sub-section')
    expect(plainText).toBe('Sub-section\n')
    const headingReq = requests.find(
      (r: any) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_3',
    )
    expect(headingReq).toBeTruthy()
  })

  // ── Bold text ──────────────────────────────────────────────────────────

  it('detects bold text and returns correct character range', () => {
    const { requests, plainText } = markdownToDocsRequests('Hello **world** today')
    expect(plainText).toBe('Hello world today\n')
    const boldReq = requests.find((r: any) => r.updateTextStyle?.textStyle?.bold === true)
    expect(boldReq).toBeTruthy()
    // "Hello " = 6 chars, "world" starts at index 1+6=7, ends at 1+11=12
    expect(boldReq!.updateTextStyle.range.startIndex).toBe(7)
    expect(boldReq!.updateTextStyle.range.endIndex).toBe(12)
  })

  // ── Italic text ────────────────────────────────────────────────────────

  it('detects italic text and returns correct character range', () => {
    const { requests, plainText } = markdownToDocsRequests('Hello *world* today')
    expect(plainText).toBe('Hello world today\n')
    const italicReq = requests.find((r: any) => r.updateTextStyle?.textStyle?.italic === true)
    expect(italicReq).toBeTruthy()
    expect(italicReq!.updateTextStyle.range.startIndex).toBe(7)
    expect(italicReq!.updateTextStyle.range.endIndex).toBe(12)
  })

  // ── Bullet lists ───────────────────────────────────────────────────────

  it('detects unordered bullet list items', () => {
    const md = '- Item one\n- Item two\n- Item three'
    const { requests, plainText } = markdownToDocsRequests(md)
    expect(plainText).toBe('Item one\nItem two\nItem three\n')
    const bulletReq = requests.find((r: any) => r.createParagraphBullets)
    expect(bulletReq).toBeTruthy()
    expect(bulletReq!.createParagraphBullets.bulletPreset).toBe('BULLET_DISC_CIRCLE_SQUARE')
  })

  it('detects ordered (numbered) list items', () => {
    const md = '1. First\n2. Second\n3. Third'
    const { requests, plainText } = markdownToDocsRequests(md)
    expect(plainText).toBe('First\nSecond\nThird\n')
    const bulletReq = requests.find((r: any) => r.createParagraphBullets)
    expect(bulletReq).toBeTruthy()
    expect(bulletReq!.createParagraphBullets.bulletPreset).toBe('NUMBERED_DECIMAL_NESTED')
  })

  // ── Horizontal rules ──────────────────────────────────────────────────

  it('converts horizontal rules to extra newline', () => {
    const md = 'Before\n---\nAfter'
    const { plainText } = markdownToDocsRequests(md)
    expect(plainText).toBe('Before\n\nAfter\n')
  })

  // ── Tables ─────────────────────────────────────────────────────────────

  it('converts markdown tables to TableDef array with headers and rows', () => {
    const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |'
    const { requests, plainText, tables } = markdownToDocsRequests(md)
    // Table should be extracted to tables array, not plainText
    expect(tables.length).toBe(1)
    expect(tables[0].headers).toEqual(['Name', 'Age'])
    expect(tables[0].rows).toEqual([['Alice', '30'], ['Bob', '25']])
    // plainText should have a placeholder newline
    expect(plainText).toBe('\n')
    // No bold styling in initial requests (tables handled separately)
    const boldReqs = requests.filter((r: any) => r.updateTextStyle?.textStyle?.bold === true)
    expect(boldReqs.length).toBe(0)
  })

  // ── Mixed content ─────────────────────────────────────────────────────

  it('handles mixed content: heading + bold + bullets', () => {
    const md = '## Summary\n\nThis is **important** info.\n\n- Point A\n- Point B'
    const { requests, plainText } = markdownToDocsRequests(md)

    // Plain text should have no markdown syntax
    expect(plainText).not.toContain('##')
    expect(plainText).not.toContain('**')
    expect(plainText).not.toContain('- ')

    // Should have heading
    const headingReq = requests.find(
      (r: any) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_2',
    )
    expect(headingReq).toBeTruthy()

    // Should have bold
    const boldReq = requests.find((r: any) => r.updateTextStyle?.textStyle?.bold === true)
    expect(boldReq).toBeTruthy()

    // Should have bullets
    const bulletReq = requests.find((r: any) => r.createParagraphBullets)
    expect(bulletReq).toBeTruthy()
  })

  // ── Plain text output ─────────────────────────────────────────────────

  it('strips all markdown syntax from plain text output', () => {
    const md = '# Title\n\n**Bold** and *italic* text.\n\n- Bullet\n1. Numbered\n\n---\n\nEnd.'
    const { plainText } = markdownToDocsRequests(md)
    expect(plainText).not.toContain('#')
    expect(plainText).not.toContain('**')
    expect(plainText).not.toContain('- ')
    // Should not start with number-dot for ordered lists
    expect(plainText).not.toMatch(/^\d+\. /m)
  })

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles empty string input', () => {
    const { requests, plainText } = markdownToDocsRequests('')
    expect(plainText).toBe('\n')
    expect(requests.length).toBe(1) // just the insertText
  })

  it('handles text with no markdown formatting', () => {
    const { requests, plainText } = markdownToDocsRequests('Plain paragraph text.')
    expect(plainText).toBe('Plain paragraph text.\n')
    expect(requests.length).toBe(1) // just insertText, no formatting
  })

  it('first request is always insertText', () => {
    const md = '# Title\n\n**Bold** text\n\n- Bullet'
    const { requests } = markdownToDocsRequests(md)
    expect(requests[0].insertText).toBeTruthy()
    expect(requests[0].insertText.location.index).toBe(1)
  })

  // ── Index accuracy ────────────────────────────────────────────────────

  it('calculates correct indices for bold in second paragraph', () => {
    const md = 'First line.\n\nSecond **bold** line.'
    const { requests, plainText } = markdownToDocsRequests(md)
    expect(plainText).toBe('First line.\n\nSecond bold line.\n')
    const boldReq = requests.find((r: any) => r.updateTextStyle?.textStyle?.bold === true)
    expect(boldReq).toBeTruthy()
    // "First line.\n\nSecond " = 20 chars, so bold starts at 1+20=21
    const expectedStart = 1 + 'First line.\n\nSecond '.length
    expect(boldReq!.updateTextStyle.range.startIndex).toBe(expectedStart)
    expect(boldReq!.updateTextStyle.range.endIndex).toBe(expectedStart + 4) // "bold"
  })

  it('handles * bullet markers same as - markers', () => {
    const md = '* Item A\n* Item B'
    const { requests, plainText } = markdownToDocsRequests(md)
    expect(plainText).toBe('Item A\nItem B\n')
    const bulletReq = requests.find((r: any) => r.createParagraphBullets)
    expect(bulletReq).toBeTruthy()
    expect(bulletReq!.createParagraphBullets.bulletPreset).toBe('BULLET_DISC_CIRCLE_SQUARE')
  })
})
