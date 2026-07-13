/**
 * News Provider — Google Search-grounded Gemini news discovery and scoring
 *
 * Searches for recent news about customers, generates summaries, and scores
 * significance for Red Hat Account Solution Architects.
 */

import { callGemini } from './gemini-call.ts'
import { loadNewsConfig, type NewsConfig } from './news-config.ts'

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

const NEWS_SEARCH_SYSTEM_PROMPT = 'You are a B2B sales intelligence assistant providing actionable insights. For every piece of information, explicitly frame how Red Hat solutions can address the identified business challenges or opportunities. Focus on connecting Red Hat\'s offerings directly to the customer\'s potential pain points and highlighting the value proposition. Ensure the output helps sales professionals understand how Red Hat can solve specific customer problems, not just list product features.';

// ── Keyword-based heuristic scoring (#491) ──────────────────────────────────

/**
 * Deterministic scoring for obvious cases. Returns null when
 * the article needs Gemini's contextual judgment.
 *
 * Score ranges align with news-config.ts significanceGuidelines:
 * - 9-10: Critical (bankruptcy, major acquisition, C-suite departure)
 * - 7-8:  Important (new tech initiative, major partnership, earnings)
 * - 4-6:  Notable (product launch, minor leadership, industry report)
 * - 1-3:  Low (routine press release, minor mention)
 * - Otherwise → null (needs Gemini)
 */
function scoreByKeywords(
  article: Omit<NewsItem, 'significanceScore'>,
  customerName: string,
  config: NewsConfig
): number | null {
  const text = (article.headline + ' ' + article.summary).toLowerCase()
  const customerLower = customerName.toLowerCase()

  // Critical keywords from config → score 8-9
  for (const kw of config.criticalKeywords) {
    if (text.includes(kw.toLowerCase())) {
      if (text.includes(customerLower)) return 9
      return 8
    }
  }

  // Exclude keywords → score 2
  for (const kw of config.excludeKeywords) {
    if (text.includes(kw.toLowerCase())) return 2
  }

  // Customer name in headline specifically → score 7
  if (article.headline.toLowerCase().includes(customerLower)) return 7

  // High-signal types
  const highSignalTypes = new Set(['acquisition', 'partnership', 'earnings', 'leadership'])
  if (highSignalTypes.has(article.signalType)) return 7

  // Medium-signal types
  const mediumSignalTypes = new Set(['product', 'technology', 'regulatory', 'financial'])
  if (mediumSignalTypes.has(article.signalType)) return 5

  // Low-signal types
  const lowSignalTypes = new Set(['blog post', 'thought leadership', 'company news'])
  if (lowSignalTypes.has(article.signalType)) return 4

  return null
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

    const result = await callGemini(NEWS_SEARCH_SYSTEM_PROMPT, userPrompt, {
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
    const resolved: Omit<NewsItem, 'significanceScore'>[] = []

    for (const article of articles) {
      if (article.sourceUrl.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
        // Resolve Vertex AI redirect tokens
        let resolvedArticle: Omit<NewsItem, 'significanceScore'> | null = null

        try {
          const res = await fetch(article.sourceUrl, { redirect: 'manual' })
          const location = res.headers.get('location')
          if (location && this.isValidUrl(location)) {
            resolvedArticle = { ...article, sourceUrl: location }
          } else {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            try {
              const followRes = await fetch(article.sourceUrl, {
                redirect: 'follow',
                signal: controller.signal
              })
              clearTimeout(timeout)
              if (followRes.ok && this.isValidUrl(followRes.url)) {
                resolvedArticle = { ...article, sourceUrl: followRes.url }
              }
            } catch (followErr: any) {
              clearTimeout(timeout)
              console.warn(`[news-provider] Follow redirect failed for "${article.headline}": ${followErr.message}`)
            }
          }
        } catch (e: any) {
          console.warn(`[news-provider] Failed to resolve redirect for "${article.headline}": ${e.message}`)
        }

        if (!resolvedArticle) {
          const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(article.headline)}`
          console.warn(`[news-provider] Using Google search fallback for "${article.headline}"`)
          resolvedArticle = { ...article, sourceUrl: fallbackUrl }
        }

        resolved.push(resolvedArticle)
      } else {
        // Non-redirect URL — validate with HTTP HEAD
        const validated = await this.validateArticleUrl(article)
        resolved.push(validated)
      }
    }

    return resolved
  }

  private async validateArticleUrl(article: Omit<NewsItem, 'significanceScore'>): Promise<Omit<NewsItem, 'significanceScore'>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    try {
      const res = await fetch(article.sourceUrl, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      })
      clearTimeout(timeout)

      if (res.ok) return article
    } catch {
      clearTimeout(timeout)
    }

    const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(article.headline)}`
    console.warn(`[news-provider] URL validation failed for "${article.headline}" (${article.sourceUrl}), using Google search fallback`)
    return { ...article, sourceUrl: fallbackUrl }
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
   *
   * Try keyword-based heuristic scoring first. Only send articles to Gemini
   * that couldn't be scored deterministically.
   */
  private async scoreSignificance(articles: Omit<NewsItem, 'significanceScore'>[], customerName: string): Promise<NewsItem[]> {
    const config = loadNewsConfig()

    // Try keyword scoring first
    const scored: NewsItem[] = []
    const needsGemini: Omit<NewsItem, 'significanceScore'>[] = []

    for (const article of articles) {
      const keywordScore = scoreByKeywords(article, customerName, config)
      if (keywordScore !== null) {
        scored.push({ ...article, significanceScore: keywordScore })
      } else {
        needsGemini.push(article)
      }
    }

    if (needsGemini.length === 0) {
      console.log(`[news-provider] all ${scored.length} articles scored by keyword heuristic, skipping Gemini`)
      return scored
    }

    console.log(`[news-provider] ${scored.length} articles scored by keyword heuristic, ${needsGemini.length} need Gemini scoring`)

    const guidelines = Object.entries(config.significanceGuidelines)
      .map(([range, desc]) => `- ${range}: ${desc}`)
      .join('\n')

    const userPrompt = `Score each article 1-10 for business significance to a Red Hat Account Solution Architect managing this customer:
${guidelines}

Higher scores for articles mentioning: ${config.criticalKeywords.join(', ')}
Lower scores for articles mentioning: ${config.excludeKeywords.join(', ')}

Input articles: ${JSON.stringify(needsGemini, null, 2)}

Return: same array with significanceScore (integer 1-10) added to each item.
Return valid JSON only — no markdown, no code blocks, no explanatory text.`

    const result = await callGemini(NEWS_SEARCH_SYSTEM_PROMPT, userPrompt, {
      callType: 'news-scoring',
      customerName,
      temperature: 0.2,
    })

    if (!result.text) {
      console.warn('[news-provider] Gemini returned no content for scoring query')
      const geminiScored = needsGemini.map(a => ({ ...a, significanceScore: config.defaultThreshold }))
      return [...scored, ...geminiScored]
    }

    let geminiScored: NewsItem[]
    try {
      const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsedArticles = JSON.parse(cleaned)

      if (!Array.isArray(parsedArticles)) {
        console.warn('[news-provider] Gemini scoring response was not an array')
        geminiScored = needsGemini.map(a => ({ ...a, significanceScore: config.defaultThreshold }))
      } else {
        geminiScored = parsedArticles
      }
    } catch (e: any) {
      console.warn('[news-provider] Failed to parse Gemini scoring response:', e.message)
      geminiScored = needsGemini.map(a => ({ ...a, significanceScore: config.defaultThreshold }))
    }

    return [...scored, ...geminiScored]
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
