/**
 * News Provider — Google Search-grounded Gemini news discovery and scoring
 *
 * Searches for recent news about customers, generates summaries, and scores
 * significance for Red Hat Account Solution Architects.
 */

import { callGemini } from './gemini-call.ts'
import { loadNewsConfig } from './news-config.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface NewsItem {
  headline: string
  summary: string        // Gemini-generated 2-3 sentence summary
  sourceUrl: string      // link to original article
  sourceName: string     // e.g. "Reuters", "TechCrunch"
  publishedDate: string  // ISO date
  significanceScore: number  // 1-10
  signalType: string     // e.g. "leadership", "acquisition", "partnership", "earnings", "technology"
}

export interface NewsProvider {
  searchNews(customerName: string, domain?: string): Promise<NewsItem[]>
}

// ── Implementation ───────────────────────────────────────────────────────────

class GeminiGroundedNewsProvider implements NewsProvider {
  async searchNews(customerName: string, domain?: string): Promise<NewsItem[]> {
    // Call 1: Search for recent news with Google Search grounding
    const articles = await this.searchAndExtract(customerName, domain)

    if (articles.length === 0) {
      return []
    }

    // Call 2: Score significance for each article
    const scoredArticles = await this.scoreSignificance(articles, customerName)

    // Call 3: Deduplicate articles by topic similarity
    const deduplicated = this.deduplicateArticles(scoredArticles)

    return deduplicated
  }

  /**
   * First Gemini call: Search for news with Google Search grounding and extract structured data
   */
  private async searchAndExtract(customerName: string, domain?: string): Promise<Omit<NewsItem, 'significanceScore'>[]> {
    const config = loadNewsConfig()

    const domainLine = domain
      ? `\nIMPORTANT: Search site:${domain} specifically for recent blog posts, press releases, and company announcements. Include results from ${domain}/blog, ${domain}/news, ${domain}/press, and ${domain}/resources if they exist.`
      : ''

    const userPrompt = `Search for recent news, blog posts, press releases, thought leadership, and company announcements (last ${config.searchDepthDays * 24} hours) about ${customerName}.${domainLine}
Find content about: ${config.signalTypes.join(', ')}.

Return JSON array: [{ headline, summary, sourceUrl, sourceName, publishedDate, signalType }]
Return empty array if no significant content found. Do not fabricate articles.

For each item:
- headline: exact article or post title
- summary: 2-3 sentence summary of the content
- sourceUrl: direct link to the article or blog post
- sourceName: publication or website name (e.g., "Reuters", "TechCrunch", "${customerName} Blog")
- publishedDate: ISO 8601 date string
- signalType: one of "leadership", "acquisition", "partnership", "earnings", "technology", "regulatory", "financial", "product", "thought leadership", "blog post", "company news", "other"

Return valid JSON only — no markdown, no code blocks, no explanatory text.`

    const result = await callGemini('', userPrompt, {
      callType: 'news-search',
      customerName,
      temperature: 0.3,
      grounding: true,
      // No deltaKey — news is real-time grounded search, always fresh
    })

    if (!result.text) {
      console.warn('[news-provider] Gemini returned no content for search query')
      return []
    }

    // Parse JSON response
    let articles: Omit<NewsItem, 'significanceScore'>[]
    try {
      // Strip markdown code blocks if present
      const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      articles = JSON.parse(cleaned)

      if (!Array.isArray(articles)) {
        console.warn('[news-provider] Gemini search response was not an array')
        return []
      }
    } catch (e: any) {
      console.warn('[news-provider] Failed to parse Gemini search response:', e.message)
      console.warn('[news-provider] Raw response:', result.text.slice(0, 500))
      return []
    }

    // Resolve redirect URLs to actual article URLs
    const resolvedArticles = await this.resolveUrls(articles)
    return resolvedArticles
  }

  /**
   * Resolve article URLs from grounding metadata
   *
   * Gemini's grounded search returns temporary redirect tokens as sourceUrl.
   * The actual article URLs are in groundingMetadata.groundingChunks[].web.uri
   *
   * Issue #215: Article URLs from Gemini grounded search are broken redirect tokens
   */
  private async resolveUrls(articles: Omit<NewsItem, 'significanceScore'>[]): Promise<Omit<NewsItem, 'significanceScore'>[]> {
    const resolved = await Promise.all(articles.map(async (article) => {
      if (!article.sourceUrl.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
        return article
      }

      try {
        // First try: manual redirect with immediate check
        const res = await fetch(article.sourceUrl, { redirect: 'manual' })
        const location = res.headers.get('location')
        if (location && this.isValidUrl(location)) {
          return { ...article, sourceUrl: location }
        }

        // Second try: full redirect follow with timeout for slow redirects
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        try {
          const followRes = await fetch(article.sourceUrl, {
            redirect: 'follow',
            signal: controller.signal
          })
          clearTimeout(timeout)

          if (followRes.ok && this.isValidUrl(followRes.url)) {
            return { ...article, sourceUrl: followRes.url }
          }
        } catch (followErr: any) {
          clearTimeout(timeout)
          console.warn(`[news-provider] Follow redirect failed for "${article.headline}": ${followErr.message}`)
        }
      } catch (e: any) {
        console.warn(`[news-provider] Failed to resolve redirect for "${article.headline}": ${e.message}`)
      }

      // If we couldn't resolve, use Google search fallback instead of broken link
      const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(article.headline)}`
      console.warn(`[news-provider] Using Google search fallback for "${article.headline}"`)
      return { ...article, sourceUrl: fallbackUrl }
    }))

    return resolved
  }

  /**
   * Validate URL is well-formed HTTP(S) and not a redirect token
   */
  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      const isHttpOrHttps = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      const isNotRedirect = !url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')
      return isHttpOrHttps && isNotRedirect
    } catch {
      return false
    }
  }

  /**
   * Second Gemini call: Score significance of articles
   */
  private async scoreSignificance(articles: Omit<NewsItem, 'significanceScore'>[], customerName: string): Promise<NewsItem[]> {
    const config = loadNewsConfig()

    // Build scoring guidelines from config
    const guidelines = Object.entries(config.significanceGuidelines)
      .map(([range, desc]) => `- ${range}: ${desc}`)
      .join('\n')

    const userPrompt = `Score each article 1-10 for business significance to a Red Hat Account Solution Architect managing this customer:
${guidelines}

Higher scores for articles mentioning: ${config.criticalKeywords.join(', ')}
Lower scores for articles mentioning: ${config.excludeKeywords.join(', ')}

Input articles: ${JSON.stringify(articles, null, 2)}

Return: same array with significanceScore (integer 1-10) added to each item.
Return valid JSON only — no markdown, no code blocks, no explanatory text.`

    const result = await callGemini('', userPrompt, {
      callType: 'news-scoring',
      customerName,
      temperature: 0.2,
      // No deltaKey — scoring depends on fresh articles from search
    })

    if (!result.text) {
      console.warn('[news-provider] Gemini returned no content for scoring query')
      // Fallback: return articles with default score from config
      return articles.map(a => ({ ...a, significanceScore: config.defaultThreshold }))
    }

    // Parse JSON response
    try {
      // Strip markdown code blocks if present
      const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const scoredArticles = JSON.parse(cleaned)

      if (!Array.isArray(scoredArticles)) {
        console.warn('[news-provider] Gemini scoring response was not an array')
        return articles.map(a => ({ ...a, significanceScore: config.defaultThreshold }))
      }

      return scoredArticles
    } catch (e: any) {
      console.warn('[news-provider] Failed to parse Gemini scoring response:', e.message)
      console.warn('[news-provider] Raw response:', result.text.slice(0, 500))
      // Fallback: return articles with default score from config
      return articles.map(a => ({ ...a, significanceScore: config.defaultThreshold }))
    }
  }

  /**
   * Deduplicate articles by topic similarity
   *
   * Groups articles with 60%+ headline word overlap (after normalization),
   * keeps the best article from each group (highest score, resolved URLs preferred,
   * longer summaries for tie-breaking).
   *
   * Issue #221: Multiple articles about same event should show only the best one
   */
  private deduplicateArticles(articles: NewsItem[]): NewsItem[] {
    if (articles.length === 0) {
      return []
    }

    // Normalize headline for comparison
    const normalize = (headline: string) =>
      headline.toLowerCase()
        .replace(/\s*[\|\-–—]\s*[\w\s.]+$/, '')  // remove "| Source" or "- Source" suffix
        .replace(/[^\w\s]/g, '')                    // remove punctuation
        .trim()

    // Group articles by similarity
    const groups: NewsItem[][] = []
    for (const article of articles) {
      const norm = normalize(article.headline)
      const words = new Set(norm.split(/\s+/))

      let matched = false
      for (const group of groups) {
        const groupNorm = normalize(group[0].headline)
        const groupWords = new Set(groupNorm.split(/\s+/))

        // Calculate word overlap
        const intersection = [...words].filter(w => groupWords.has(w)).length
        const overlap = intersection / Math.max(words.size, groupWords.size)

        if (overlap >= 0.6) {
          group.push(article)
          matched = true
          break
        }
      }

      if (!matched) {
        groups.push([article])
      }
    }

    // Pick best from each group
    return groups.map(group => {
      return group.sort((a, b) => {
        // Primary: highest significance score
        if (b.significanceScore !== a.significanceScore) {
          return b.significanceScore - a.significanceScore
        }

        // Tie-break 1: prefer resolved URLs (not Google search fallbacks)
        const aIsResolved = !a.sourceUrl.includes('google.com/search')
        const bIsResolved = !b.sourceUrl.includes('google.com/search')
        if (aIsResolved !== bIsResolved) {
          return aIsResolved ? -1 : 1
        }

        // Tie-break 2: prefer longer summaries
        return b.summary.length - a.summary.length
      })[0]
    }).sort((a, b) => b.significanceScore - a.significanceScore)
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const newsProvider: NewsProvider = new GeminiGroundedNewsProvider()
