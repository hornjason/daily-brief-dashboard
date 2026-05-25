/**
 * Unit tests for SalesHub content extraction pipeline (#369).
 * Tests parsing logic only — no HTTP fetching, no mocks.
 */

import { describe, it, expect } from 'bun:test'
import {
  classifyUrl,
  extractTextFromHtml,
  parseMetrics,
  isValidMetric,
  type ExtractedMetric,
} from '../../scripts/saleshub-content-extraction.ts'

describe('classifyUrl', () => {
  it('marks www.redhat.com as fetchable', () => {
    expect(classifyUrl('https://www.redhat.com/en/resources/some-paper')).toBe('fetch')
  })

  it('marks interact.redhat.com as fetchable', () => {
    expect(classifyUrl('https://interact.redhat.com/en/something')).toBe('fetch')
  })

  it('marks content.redhat.com as fetchable', () => {
    expect(classifyUrl('https://content.redhat.com/content/rhcc/us/en/assets/display.html?id=abc')).toBe('fetch')
  })

  it('marks access.redhat.com as fetchable', () => {
    expect(classifyUrl('https://access.redhat.com/articles/7119667')).toBe('fetch')
  })

  it('marks source.redhat.com as auth-required', () => {
    expect(classifyUrl('https://source.redhat.com/some/page')).toBe('auth-required')
  })

  it('marks Google Slides as slides-api', () => {
    expect(classifyUrl('https://docs.google.com/presentation/d/abc123/edit')).toBe('slides-api')
  })

  it('marks youtu.be as video', () => {
    expect(classifyUrl('https://youtu.be/abc123')).toBe('video')
  })

  it('marks videos.learning.redhat.com as video', () => {
    expect(classifyUrl('https://videos.learning.redhat.com/media/test')).toBe('video')
  })

  it('marks catalog.demo.redhat.com as interactive', () => {
    expect(classifyUrl('https://catalog.demo.redhat.com/catalog/babylon-catalog-prod')).toBe('interactive')
  })

  it('marks demo.redhat.com as interactive', () => {
    expect(classifyUrl('https://demo.redhat.com/some/demo')).toBe('interactive')
  })

  it('marks Seismic relative paths as skip', () => {
    expect(classifyUrl('/apps/doccenter/1d1918e9-b5b0-4428-b8fc-87e02ad44156/doc/something')).toBe('skip')
  })

  it('marks empty URL as skip', () => {
    expect(classifyUrl('')).toBe('skip')
  })

  it('marks red.ht short URLs as fetch', () => {
    expect(classifyUrl('http://red.ht/virttcoestimator')).toBe('fetch')
  })
})

describe('extractTextFromHtml', () => {
  it('strips HTML tags and returns clean text', () => {
    const html = '<html><body><main><h1>Title</h1><p>Some content here.</p></main></body></html>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Title')
    expect(text).toContain('Some content here')
    expect(text).not.toContain('<h1>')
    expect(text).not.toContain('<p>')
  })

  it('extracts content within main/article tags preferentially', () => {
    const html = `
      <html><body>
        <nav>Navigation stuff</nav>
        <main>
          <h1>Real Content</h1>
          <p>This is the actual article content with good data.</p>
        </main>
        <footer>Footer stuff</footer>
      </body></html>
    `
    const text = extractTextFromHtml(html)
    expect(text).toContain('Real Content')
    expect(text).toContain('actual article content')
    expect(text).not.toContain('Navigation stuff')
    expect(text).not.toContain('Footer stuff')
  })

  it('falls back to body content when no main/article tag', () => {
    const html = '<html><body><div><p>Body content without main tag.</p></div></body></html>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Body content without main tag')
  })

  it('limits output to 2000 characters', () => {
    const longContent = 'A'.repeat(5000)
    const html = `<main><p>${longContent}</p></main>`
    const text = extractTextFromHtml(html)
    expect(text.length).toBeLessThanOrEqual(2000)
  })

  it('cleans up excessive whitespace', () => {
    const html = '<main><p>Hello    world</p>   <p>Next   paragraph</p></main>'
    const text = extractTextFromHtml(html)
    expect(text).not.toMatch(/\s{3,}/)
  })

  it('handles empty HTML', () => {
    expect(extractTextFromHtml('')).toBe('')
  })
})

describe('parseMetrics', () => {
  it('extracts percentage improvement metrics', () => {
    const text = 'Customers achieved 40% reduction in deployment time using Red Hat OpenShift.'
    const metrics = parseMetrics(text, 'https://example.com')
    expect(metrics.length).toBeGreaterThanOrEqual(1)
    expect(metrics[0].value).toContain('40%')
    expect(metrics[0].source).toBe('https://example.com')
  })

  it('extracts "X times faster" metrics', () => {
    const text = 'Teams deploy 3 times faster with automated pipelines.'
    const metrics = parseMetrics(text, 'https://example.com')
    expect(metrics.length).toBeGreaterThanOrEqual(1)
    const found = metrics.find(m => m.value.includes('3 times faster'))
    expect(found).toBeDefined()
  })

  it('extracts dollar savings', () => {
    const text = 'The company saved $2M annually by consolidating infrastructure.'
    const metrics = parseMetrics(text, 'https://example.com')
    expect(metrics.length).toBeGreaterThanOrEqual(1)
    const found = metrics.find(m => m.value.includes('$2M'))
    expect(found).toBeDefined()
  })

  it('extracts "reduced from X to Y" patterns', () => {
    const text = 'Deployment time was reduced from 2 weeks to 2 hours.'
    const metrics = parseMetrics(text, 'https://example.com')
    expect(metrics.length).toBeGreaterThanOrEqual(1)
    const found = metrics.find(m => m.value.includes('reduced from'))
    expect(found).toBeDefined()
  })

  it('extracts time-unit metrics', () => {
    const text = 'Provisioning dropped from 30 days to 4 hours with automation.'
    const metrics = parseMetrics(text, 'https://example.com')
    expect(metrics.length).toBeGreaterThanOrEqual(1)
  })

  it('returns empty array for text without metrics', () => {
    const text = 'Red Hat provides enterprise solutions for modern infrastructure.'
    const metrics = parseMetrics(text, 'https://example.com')
    expect(metrics).toEqual([])
  })

  it('does not double-count overlapping patterns', () => {
    const text = 'Achieved 50% improvement in deployment speed.'
    const metrics = parseMetrics(text, 'https://example.com')
    // Should have exactly 1 metric, not duplicates from overlapping patterns
    const values = metrics.map(m => m.value)
    const unique = [...new Set(values)]
    expect(unique.length).toBe(metrics.length)
  })
})

describe('isValidMetric', () => {
  it('accepts metric with number and sufficient context', () => {
    expect(isValidMetric({ value: '40% reduction', context: 'in deployment time' })).toBe(true)
  })

  it('rejects metric without a number', () => {
    expect(isValidMetric({ value: 'significant improvement', context: 'in speed' })).toBe(false)
  })

  it('rejects metric with short context', () => {
    expect(isValidMetric({ value: '40%', context: 'fast' })).toBe(false)
  })

  it('rejects metric with empty context', () => {
    expect(isValidMetric({ value: '40%', context: '' })).toBe(false)
  })
})
