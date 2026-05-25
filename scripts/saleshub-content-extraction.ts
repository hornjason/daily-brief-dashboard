/**
 * scripts/saleshub-content-extraction.ts — Content extraction pipeline for SalesHub knowledge (#369)
 *
 * Fetches linked documents from the knowledge base and extracts usable text/metrics.
 * Enriches tactic and TDP nodes with extracted content.
 *
 * Pure logic module — no browser dependency. Uses Bun's built-in fetch for HTTP.
 * Runs AFTER the scraper, reading and re-writing saleshub-knowledge.json.
 */

import { readFileSync, writeFileSync } from 'fs'
import type { SalesHubKnowledge } from './saleshub-knowledge-extraction.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedMetric {
  value: string
  context: string
  source: string
}

export type UrlClassification = 'fetch' | 'auth-required' | 'slides-api' | 'video' | 'interactive' | 'skip'

// ── URL Classification ──────────────────────────────────────────────────────

/**
 * Classify a URL into fetchable vs skip categories.
 */
export function classifyUrl(url: string): UrlClassification {
  if (!url || url.trim().length === 0) return 'skip'

  // Relative paths (Seismic internal links)
  if (url.startsWith('/apps/') || url.startsWith('/apps')) return 'skip'

  // Google Slides
  if (url.includes('docs.google.com/presentation')) return 'slides-api'

  // Video URLs
  if (url.includes('youtu.be') || url.includes('youtube.com') || url.includes('videos.learning.redhat.com')) return 'video'

  // Demo/interactive sites
  if (url.includes('catalog.demo.redhat.com') || url.includes('demo.redhat.com')) return 'interactive'

  // Source (internal, requires auth)
  if (url.includes('source.redhat.com')) return 'auth-required'

  // Fetchable public URLs
  if (
    url.includes('www.redhat.com') ||
    url.includes('interact.redhat.com') ||
    url.includes('content.redhat.com') ||
    url.includes('access.redhat.com') ||
    url.includes('red.ht') ||
    url.includes('redhat.com')
  ) {
    return 'fetch'
  }

  // Default: attempt fetch for any other URL
  return 'fetch'
}

// ── HTML Text Extraction ────────────────────────────────────────────────────

/**
 * Extract clean text from HTML using regex-based stripping.
 * Prefers content within <main> or <article> tags.
 * Limits output to 2000 characters.
 */
export function extractTextFromHtml(html: string): string {
  if (!html || html.trim().length === 0) return ''

  let content = html

  // Try to extract content within <main> or <article> tags first
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)

  if (mainMatch) {
    content = mainMatch[1]
  } else if (articleMatch) {
    content = articleMatch[1]
  }

  // Remove script and style tags with content
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

  // Remove nav and footer tags with content (if we didn't extract main/article)
  if (!mainMatch && !articleMatch) {
    content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
  }

  // Strip all remaining HTML tags
  content = content.replace(/<[^>]+>/g, ' ')

  // Decode common HTML entities
  content = content
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // Clean up whitespace: collapse multiple spaces/newlines
  content = content.replace(/\s+/g, ' ').trim()

  // Limit to 2000 characters
  if (content.length > 2000) {
    content = content.slice(0, 2000)
  }

  return content
}

// ── Metric Parsing ──────────────────────────────────────────────────────────

/**
 * Parse quantitative metrics from extracted text.
 * Looks for patterns like percentages, dollar amounts, time comparisons.
 */
export function parseMetrics(text: string, sourceUrl: string): ExtractedMetric[] {
  const metrics: ExtractedMetric[] = []
  const seen = new Set<string>()

  // Pattern 1: "X% improvement/reduction/savings/faster/increase/decrease"
  const pctPattern = /(\d+(?:\.\d+)?%)\s+(improvement|reduction|savings|faster|increase|decrease|lower|higher|less|more|growth|decline)/gi
  let match: RegExpExecArray | null
  while ((match = pctPattern.exec(text)) !== null) {
    const value = `${match[1]} ${match[2]}`
    if (!seen.has(value)) {
      seen.add(value)
      const contextStart = Math.max(0, match.index - 40)
      const contextEnd = Math.min(text.length, match.index + match[0].length + 40)
      const context = text.slice(contextStart, contextEnd).trim()
      metrics.push({ value, context, source: sourceUrl })
    }
  }

  // Pattern 2: "reduced/saved/cut X% ..." or "X% reduction in ..."
  const pctContextPattern = /(\d+(?:\.\d+)?%)\s+(?:reduction|improvement|increase|decrease|savings?)\s+in\s+([^.]{5,60})/gi
  while ((match = pctContextPattern.exec(text)) !== null) {
    const value = `${match[1]} reduction`
    const context = match[2].trim()
    const key = `${match[1]}-${context.slice(0, 20)}`
    if (!seen.has(key)) {
      seen.add(key)
      metrics.push({ value, context: `in ${context}`, source: sourceUrl })
    }
  }

  // Pattern 3: "X times faster/slower/more"
  const timesPattern = /(\d+(?:\.\d+)?)\s+times?\s+(faster|slower|more|less|greater|cheaper)/gi
  while ((match = timesPattern.exec(text)) !== null) {
    const value = `${match[1]} times ${match[2]}`
    if (!seen.has(value)) {
      seen.add(value)
      const contextStart = Math.max(0, match.index - 40)
      const contextEnd = Math.min(text.length, match.index + match[0].length + 40)
      const context = text.slice(contextStart, contextEnd).trim()
      metrics.push({ value, context, source: sourceUrl })
    }
  }

  // Pattern 4: "$X savings/saved/million/billion"
  const dollarPattern = /(\$[\d,.]+[MBK]?(?:\s*(?:million|billion))?)\s*(?:saved|savings|annually|in savings|per year)?/gi
  while ((match = dollarPattern.exec(text)) !== null) {
    const value = match[0].trim()
    if (!seen.has(value)) {
      seen.add(value)
      const contextStart = Math.max(0, match.index - 40)
      const contextEnd = Math.min(text.length, match.index + match[0].length + 40)
      const context = text.slice(contextStart, contextEnd).trim()
      metrics.push({ value, context, source: sourceUrl })
    }
  }

  // Pattern 5: "reduced from X to Y"
  const reducedFromPattern = /reduced\s+from\s+(\d+\s*\w+)\s+to\s+(\d+\s*\w+)/gi
  while ((match = reducedFromPattern.exec(text)) !== null) {
    const value = `reduced from ${match[1]} to ${match[2]}`
    if (!seen.has(value)) {
      seen.add(value)
      const contextStart = Math.max(0, match.index - 30)
      const contextEnd = Math.min(text.length, match.index + match[0].length + 30)
      const context = text.slice(contextStart, contextEnd).trim()
      metrics.push({ value, context, source: sourceUrl })
    }
  }

  // Pattern 6: Number + time unit (e.g., "30 days", "4 hours") — only when near comparison words
  const timeUnitPattern = /(\d+)\s+(hours?|days?|minutes?|weeks?|months?)\s+(?:to|from|instead of|down from|versus|vs)/gi
  while ((match = timeUnitPattern.exec(text)) !== null) {
    const value = `${match[1]} ${match[2]}`
    if (!seen.has(value)) {
      seen.add(value)
      const contextStart = Math.max(0, match.index - 30)
      const contextEnd = Math.min(text.length, match.index + match[0].length + 30)
      const context = text.slice(contextStart, contextEnd).trim()
      metrics.push({ value, context, source: sourceUrl })
    }
  }

  return metrics
}

// ── Metric Validation ───────────────────────────────────────────────────────

/**
 * Filter out noise — metric must have a number and context must be > 5 chars.
 */
export function isValidMetric(metric: { value: string; context: string }): boolean {
  return /\d/.test(metric.value) && metric.context.length > 5
}

// ── URL Collection ──────────────────────────────────────────────────────────

interface UrlReference {
  url: string
  nodeType: 'tdp' | 'tactic'
  nodeName: string
}

/**
 * Collect all unique URLs from TDP and Tactic nodes.
 */
function collectUrls(knowledge: SalesHubKnowledge): Map<string, UrlReference[]> {
  const urlMap = new Map<string, UrlReference[]>()

  const addUrl = (url: string, nodeType: 'tdp' | 'tactic', nodeName: string) => {
    if (!url || url.trim().length === 0) return
    const refs = urlMap.get(url) ?? []
    refs.push({ url, nodeType, nodeName })
    urlMap.set(url, refs)
  }

  // TDP nodes
  for (const tdp of knowledge.tdps) {
    for (const item of tdp.whatToSay ?? []) addUrl(item.url, 'tdp', tdp.name)
    for (const item of tdp.whatToShare ?? []) addUrl(item.url, 'tdp', tdp.name)
    for (const item of tdp.whatToShow ?? []) addUrl(item.url, 'tdp', tdp.name)
  }

  // Tactic nodes
  for (const tactic of knowledge.tactics) {
    for (const item of tactic.whatToShare ?? []) addUrl(item.url, 'tactic', tactic.name)
  }

  return urlMap
}

// ── Main Enrichment Pipeline ────────────────────────────────────────────────

/**
 * Enrich the knowledge base by fetching linked documents and extracting content.
 * Reads saleshub-knowledge.json, fetches URLs, extracts text/metrics, writes back.
 */
export async function enrichKnowledgeBase(knowledgePath: string): Promise<{
  urlsFetched: number
  urlsSkipped: number
  metricsFound: number
}> {
  const raw = readFileSync(knowledgePath, 'utf-8')
  const knowledge: SalesHubKnowledge = JSON.parse(raw)

  const urlMap = collectUrls(knowledge)
  const allUrls = Array.from(urlMap.keys())

  let urlsFetched = 0
  let urlsSkipped = 0
  let metricsFound = 0

  // Content cache: url -> { text, metrics }
  const contentCache = new Map<string, { text: string; metrics: ExtractedMetric[] }>()

  for (const url of allUrls) {
    const classification = classifyUrl(url)

    if (classification !== 'fetch') {
      urlsSkipped++
      const reason = classification === 'skip' ? 'relative/internal' : classification
      console.log(`[skip] ${reason}: ${url.slice(0, 80)}`)
      continue
    }

    try {
      // Rate limit: 500ms between fetches
      if (urlsFetched > 0) await new Promise(r => setTimeout(r, 500))

      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SalesHubEnrichment/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      })

      if (!response.ok) {
        console.log(`[skip] HTTP ${response.status}: ${url.slice(0, 80)}`)
        urlsSkipped++
        continue
      }

      const html = await response.text()
      const text = extractTextFromHtml(html)
      const metrics = parseMetrics(text, url).filter(m => isValidMetric(m))

      contentCache.set(url, { text, metrics })
      urlsFetched++
      metricsFound += metrics.length

      console.log(`[ok] ${url.slice(0, 60)} -> ${text.length} chars, ${metrics.length} metrics`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[error] ${url.slice(0, 60)}: ${msg}`)
      urlsSkipped++
    }
  }

  // Map extracted content back to nodes
  for (const tdp of knowledge.tdps) {
    const parts: string[] = []
    const allMetrics: ExtractedMetric[] = []

    for (const item of [...(tdp.whatToSay ?? []), ...(tdp.whatToShare ?? []), ...(tdp.whatToShow ?? [])]) {
      const cached = contentCache.get(item.url)
      if (cached) {
        if (cached.text) parts.push(cached.text.slice(0, 500))
        allMetrics.push(...cached.metrics)
      }
    }

    tdp.extractedContent = parts.join('\n\n').slice(0, 2000)
    tdp.metrics = allMetrics
  }

  for (const tactic of knowledge.tactics) {
    const parts: string[] = []
    const allMetrics: ExtractedMetric[] = []

    for (const item of tactic.whatToShare ?? []) {
      const cached = contentCache.get(item.url)
      if (cached) {
        if (cached.text) parts.push(cached.text.slice(0, 500))
        allMetrics.push(...cached.metrics)
      }
    }

    tactic.extractedContent = parts.join('\n\n').slice(0, 2000)
    tactic.metrics = allMetrics
  }

  // Write enriched knowledge back
  writeFileSync(knowledgePath, JSON.stringify(knowledge, null, 2))

  console.log(`\n[done] Fetched: ${urlsFetched}, Skipped: ${urlsSkipped}, Metrics: ${metricsFound}`)

  return { urlsFetched, urlsSkipped, metricsFound }
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

if (import.meta.main) {
  const knowledgePath = process.argv[2] ?? 'config/saleshub-knowledge.json'
  console.log(`Enriching knowledge base from: ${knowledgePath}`)
  enrichKnowledgeBase(knowledgePath)
    .then(result => {
      console.log(`Result: ${JSON.stringify(result)}`)
    })
    .catch(err => {
      console.error(`Failed: ${err.message}`)
      process.exit(1)
    })
}
