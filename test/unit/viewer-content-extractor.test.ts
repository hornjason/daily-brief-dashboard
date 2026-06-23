/**
 * Unit tests for SalesHub viewer content extractor (#859)
 *
 * Tests the pure logic functions used by the viewer content extraction phase:
 * - sanitizeViewerHtml: strips scripts, session tokens, nav chrome
 * - isEnrichableContent: validates content length and skip conditions
 *
 * No browser required — pure function tests.
 */

import { describe, it, expect } from 'bun:test'
import {
  sanitizeViewerHtml,
  isEnrichableContent,
  detectNavigationPage,
  extractSubPageLinks,
} from '../../scripts/scrape-saleshub-product-page.ts'

// ── sanitizeViewerHtml ─────────────────────────────────────────────────────

describe('sanitizeViewerHtml', () => {
  it('removes all <script> tags and their content', () => {
    const html = '<div>Hello</div><script>alert("xss")</script><p>World</p>'
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('<script')
    expect(result).not.toContain('</script>')
    expect(result).not.toContain('alert')
    expect(result).toContain('Hello')
    expect(result).toContain('World')
  })

  it('removes <script> tags with attributes', () => {
    const html = '<div>Content</div><script type="text/javascript" src="app.js"></script><script defer>var x=1;</script>'
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('<script')
    expect(result).not.toContain('app.js')
    expect(result).toContain('Content')
  })

  it('removes <meta> tags containing session/token strings', () => {
    const html = '<head><meta name="csrf-token" content="abc123"><meta name="authToken" content="xyz"></head><body><p>Content</p></body>'
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('csrf-token')
    expect(result).not.toContain('authToken')
    expect(result).not.toContain('abc123')
    expect(result).toContain('Content')
  })

  it('preserves non-session <meta> tags', () => {
    const html = '<meta name="description" content="Product overview"><p>Content</p>'
    const result = sanitizeViewerHtml(html)
    expect(result).toContain('description')
    expect(result).toContain('Product overview')
  })

  it('removes Seismic navigation chrome (header, footer, sidebar)', () => {
    const html = [
      '<nav class="seismic-header">Nav bar</nav>',
      '<div class="seismic-navigation">Side nav</div>',
      '<div class="seismic-footer">Footer</div>',
      '<div class="articleSdk-theme-page-doubleColumn-sidebar">Sidebar content</div>',
      '<div class="document-content">Real content here</div>',
    ].join('\n')
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('Nav bar')
    expect(result).not.toContain('Side nav')
    expect(result).not.toContain('Footer')
    expect(result).not.toContain('Sidebar content')
    expect(result).toContain('Real content here')
  })

  it('preserves <a href> hyperlinks in document content', () => {
    const html = '<div><p>See <a href="https://redhat.com/product">Red Hat Product</a> for details.</p></div>'
    const result = sanitizeViewerHtml(html)
    expect(result).toContain('<a href="https://redhat.com/product">')
    expect(result).toContain('Red Hat Product')
  })

  it('handles empty input gracefully', () => {
    expect(sanitizeViewerHtml('')).toBe('')
  })

  it('removes noscript tags', () => {
    const html = '<div>Content</div><noscript>Please enable JS</noscript>'
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('noscript')
    expect(result).not.toContain('enable JS')
    expect(result).toContain('Content')
  })

  it('removes style tags', () => {
    const html = '<style>.foo { color: red; }</style><div>Content</div>'
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('<style')
    expect(result).not.toContain('color: red')
    expect(result).toContain('Content')
  })

  it('removes Seismic toolbar elements', () => {
    const html = [
      '<div class="seismic-toolbar">Toolbar</div>',
      '<div class="seismic-page-toolbar-view">More toolbar</div>',
      '<div>Document body</div>',
    ].join('\n')
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('Toolbar')
    expect(result).not.toContain('More toolbar')
    expect(result).toContain('Document body')
  })

  // ── Gate 0: inline event handlers + sensitive data-attributes (#874) ───

  it('strips inline event handlers (onclick, onload, onerror)', () => {
    const html = '<div onclick="alert(1)" onload="init()" onerror="handleErr()">content</div>'
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('onload')
    expect(result).not.toContain('onerror')
    expect(result).not.toContain('alert(1)')
    expect(result).toContain('content')
  })

  it('strips inline handlers with single quotes', () => {
    const html = "<button onclick='doStuff()'>Click</button>"
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('doStuff')
    expect(result).toContain('Click')
  })

  it('strips sensitive data-attributes (session, user, token, auth, csrf, tracking)', () => {
    const html = '<div data-session-id="abc" data-user-name="jdoe" data-token="xyz" data-auth-state="valid" data-csrf-token="t1" data-tracking-id="tr1">content</div>'
    const result = sanitizeViewerHtml(html)
    expect(result).not.toContain('data-session-id')
    expect(result).not.toContain('data-user-name')
    expect(result).not.toContain('data-token')
    expect(result).not.toContain('data-auth-state')
    expect(result).not.toContain('data-csrf-token')
    expect(result).not.toContain('data-tracking-id')
    expect(result).toContain('content')
  })

  it('preserves non-sensitive data-attributes', () => {
    const html = '<div data-testid="my-div" data-content-type="pdf">content</div>'
    const result = sanitizeViewerHtml(html)
    expect(result).toContain('data-testid')
    expect(result).toContain('data-content-type')
  })

  it('combined: onclick + data-session-id stripped, content preserved', () => {
    const html = '<div onclick="alert(1)" data-session-id="abc">content</div>'
    const result = sanitizeViewerHtml(html)
    expect(result).toBe('<div>content</div>')
  })
})

// ── isEnrichableContent ────────────────────────────────────────────────────

describe('isEnrichableContent', () => {
  it('returns true for substantive content (>500 chars)', () => {
    const text = 'A'.repeat(501)
    expect(isEnrichableContent(text)).toBe(true)
  })

  it('returns false for short content (<=500 chars)', () => {
    const text = 'A'.repeat(500)
    expect(isEnrichableContent(text)).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isEnrichableContent('')).toBe(false)
  })

  it('returns false for "Content not found" pages', () => {
    const text = 'Content not found. The page you are looking for does not exist.'
    expect(isEnrichableContent(text)).toBe(false)
  })

  it('returns false for "Page not found" variants', () => {
    expect(isEnrichableContent('Page not found - Error 404')).toBe(false)
    expect(isEnrichableContent('404 - This page could not be found')).toBe(false)
  })

  it('returns false for iframe-only pages', () => {
    // iframe-only pages have very little text — just the iframe tag
    const text = 'Loading...'
    expect(isEnrichableContent(text)).toBe(false)
  })

  it('returns false for YouTube embed pages', () => {
    const text = 'Watch this video on YouTube. Subscribe to our channel for more content.'
    expect(isEnrichableContent(text)).toBe(false)
  })

  it('returns true for real document content', () => {
    const text = [
      'Red Hat Ansible Automation Platform is a comprehensive solution for IT automation.',
      'It enables teams to create, share, and manage automation across their entire organization.',
      'With Ansible, you can automate cloud provisioning, configuration management, application deployment,',
      'intra-service orchestration, and many other IT needs. The platform includes automation controller,',
      'automation hub, and event-driven automation capabilities. This document covers the key features,',
      'architecture, deployment options, and best practices for enterprise adoption. Organizations using',
      'Ansible report significant improvements in deployment speed, consistency, and compliance. The',
      'platform supports hybrid cloud environments including AWS, Azure, Google Cloud, and on-premises',
      'infrastructure. It integrates with existing CI/CD pipelines and security frameworks.',
    ].join(' ')
    expect(isEnrichableContent(text)).toBe(true)
  })
})

// ── detectNavigationPage (#874 follow-through) ──────────────────────────

describe('detectNavigationPage', () => {
  it('returns true for a page with 3+ internal links and short text', () => {
    const innerText = 'ServiceNow Integration\nBrowse resources'
    const html = [
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A</a>',
      '<a href="https://saleshub.redhat.com/doc/def">Doc B</a>',
      '<a href="https://saleshub.redhat.com/doc/ghi">Doc C</a>',
    ].join('\n')
    const result = detectNavigationPage(innerText, html)
    expect(result.isNavPage).toBe(true)
    expect(result.links.length).toBe(3)
  })

  it('returns false for a document page with substantial content', () => {
    const innerText = 'A'.repeat(2500)
    const html = '<div>' + innerText + '</div><a href="https://saleshub.redhat.com/other">Link</a>'
    const result = detectNavigationPage(innerText, html)
    expect(result.isNavPage).toBe(false)
  })

  it('returns false when fewer than 3 internal links', () => {
    const innerText = 'Short page'
    const html = [
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A</a>',
      '<a href="https://saleshub.redhat.com/doc/def">Doc B</a>',
    ].join('\n')
    const result = detectNavigationPage(innerText, html)
    expect(result.isNavPage).toBe(false)
  })

  it('ignores external links — only counts saleshub/seismic domains', () => {
    const innerText = 'Links page'
    const html = [
      '<a href="https://google.com/search">Google</a>',
      '<a href="https://microsoft.com/docs">MS Docs</a>',
      '<a href="https://github.com/repo">GitHub</a>',
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A</a>',
    ].join('\n')
    const result = detectNavigationPage(innerText, html)
    expect(result.isNavPage).toBe(false)
    expect(result.links.length).toBe(1)
  })

  it('counts seismic.com links as internal', () => {
    const innerText = 'Resources page'
    const html = [
      '<a href="https://redhat.seismic.com/content/abc">Doc A</a>',
      '<a href="https://redhat.seismic.com/content/def">Doc B</a>',
      '<a href="https://redhat.seismic.com/content/ghi">Doc C</a>',
    ].join('\n')
    const result = detectNavigationPage(innerText, html)
    expect(result.isNavPage).toBe(true)
    expect(result.links.length).toBe(3)
  })

  it('deduplicates links by href', () => {
    const innerText = 'Repeated links'
    const html = [
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A</a>',
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A copy</a>',
      '<a href="https://saleshub.redhat.com/doc/def">Doc B</a>',
      '<a href="https://saleshub.redhat.com/doc/ghi">Doc C</a>',
    ].join('\n')
    const result = detectNavigationPage(innerText, html)
    expect(result.isNavPage).toBe(true)
    expect(result.links.length).toBe(3)
  })

  it('caps links at MAX_SUB_PAGES (10)', () => {
    const innerText = 'Many links page'
    const links = Array.from({ length: 15 }, (_, i) =>
      `<a href="https://saleshub.redhat.com/doc/${i}">Doc ${i}</a>`
    ).join('\n')
    const result = detectNavigationPage(innerText, links)
    expect(result.isNavPage).toBe(true)
    expect(result.links.length).toBe(10)
  })

  it('extracts link text as name', () => {
    const innerText = 'Nav page'
    const html = [
      '<a href="https://saleshub.redhat.com/doc/abc">ServiceNow Integration Guide</a>',
      '<a href="https://saleshub.redhat.com/doc/def">Cisco ACI Battle Card</a>',
      '<a href="https://saleshub.redhat.com/doc/ghi">VMware Migration Playbook</a>',
    ].join('\n')
    const result = detectNavigationPage(innerText, html)
    expect(result.links[0].name).toBe('ServiceNow Integration Guide')
    expect(result.links[0].url).toBe('https://saleshub.redhat.com/doc/abc')
  })
})

// ── extractSubPageLinks (#874 follow-through) ───────────────────────────

describe('extractSubPageLinks', () => {
  it('extracts saleshub.redhat.com links from HTML', () => {
    const html = [
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A</a>',
      '<a href="https://google.com">External</a>',
      '<a href="https://saleshub.redhat.com/doc/def">Doc B</a>',
    ].join('\n')
    const links = extractSubPageLinks(html)
    expect(links.length).toBe(2)
    expect(links[0].url).toBe('https://saleshub.redhat.com/doc/abc')
    expect(links[1].url).toBe('https://saleshub.redhat.com/doc/def')
  })

  it('extracts seismic.com links', () => {
    const html = '<a href="https://redhat.seismic.com/content/xyz">Seismic Doc</a>'
    const links = extractSubPageLinks(html)
    expect(links.length).toBe(1)
    expect(links[0].name).toBe('Seismic Doc')
  })

  it('returns empty array when no internal links', () => {
    const html = '<a href="https://google.com">Google</a><a href="https://aws.amazon.com">AWS</a>'
    const links = extractSubPageLinks(html)
    expect(links.length).toBe(0)
  })

  it('deduplicates by URL', () => {
    const html = [
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A</a>',
      '<a href="https://saleshub.redhat.com/doc/abc">Doc A again</a>',
    ].join('\n')
    const links = extractSubPageLinks(html)
    expect(links.length).toBe(1)
  })

  it('skips links with empty href or hash-only href', () => {
    const html = [
      '<a href="">Empty</a>',
      '<a href="#">Hash</a>',
      '<a href="https://saleshub.redhat.com/doc/abc">Real</a>',
    ].join('\n')
    const links = extractSubPageLinks(html)
    expect(links.length).toBe(1)
  })

  it('uses href as name fallback when text is empty', () => {
    const html = '<a href="https://saleshub.redhat.com/doc/abc"><img src="icon.png"/></a>'
    const links = extractSubPageLinks(html)
    expect(links.length).toBe(1)
    expect(links[0].name).toBe('https://saleshub.redhat.com/doc/abc')
  })
})
