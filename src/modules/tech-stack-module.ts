// src/modules/tech-stack-module.ts
// GitHub Issue #307 — Customer tech stack detection + Red Hat positioning research
// Detects customer technologies from intelligence, docs, news, and CCSP caches.
// Tier 1: static lookup from tech-positioning.json for industry tools.
// Tier 2: Gemini grounded search for proprietary/customer-specific tech.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { toSlug } from '../cache-layer.ts'
import { getGeminiToken } from '../gemini-auth.ts'
import { getGeminiModel } from '../ai-config.ts'
import { recordGeminiUsage } from '../gemini-cost-tracker.ts'
import { sanitizeErr } from '../utils.ts'
import { getCustomerSolutionContext } from '../lib/customer-solution-context.ts'
import { validateAndRetry, formatFailureFeedback } from '../gemini-quality-gate.ts'
import { techStackValidator } from '../quality-validators/tech-stack-validator.ts'

// ── Paths ──────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CONFIG_DIR = process.env.CONFIG_DIR ?? 'config'
const TECH_CACHE_DIR = resolve(CACHE_DIR, 'tech-stack')
const TECH_STACK_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// Ensure cache directory exists
if (!existsSync(TECH_CACHE_DIR)) {
  mkdirSync(TECH_CACHE_DIR, { recursive: true })
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface TechEntry {
  name: string
  category: 'proprietary' | 'industry-tool'
  context: 'using' | 'evaluating' | 'migrating_from' | 'developing'
  description: string
  why?: string
  infrastructure: string[]
  redHatProducts: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  redHatPositioning?: string
  source?: string
  lastResearched: string
}

interface TechStackCache {
  contentHash: string
  technologies: TechEntry[]
  cachedAt: string
}

interface TechPositioningEntry {
  name: string
  aliases: string[]
  category: string
  redHatPositioning: string
  redHatProducts: string[]
}

interface TechPositioningFile {
  version: number
  tools: TechPositioningEntry[]
}

// ── Static positioning lookup ──────────────────────────────────────────────────

let _positioningCache: TechPositioningFile | null = null

function loadTechPositioning(): TechPositioningFile {
  if (_positioningCache) return _positioningCache

  // Try config dir first (runtime copy), then config-templates (shipped default)
  const paths = [
    resolve(CONFIG_DIR, 'tech-positioning.json'),
    resolve('config-templates', 'tech-positioning.json'),
  ]

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        _positioningCache = JSON.parse(readFileSync(p, 'utf-8'))
        return _positioningCache!
      }
    } catch { /* try next */ }
  }

  return { version: 1, tools: [] }
}

function lookupPositioning(techName: string): TechPositioningEntry | null {
  const positioning = loadTechPositioning()
  const needle = techName.toLowerCase()

  for (const tool of positioning.tools) {
    if (tool.name.toLowerCase() === needle) return tool
    if (tool.aliases.some(a => a.toLowerCase() === needle)) return tool
  }

  return null
}

// ── Source readers ──────────────────────────────────────────────────────────────

function readIntelligenceCache(customerSlug: string): { company: string; industry: string } | null {
  try {
    const p = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
    if (!existsSync(p)) return null
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    return { company: String(d.company ?? ''), industry: String(d.industry ?? '') }
  } catch { return null }
}

function readNewsCache(customerSlug: string): { articleCount: number; techArticles: string[] } {
  try {
    const p = resolve(CACHE_DIR, 'news', `${customerSlug}.json`)
    if (!existsSync(p)) return { articleCount: 0, techArticles: [] }
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    const articles: any[] = d.articles ?? []
    const techArticles = articles
      .filter((a: any) => a.signalType === 'technology' || a.signalType === 'product_launch')
      .map((a: any) => `${a.headline}: ${a.summary?.slice(0, 200) ?? ''}`)
    return { articleCount: articles.length, techArticles }
  } catch { return { articleCount: 0, techArticles: [] } }
}

function readCcspCache(customerSlug: string): string[] {
  try {
    const p = resolve(CACHE_DIR, 'ccsp.json')
    if (!existsSync(p)) return []
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    const records: any[] = d.records ?? []
    const slug = customerSlug.toLowerCase()
    const matched = records.filter((r: any) => {
      const name = toSlug(r.accountName ?? '')
      return name === slug
    })
    // Extract unique cloud partner names
    const partners = new Set<string>()
    for (const r of matched) {
      if (r.cloudPartner) partners.add(r.cloudPartner)
      if (r.cloudProvider) partners.add(r.cloudProvider)
    }
    return Array.from(partners)
  } catch { return [] }
}

function readDocSignals(customerSlug: string): string[] {
  try {
    const p = resolve(CACHE_DIR, 'doc-classify', `${customerSlug}.json`)
    if (!existsSync(p)) return []
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    // DocClassification stores technical_signals array
    const signals: string[] = []
    if (Array.isArray(d.classifications)) {
      for (const cls of d.classifications) {
        if (Array.isArray(cls.technical_signals)) {
          signals.push(...cls.technical_signals)
        }
      }
    }
    return signals
  } catch { return [] }
}

function readExistingTechCache(customerSlug: string): TechStackCache | null {
  try {
    const p = resolve(TECH_CACHE_DIR, `${customerSlug}.json`)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}

// ── Gemini calls ───────────────────────────────────────────────────────────────

async function extractTechnologies(customerName: string, context: string): Promise<TechEntry[]> {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'

  if (!project) {
    console.warn('[tech-stack] GOOGLE_CLOUD_PROJECT not set — skipping tech extraction')
    return []
  }

  const model = getGeminiModel()
  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const systemPrompt = `You are a technology detection system for enterprise customer analysis. You actively research companies using Google Search to discover their real technology stack from public sources.

Research strategy:
- Search for job postings on the company's careers page and job boards — these reveal internal tools, frameworks, and platforms
- Find case studies, press releases, and partner announcements that name specific technologies
- Check engineering blog posts and tech talks by company employees for tooling details
- Look for partner ecosystem announcements (e.g., cloud provider partnerships, ISV integrations)
- Find specific tool names and versions, not generic categories (e.g., "Terraform 1.5" not "IaC tool")

Rules:
- Be specific — only include technologies with evidence from search results or the provided context
- Classify each as "proprietary" (customer-built/specific) or "industry-tool" (widely used)
- Context classification — be precise about the customer's relationship with each technology:
  - "using" = confirmed in production, currently deployed and actively used
  - "evaluating" = mentioned in job posting as desired/preferred skill, POC, or trial
  - "migrating_from" = moving away from this tool, replacing with alternative
  - "developing" = building on/with this platform, custom development
- For each technology, include a "why" field: a single sentence explaining WHY the customer uses this tool (e.g., "Workflow automation for security operations"). Do NOT repeat the full description — summarize the business purpose in one sentence.
- For infrastructure, list underlying platforms (e.g., ["Kubernetes", "AWS"])
- For redHatProducts, suggest Red Hat product slugs that complement this tech: ocp, rhel, aap, acs, acm, satellite, rhdh, quay
- Confidence: HIGH = explicitly mentioned in search results, MEDIUM = strongly implied, LOW = inferred from context
- For the source field, include the FULL URL where you found evidence — not a citation number. If the evidence comes from the provided context, set source to "provided-context".
- Output valid JSON array only`

  const userPrompt = `CUSTOMER: ${customerName}

--- Context ---
${context.slice(0, 12000)}

Research this customer's technology stack using Google Search. Look for job postings, case studies, partner announcements, and engineering blog posts. Extract all technologies with evidence. Return a JSON array:
[
  {
    "name": "Technology Name",
    "category": "proprietary" | "industry-tool",
    "context": "using" | "evaluating" | "migrating_from" | "developing",
    "description": "1-2 sentence description of what it is and how the customer uses it",
    "why": "One sentence summarizing the business purpose (e.g., 'Container orchestration for microservices deployment')",
    "infrastructure": ["underlying platforms"],
    "redHatProducts": ["ocp", "rhel", "aap"],
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "source": "Full URL where you found evidence (e.g., https://example.com/careers/posting-123). NOT a citation number."
  }
]

IMPORTANT for the source field: Include the FULL URL where you found evidence of usage. Do NOT use citation numbers like "cite: 1" — use the actual URL. If a technology comes from the provided context rather than search results, set source to "provided-context".

Return ONLY the JSON array, no markdown fences.`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[tech-stack] Gemini extraction error ${res.status}: ${sanitizeErr(err)}`)
      return []
    }

    const json = await res.json() as any

    // Record token usage
    const usage = json.usageMetadata
    if (usage) {
      recordGeminiUsage({
        timestamp: new Date().toISOString(),
        callType: 'tech-stack-extract',
        customerName,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model,
      })
    }

    const candidate = json.candidates?.[0]
    const parts: any[] = candidate?.content?.parts ?? []

    // Extract and IMMEDIATELY resolve grounding sources — redirect URLs expire quickly
    const groundingMetadata = candidate?.groundingMetadata
    const rawGroundingUrls: string[] = []
    if (groundingMetadata?.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk?.web?.uri) rawGroundingUrls.push(chunk.web.uri)
      }
    }
    // Resolve all redirect URLs in parallel while they're still fresh
    const groundingSources = await resolveGroundingRedirects(rawGroundingUrls)

    // Grounded search may return multiple text parts with duplicate content.
    // Parse the first part that contains a valid JSON array.
    let jsonMatch: RegExpMatchArray | null = null
    for (const p of parts) {
      const t = (p.text ?? '').trim()
      if (!t) continue
      jsonMatch = t.match(/```json\s*([\s\S]*?)\s*```/) ?? t.match(/(\[[\s\S]*\])/)
      if (jsonMatch) break
    }

    if (jsonMatch) {
      let jsonText = jsonMatch[1] ?? jsonMatch[0]
      // Grounded search URLs may contain unescaped characters that break JSON.
      // Try parse as-is first; on failure, attempt to sanitize truncated entries.
      let parsed: any[]
      try {
        parsed = JSON.parse(jsonText)
      } catch {
        // Truncated response: find the last complete object and close the array
        const lastComplete = jsonText.lastIndexOf('},')
        if (lastComplete > 0) {
          jsonText = jsonText.slice(0, lastComplete + 1) + ']'
          try {
            parsed = JSON.parse(jsonText)
            console.log(`[tech-stack] recovered ${parsed.length} entries from truncated response for ${customerName}`)
          } catch {
            console.error(`[tech-stack] unrecoverable JSON for ${customerName}, text length=${jsonText.length}`)
            return []
          }
        } else {
          console.error(`[tech-stack] unrecoverable JSON for ${customerName}, text length=${jsonText.length}`)
          return []
        }
      }
      if (!Array.isArray(parsed)) return []

      // ADR-024: Quality gate — validate parsed JSON before proceeding
      const gateResult = await validateAndRetry(
        JSON.stringify(parsed),
        { validator: techStackValidator },
        async (failures, _attempt) => {
          const feedback = formatFailureFeedback(failures)
          // Re-invoke Gemini with failure feedback appended
          const retryRes = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(60_000),
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: userPrompt + '\n\n' + feedback }] }],
              tools: [{ googleSearch: {} }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 8192,
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
          })
          if (!retryRes.ok) throw new Error(`Gemini retry failed: ${retryRes.status}`)
          const retryJson = await retryRes.json() as any
          const retryParts: any[] = retryJson.candidates?.[0]?.content?.parts ?? []
          let retryMatch: RegExpMatchArray | null = null
          for (const p of retryParts) {
            const t = (p.text ?? '').trim()
            if (!t) continue
            retryMatch = t.match(/```json\s*([\s\S]*?)\s*```/) ?? t.match(/(\[[\s\S]*\])/)
            if (retryMatch) break
          }
          return retryMatch ? (retryMatch[1] ?? retryMatch[0]) : '[]'
        }
      )
      // Re-parse from the gate's best output
      try {
        parsed = JSON.parse(gateResult.output)
        if (!Array.isArray(parsed)) parsed = []
      } catch {
        // Gate output was invalid — fall back to original parsed
      }

      const now = new Date().toISOString()

      // Build a sequential assignment index for grounding chunk URLs.
      // Entries with "cite: N" or empty sources get the next available grounding URL.
      let groundingIdx = 0

      const entries = parsed.map((t: any) => {
        let source = String(t.source ?? '')

        // If source is a "cite: N" pattern, empty, or still a redirect URL, assign from resolved grounding pool
        if (!source || /^cite:\s*\d+/i.test(source) || source.includes('grounding-api-redirect')) {
          if (groundingIdx < groundingSources.length && groundingSources[groundingIdx]) {
            source = groundingSources[groundingIdx++]
          } else {
            groundingIdx++
            source = ''
          }
        }

        const name = String(t.name ?? '')

        // If still no valid source, generate a search fallback
        if (!source || source.includes('grounding-api-redirect')) {
          source = buildSourceFallback(customerName, name)
        }

        return {
          name,
          category: t.category === 'proprietary' ? 'proprietary' : 'industry-tool',
          context: ['using', 'evaluating', 'migrating_from', 'developing'].includes(t.context) ? t.context : 'using',
          description: String(t.description ?? ''),
          why: t.why ? String(t.why) : undefined,
          infrastructure: Array.isArray(t.infrastructure) ? t.infrastructure.map(String) : [],
          redHatProducts: Array.isArray(t.redHatProducts) ? t.redHatProducts.map(String) : [],
          confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(t.confidence) ? t.confidence : 'LOW',
          source,
          lastResearched: now,
        }
      }) as TechEntry[]

      return entries
    }
  } catch (e: any) {
    console.error(`[tech-stack] Gemini extraction failed for ${customerName}: ${e?.message}`)
  }

  return []
}

async function resolveGroundingRedirects(urls: string[]): Promise<string[]> {
  if (urls.length === 0) return []

  const resolved = await Promise.all(urls.map(async (url) => {
    if (!url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
      return url
    }
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      const location = res.headers.get('location')
      if (location && location.startsWith('http') && !location.includes('grounding-api-redirect')) {
        return location
      }
    } catch { /* timeout — URL expired */ }
    return ''
  }))

  const valid = resolved.filter(Boolean)
  if (valid.length > 0) {
    console.log(`[tech-stack] resolved ${valid.length}/${urls.length} grounding URLs`)
  }
  return resolved
}

function buildSourceFallback(customerName: string, toolName: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`${customerName} ${toolName}`)}`
}

async function enrichProprietaryTech(customerName: string, tech: TechEntry): Promise<TechEntry> {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'

  if (!project) return tech

  const model = getGeminiModel()
  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const userPrompt = `Research "${tech.name}" by ${customerName}. What is it, what does it run on, what infrastructure does it use, how could Red Hat products (OpenShift, RHEL, Ansible Automation Platform, Advanced Cluster Security, Advanced Cluster Management) complement it?

Return a JSON object:
{
  "description": "2-3 sentence description",
  "infrastructure": ["underlying platforms"],
  "redHatProducts": ["ocp", "rhel", "aap"],
  "redHatPositioning": "1-2 sentences on how Red Hat products complement this technology"
}

Return ONLY the JSON object, no markdown.`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })

    if (!res.ok) {
      console.warn(`[tech-stack] Tier 2 enrichment failed for ${tech.name}: ${res.status}`)
      return tech
    }

    const json = await res.json() as any

    const usage = json.usageMetadata
    if (usage) {
      recordGeminiUsage({
        timestamp: new Date().toISOString(),
        callType: 'tech-stack-enrich',
        customerName,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model,
      })
    }

    const parts: any[] = json.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p: any) => p.text ?? '').join('\n').trim()
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/)

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
      return {
        ...tech,
        description: parsed.description ?? tech.description,
        infrastructure: Array.isArray(parsed.infrastructure) ? parsed.infrastructure.map(String) : tech.infrastructure,
        redHatProducts: Array.isArray(parsed.redHatProducts) ? parsed.redHatProducts.map(String) : tech.redHatProducts,
        redHatPositioning: parsed.redHatPositioning ?? undefined,
        lastResearched: new Date().toISOString(),
      }
    }
  } catch (e: any) {
    console.warn(`[tech-stack] Tier 2 enrichment error for ${tech.name}: ${e?.message}`)
  }

  return tech
}

// ── Module registration ────────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'tech-stack',
  displayName: 'Tech Stack',
  refreshEndpoint: '/api/refresh/tech-stack',
  scope: 'customer',
  refreshInterval: 7 * 24 * 60 * 60 * 1000, // weekly

  accountTab: {
    label: 'Tech Stack',
    icon: 'Code',
    order: 15,
  },

  cachePaths: (slug: string) => [`data/cache/tech-stack/${slug}.json`],

  cacheTtlMs: TECH_STACK_TTL_MS,

  async ensureFresh(customerSlug: string): Promise<void> {
    const cachePath = resolve(TECH_CACHE_DIR, `${customerSlug}.json`)

    // Check if cache exists and is fresh by TTL
    try {
      const stat = statSync(cachePath)
      if (Date.now() - stat.mtimeMs < TECH_STACK_TTL_MS) {
        // TTL is fresh — also verify content hash hasn't changed
        const existing = readExistingTechCache(customerSlug)
        if (existing) {
          const intel = readIntelligenceCache(customerSlug)
          const news = readNewsCache(customerSlug)
          const docSignals = readDocSignals(customerSlug)
          const ccspPartners = readCcspCache(customerSlug)
          const currentHash = createHash('sha256')
            .update(intel?.company.slice(0, 1000) ?? '')
            .update(intel?.industry.slice(0, 500) ?? '')
            .update(String(news.articleCount))
            .update(ccspPartners.join(','))
            .update(docSignals.slice(0, 10).join(','))
            .digest('hex')
            .slice(0, 16)
          if (existing.contentHash === currentHash) return // fresh and unchanged
        }
        // TTL fresh but hash changed or no cache — fall through to refresh
      }
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — resolve customer and refresh
    const { customers } = await import('../server-state.ts')
    const customer = customers.find((c: any) => toSlug(c.name) === customerSlug)
    if (!customer) {
      console.warn(`[tech-stack-module] ensureFresh: customer not found for slug ${customerSlug}`)
      return
    }

    await this.syncNow(customer.name)
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const cached = readExistingTechCache(customerSlug)
    if (!cached || !cached.technologies?.length) return []

    // ADR-030: Get solution play context for this customer
    const solutionCtx = getCustomerSolutionContext(customerSlug)
    const playsByTech = new Map<string, typeof solutionCtx.activeSolutionPlays[0]>()
    for (const play of solutionCtx.activeSolutionPlays) {
      for (const tech of play.matchedTechnologies) {
        playsByTech.set(tech.toLowerCase(), play)
      }
    }

    // ADR-027: rawRelevance based on confidence
    return cached.technologies.map((tech): Signal => {
      let rawRelevance = 0.5
      if (tech.confidence === 'HIGH') rawRelevance = 0.8
      else if (tech.confidence === 'MEDIUM') rawRelevance = 0.5
      else rawRelevance = 0.3

      // ADR-030: Enrich with solution play metadata if a matching play exists
      const matchedPlay = playsByTech.get(tech.name.toLowerCase())

      return {
        source: 'tech-stack',
        type: 'technology' as const,
        headline: `${tech.name} (${tech.category}, ${tech.context})`,
        detail: `${tech.description}${tech.redHatPositioning ? ' Red Hat positioning: ' + tech.redHatPositioning : ''}`,
        rawRelevance,
        timestamp: tech.lastResearched,
        url: (tech.source && tech.source !== 'provided-context') ? tech.source : undefined,  // #479: promote metadata.source (URL)
        metadata: {
          customerSlug,
          category: tech.category,
          context: tech.context,
          why: tech.why,
          infrastructure: tech.infrastructure,
          redHatProducts: tech.redHatProducts,
          confidence: tech.confidence,
          source: tech.source,
          ...(matchedPlay ? {
            solutionPlayId: matchedPlay.playId,
            solutionPlayName: matchedPlay.playName,
            solutionTdp: matchedPlay.tdp,
            valueProps: matchedPlay.valueProps,
            solutionCategory: matchedPlay.category,
          } : {}),
        },
      }
    })
  },

  async syncNow(customerName: string): Promise<void> {
    const customerSlug = toSlug(customerName)

    // 1. Gather inputs from all sources
    const intel = readIntelligenceCache(customerSlug)
    const news = readNewsCache(customerSlug)
    const docSignals = readDocSignals(customerSlug)
    const ccspPartners = readCcspCache(customerSlug)

    // 2. Content hash for cache tagging (used in ensureFresh, never short-circuits syncNow)
    const contentHash = createHash('sha256')
      .update(intel?.company.slice(0, 1000) ?? '')
      .update(intel?.industry.slice(0, 500) ?? '')
      .update(String(news.articleCount))
      .update(ccspPartners.join(','))
      .update(docSignals.slice(0, 10).join(','))
      .digest('hex')
      .slice(0, 16)

    // 3. Build context for Gemini extraction
    const contextParts: string[] = []

    if (intel?.company) contextParts.push(`[Company Profile]\n${intel.company.slice(0, 6000)}`)
    if (intel?.industry) contextParts.push(`[Industry Context]\n${intel.industry.slice(0, 2000)}`)
    if (news.techArticles.length) contextParts.push(`[Technology News]\n${news.techArticles.join('\n')}`)
    if (docSignals.length) contextParts.push(`[Document Technical Signals]\n${docSignals.join('\n')}`)
    if (ccspPartners.length) contextParts.push(`[Cloud Partners (CCSP)]\n${ccspPartners.join(', ')}`)

    if (contextParts.length === 0) {
      console.log(`[tech-stack] no source data for ${customerSlug} — skipping`)
      FeatureModuleRegistry.recordOutcome('tech-stack', { success: true, dataChanged: false, recordCount: 0 })
      return
    }

    const context = contextParts.join('\n\n')

    // 4. Extract technologies via Gemini
    console.log(`[tech-stack] extracting technologies for ${customerName}...`)
    let technologies = await extractTechnologies(customerName, context)

    if (technologies.length === 0) {
      console.log(`[tech-stack] no technologies detected for ${customerSlug}`)
      const cache: TechStackCache = { contentHash, technologies: [], cachedAt: new Date().toISOString() }
      writeFileSync(resolve(TECH_CACHE_DIR, `${customerSlug}.json`), JSON.stringify(cache, null, 2), { mode: 0o600 })
      FeatureModuleRegistry.recordOutcome('tech-stack', { success: true, recordCount: 0 })
      return
    }

    // 5. Tier 1 enrichment — static lookup for industry tools
    for (const tech of technologies) {
      if (tech.category === 'industry-tool') {
        const positioning = lookupPositioning(tech.name)
        if (positioning) {
          tech.redHatPositioning = positioning.redHatPositioning
          // Merge Red Hat products from static file if not already present
          const existingSet = new Set(tech.redHatProducts)
          for (const p of positioning.redHatProducts) {
            if (!existingSet.has(p)) tech.redHatProducts.push(p)
          }
        }
      }
    }

    // 6. Tier 2 enrichment — Gemini grounded search for proprietary tech
    const proprietaryTechs = technologies.filter(t => t.category === 'proprietary')
    if (proprietaryTechs.length > 0) {
      console.log(`[tech-stack] enriching ${proprietaryTechs.length} proprietary technologies for ${customerName}...`)
      // Process sequentially to avoid rate limiting; cap at 5 to control costs
      for (const tech of proprietaryTechs.slice(0, 5)) {
        const enriched = await enrichProprietaryTech(customerName, tech)
        // Replace in-place
        const idx = technologies.indexOf(tech)
        if (idx >= 0) technologies[idx] = enriched
        // Small delay between calls
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    // 7. Write cache
    const cache: TechStackCache = {
      contentHash,
      technologies,
      cachedAt: new Date().toISOString(),
    }
    writeFileSync(resolve(TECH_CACHE_DIR, `${customerSlug}.json`), JSON.stringify(cache, null, 2), { mode: 0o600 })
    FeatureModuleRegistry.recordOutcome('tech-stack', { success: true, recordCount: technologies.length })
    console.log(`[tech-stack] cached ${technologies.length} technologies for ${customerSlug}`)
  },

  async fetch(customerName: string): Promise<void> {
    await this.syncNow(customerName)
  },

  async cleanup(customerName: string): Promise<void> {
    const slug = toSlug(customerName)
    const cachePath = resolve(TECH_CACHE_DIR, `${slug}.json`)
    if (existsSync(cachePath)) {
      unlinkSync(cachePath)
    }
  },
})
