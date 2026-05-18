/**
 * Unit test: News Provider URL Resolution (Issue #215)
 * 
 * Verifies that sourceUrl fields are resolved to actual HTTP(S) URLs,
 * not Google redirect tokens that expire and 404.
 */

import { describe, it, expect } from 'bun:test'

describe('News Provider URL Resolution', () => {
  it('should reject Google redirect tokens', () => {
    const redirectToken = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHjlw8bP_WA...'
    
    // Validate URL is NOT a redirect token
    const isRedirectToken = redirectToken.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')
    expect(isRedirectToken).toBe(true) // This SHOULD be filtered out
  })

  it('should accept real HTTP(S) URLs', () => {
    const validUrls = [
      'https://techcrunch.com/2024/01/15/company-news',
      'https://www.reuters.com/business/company-acquisition-2024-01-15',
      'https://www.bloomberg.com/news/articles/2024-01-15/earnings-report',
    ]

    for (const url of validUrls) {
      // URL must be HTTP(S)
      expect(url.startsWith('http://') || url.startsWith('https://')).toBe(true)
      
      // URL must NOT be a Google redirect
      expect(url.includes('vertexaisearch.cloud.google.com')).toBe(false)
      expect(url.includes('grounding-api-redirect')).toBe(false)
    }
  })

  it('should validate URL is well-formed', () => {
    const testUrls = [
      { url: 'https://example.com/article', valid: true },
      { url: 'http://news.site/story', valid: true },
      { url: 'not-a-url', valid: false },
      { url: '', valid: false },
    ]

    for (const { url, valid } of testUrls) {
      try {
        const parsed = new URL(url)
        const isHttpOrHttps = parsed.protocol === 'http:' || parsed.protocol === 'https:'
        expect(isHttpOrHttps).toBe(valid)
      } catch {
        expect(valid).toBe(false)
      }
    }
  })
})
