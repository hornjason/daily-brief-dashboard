/**
 * News Provider — Google Search-grounded Gemini news discovery and scoring
 *
 * Searches for recent news about customers, generates summaries, and scores
 * significance for Red Hat Account Solution Architects.
 */

import { getGeminiToken } from './gemini-auth.ts'
import { getGeminiModel } from './ai-config.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'

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
  searchNews(customerName: string): Promise<NewsItem[]>
}

// ── Implementation ───────────────────────────────────────────────────────────

class GeminiGroundedNewsProvider implements NewsProvider {
  async searchNews(customerName: string): Promise<NewsItem[]> {
    // Call 1: Search for recent news with Google Search grounding
    const articles = await this.searchAndExtract(customerName)

    if (articles.length === 0) {
      return []
    }

    // Call 2: Score significance for each article
    const scoredArticles = await this.scoreSignificance(articles, customerName)

    return scoredArticles
  }

  /**
   * First Gemini call: Search for news with Google Search grounding and extract structured data
   */
  private async searchAndExtract(customerName: string): Promise<Omit<NewsItem, 'significanceScore'>[]> {
    const token = await getGeminiToken()
    const model = getGeminiModel()
    const endpoint = `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/us-central1/publishers/google/models/${model}:generateContent`

    const searchPrompt = `Search for recent news articles (last 48 hours) about ${customerName}.
Find articles about: leadership changes, acquisitions, partnerships, earnings,
layoffs, product launches, regulatory issues, or major business developments.

Return JSON array: [{ headline, summary, sourceUrl, sourceName, publishedDate, signalType }]
Return empty array if no significant news found. Do not fabricate articles.

For each article:
- headline: exact article title
- summary: 2-3 sentence summary of the article
- sourceUrl: direct link to the article
- sourceName: publication name (e.g., "Reuters", "TechCrunch", "Bloomberg")
- publishedDate: ISO 8601 date string
- signalType: one of "leadership", "acquisition", "partnership", "earnings", "technology", "regulatory", "financial", "product", "other"

Return valid JSON only — no markdown, no code blocks, no explanatory text.`

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
      tools: [{ googleSearchRetrieval: {} }],  // Enable Google Search grounding
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini search request failed (${response.status}): ${errorText}`)
    }

    const data = await response.json()

    // Record usage for cost tracking
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType: 'news-search',
      customerName,
      model,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    })

    // Extract text from response
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!content) {
      console.warn('[news-provider] Gemini returned no content for search query')
      return []
    }

    // Parse JSON response
    try {
      // Strip markdown code blocks if present
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const articles = JSON.parse(cleaned)

      if (!Array.isArray(articles)) {
        console.warn('[news-provider] Gemini search response was not an array')
        return []
      }

      return articles
    } catch (e: any) {
      console.warn('[news-provider] Failed to parse Gemini search response:', e.message)
      console.warn('[news-provider] Raw response:', content.slice(0, 500))
      return []
    }
  }

  /**
   * Second Gemini call: Score significance of articles
   */
  private async scoreSignificance(articles: Omit<NewsItem, 'significanceScore'>[], customerName: string): Promise<NewsItem[]> {
    const token = await getGeminiToken()
    const model = getGeminiModel()
    const endpoint = `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/us-central1/publishers/google/models/${model}:generateContent`

    const scoringPrompt = `Score each article 1-10 for business significance to a Red Hat Account Solution Architect managing this customer:
- 9-10: Critical (bankruptcy, major acquisition, C-suite departure)
- 7-8: Important (new tech initiative, major partnership, earnings surprise)
- 4-6: Notable (product launch, minor leadership change, industry report)
- 1-3: Low (routine press release, minor mention)

Input articles: ${JSON.stringify(articles, null, 2)}

Return: same array with significanceScore (integer 1-10) added to each item.
Return valid JSON only — no markdown, no code blocks, no explanatory text.`

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: scoringPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini scoring request failed (${response.status}): ${errorText}`)
    }

    const data = await response.json()

    // Record usage for cost tracking
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType: 'news-scoring',
      customerName,
      model,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    })

    // Extract text from response
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!content) {
      console.warn('[news-provider] Gemini returned no content for scoring query')
      // Fallback: return articles with default score of 5
      return articles.map(a => ({ ...a, significanceScore: 5 }))
    }

    // Parse JSON response
    try {
      // Strip markdown code blocks if present
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const scoredArticles = JSON.parse(cleaned)

      if (!Array.isArray(scoredArticles)) {
        console.warn('[news-provider] Gemini scoring response was not an array')
        return articles.map(a => ({ ...a, significanceScore: 5 }))
      }

      return scoredArticles
    } catch (e: any) {
      console.warn('[news-provider] Failed to parse Gemini scoring response:', e.message)
      console.warn('[news-provider] Raw response:', content.slice(0, 500))
      // Fallback: return articles with default score of 5
      return articles.map(a => ({ ...a, significanceScore: 5 }))
    }
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const newsProvider: NewsProvider = new GeminiGroundedNewsProvider()
