/**
 * Product Feature Radar — Wave 4 Phase 2c
 *
 * Extracts structured feature data from Drive slide decks and release notes
 * via Gemini, caches per-product feature lists, and optionally enriches
 * high-priority features by fetching their documentation URLs.
 *
 * Cache path: data/cache/product-intel/{slug}-features.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { getGeminiToken } from './gemini-auth.ts'
import { getAiConfig, getGeminiModel } from './settings-api.ts'
import { getCachedDriveCorpus } from './product-drive-ingest.ts'
import { getCachedSummary, loadProductConfig } from './product-release-radar.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProductFeature {
  id: string                       // `${productSlug}-${featureSlug}`
  featureSlug: string              // kebab-case from name
  name: string
  status: 'GA' | 'Tech Preview' | 'Roadmap' | 'Deprecated'
  versionIntroduced: string | null
  versionCurrent: string | null
  description: string              // 2-4 sentences from extraction
  enrichedDescription: string | null  // deeper context from URL enrichment
  sourceUrls: string[]             // URLs mentioned in slides near this feature
  enrichmentUrls: string[]         // URLs actually fetched for enrichment
  tags: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  slideSource: string              // which slide file this came from
  releaseNotesSection: string | null  // doc name from release notes (e.g. 'virtualization', 'release_notes'), null if from slides
}

export interface ProductFeatureCache {
  slug: string
  displayName: string
  features: ProductFeature[]
  corpusHash: string               // combined Drive corpus + summary hash — drives cache invalidation
  summaryHash: string              // ProductSummary contentHash
  extractedAt: string
  enrichedAt: string | null
  geminiModel: string
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR  = process.env.DATA_DIR  ?? resolve(import.meta.dir, '../data')
const CACHE_DIR = resolve(process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache'), 'product-intel')

function featureCachePath(slug: string): string {
  return resolve(CACHE_DIR, `${slug}-features.json`)
}

// ── Status sort order ─────────────────────────────────────────────────────────

const STATUS_ORDER: Record<string, number> = {
  'GA': 0,
  'Tech Preview': 1,
  'Roadmap': 2,
  'Deprecated': 3,
}

// ── Cache read ────────────────────────────────────────────────────────────────

const _featureCacheMap = new Map<string, ProductFeatureCache | null>()

export function getFeatureCache(slug: string): ProductFeatureCache | null {
  if (_featureCacheMap.has(slug)) return _featureCacheMap.get(slug)!
  const p = featureCachePath(slug)
  let result: ProductFeatureCache | null = null
  try {
    if (existsSync(p)) {
      result = JSON.parse(readFileSync(p, 'utf-8')) as ProductFeatureCache
    }
  } catch (e: any) {
    console.warn(`[feature-radar] cache read failed for ${slug}:`, e?.message)
  }
  _featureCacheMap.set(slug, result)
  return result
}

export function clearFeatureCacheMap(): void {
  _featureCacheMap.clear()
}

// ── Feature slug generation ───────────────────────────────────────────────────

function toFeatureSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

// ── HTML → plain text ─────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    // Preserve anchor hrefs inline so Gemini can extract them as sourceUrls
    .replace(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = text.replace(/<[^>]+>/g, ' ').trim()
      return cleanText ? `${cleanText} [${href}]` : href
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Release notes fetcher ─────────────────────────────────────────────────────

// Extract a named section from plain text — skips TOC mentions, finds actual content
function extractSection(text: string, headingPattern: RegExp, maxChars = 3000): string {
  const headingRx = new RegExp(headingPattern.source, 'gi')
  const CONTENT_KEYWORDS = /the following|you can|available|this feature|is now|adds |provides |enables |allows |introduces |support for/i

  let lastContentMatch: RegExpExecArray | null = null
  let m: RegExpExecArray | null

  // Find all occurrences — prefer the one with actual feature content immediately after
  while ((m = headingRx.exec(text)) !== null) {
    const peek = text.slice(m.index + m[0].length, m.index + m[0].length + 300)
    if (CONTENT_KEYWORDS.test(peek)) {
      lastContentMatch = m  // take the FIRST good content match
      break
    }
    lastContentMatch = m  // fallback: last occurrence
  }

  if (!lastContentMatch) return ''
  const after = text.slice(lastContentMatch.index + lastContentMatch[0].length)
  return after.slice(0, maxChars).trim()
}

async function fetchLatestReleaseNotesContent(
  docsBaseUrl: string,
  productSlug: string,
  allowedDocNames?: string[],  // when set, skip auto-discovery and fetch only these doc names
): Promise<string> {
  const TOTAL_CAP    = 18000
  const SECTION_CAP  = 6000

  try {
    // 1. Fetch the landing page — follows redirect to latest version automatically
    const landingRes = await fetch(docsBaseUrl, { redirect: 'follow', signal: AbortSignal.timeout(12000) })
    if (!landingRes.ok) {
      console.warn(`[feature-radar] ${productSlug}: docs landing ${landingRes.status} — ${docsBaseUrl}`)
      return ''
    }
    const landingHtml = await landingRes.text()

    // 2. Determine which release notes docs to fetch
    let rnDocsSorted: string[]

    if (allowedDocNames && allowedDocNames.length > 0) {
      // Config-specified doc names — skip auto-discovery entirely
      rnDocsSorted = allowedDocNames
      console.log(`[feature-radar] ${productSlug}: using config-specified docs: ${rnDocsSorted.join(', ')}`)
    } else {
      // Auto-discover release_notes doc roots from landing page
      const rnDocNames = new Set<string>()
      const hrefRx     = /href="([^"]*release[_-]notes[^"]*)"/gi
      let m: RegExpExecArray | null
      while ((m = hrefRx.exec(landingHtml)) !== null) {
        const href = m[1]
        if (!href.includes('/html/')) continue
        const docNameM = href.match(/\/html\/([^/?#]+)/)
        if (docNameM) rnDocNames.add(docNameM[1])
      }
      // Sort descending (latest first), keep top 2
      rnDocsSorted = Array.from(rnDocNames).sort().reverse().slice(0, 2)
      console.log(`[feature-radar] ${productSlug}: auto-discovered docs: ${rnDocsSorted.join(', ')}`)
      if (rnDocsSorted.length === 0) return ''
    }

    // 3. Build html-single URLs — docs.redhat.com html-single delivers full pre-rendered HTML
    //    Find the versioned base from the final redirect URL
    const versionedBase = landingRes.url.replace(/\/$/, '')  // e.g. .../red_hat_enterprise_linux/10
    const sections: string[] = []
    let totalChars = 0

    for (const docName of rnDocsSorted) {
      if (totalChars >= TOTAL_CAP) break

      const singleUrl = `${versionedBase}/html-single/${docName}/`
      await new Promise(r => setTimeout(r, 300))

      const res = await fetch(singleUrl, { redirect: 'follow', signal: AbortSignal.timeout(20000) })
      if (!res.ok) {
        console.warn(`[feature-radar] ${productSlug}: ${singleUrl} → ${res.status}`)
        continue
      }

      const fullText = htmlToText(await res.text())
      const rnLabel  = docName.replace(/_/g, ' ')

      // Extract new features and technology preview sections
      const newFeatures = extractSection(
        fullText,
        /new features and enhancements/i,
        SECTION_CAP,
      )
      const techPreview = extractSection(
        fullText,
        /technology preview features?/i,
        SECTION_CAP,
      )

      let sectionText = `\n=== ${rnLabel} ===\n`
      if (newFeatures) sectionText += `\n--- New Features and Enhancements ---\n${newFeatures}\n`
      if (techPreview) sectionText += `\n--- Technology Preview Features (available for testing, NOT for production) ---\n${techPreview}\n`
      if (!newFeatures && !techPreview) {
        // Fallback: use first SECTION_CAP chars of the full doc
        sectionText += fullText.slice(0, SECTION_CAP)
      }

      console.log(`[feature-radar] ${productSlug}/${docName}: new-features=${newFeatures.length}c tech-preview=${techPreview.length}c`)
      sections.push(sectionText)
      totalChars += sectionText.length
    }

    return sections.join('\n').slice(0, TOTAL_CAP)
  } catch (e: any) {
    console.warn(`[feature-radar] ${productSlug}: release notes fetch failed — ${e?.message}`)
    return ''
  }
}

// ── Extraction ────────────────────────────────────────────────────────────────

const CONFIG_DIR  = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const CONFIG_PATH = resolve(CONFIG_DIR, 'product-intel-config.json')

export async function extractProductFeatures(slug: string): Promise<ProductFeatureCache | null> {
  // 1. Read Drive corpus (optional — products without a Drive folder use release notes only)
  const corpus = getCachedDriveCorpus(slug)
  if (!corpus) {
    console.log(`[feature-radar] ${slug}: no Drive corpus — proceeding with release notes only`)
  }

  // 2. Read ProductSummary (cached)
  const summary = getCachedSummary(slug)

  // 3. Compute combined hash for cache invalidation
  //    Drive-less products use summary hash only
  const combinedHash = createHash('sha256')
    .update((corpus?.corpusHash ?? 'no-corpus') + (summary?.contentHash ?? ''))
    .digest('hex')

  // 4. Check cache — return if hash matches
  const cached = getFeatureCache(slug)
  if (cached && cached.corpusHash === combinedHash) {
    console.log(`[feature-radar] cache hit for ${slug} (hash ${combinedHash.slice(0, 12)})`)
    return cached
  }

  // 5. Fetch live release notes from docs.redhat.com (auto-follows redirect to latest version)
  let releaseNotesContent = ''
  let productCfg: any = null
  try {
    const config  = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    productCfg    = (config.products as any[]).find(p => p.slug === slug) ?? null
    const docsBaseUrl      = productCfg?.seeds?.docsBaseUrl ?? null
    const allowedDocNames: string[] | undefined = productCfg?.seeds?.releaseNotesDocNames ?? undefined
    if (docsBaseUrl) {
      console.log(`[feature-radar] ${slug}: fetching live release notes from ${docsBaseUrl}`)
      releaseNotesContent = await fetchLatestReleaseNotesContent(docsBaseUrl, slug, allowedDocNames)
      console.log(`[feature-radar] ${slug}: release notes fetched — ${releaseNotesContent.length} chars`)
    }
  } catch (e: any) {
    console.warn(`[feature-radar] ${slug}: release notes config read failed — ${e?.message}`)
  }

  // 6. Build Gemini prompt
  const displayName = productCfg?.displayName ?? summary?.displayName ?? slug
  const shortName   = productCfg?.shortName   ?? summary?.shortName   ?? slug

  const slideText = corpus
    ? corpus.files.map(f => `--- ${f.name} ---\n${f.textContent}`).join('\n\n').slice(0, 12000)
    : ''

  const releaseNotesSection = releaseNotesContent.length > 0
    ? releaseNotesContent
    : summary
      ? [
          ...(summary.summaryBullets ?? []).map(b => `- ${b}`),
          summary.summaryText ?? '',
        ].join('\n').slice(0, 3000)
      : 'No release notes available'

  const systemPrompt = `You are a Red Hat product analyst extracting structured feature data from internal slide decks and official release notes for ${displayName} (${shortName}).

CRITICAL SCOPE RULE: Only extract features that are SPECIFIC to ${displayName}. Do NOT extract other Red Hat products listed as portfolio or ecosystem items (e.g., if a file lists "Red Hat Satellite", "Red Hat Quay", "Red Hat AAP" as separate products, skip those — they are not ${shortName} features). Files named "Business Value Map" or "Business Value Maps" are portfolio overview files — use them only as background context, NEVER as a source for feature extraction.

Status determination (use ONLY these values):
- "GA" = generally available, shipped, in a released version number
- "Tech Preview" = technology preview, tech preview, developer preview, beta, experimental — available for testing but NOT recommended for production
- "Roadmap" = planned, upcoming, future, coming in next release
- "Deprecated" = deprecated, removed, end-of-life

Features listed in "Technology Preview Features" or "Tech Preview" sections of release notes MUST be classified as "Tech Preview" status. Features listed in "Deprecated features" sections MUST be classified as "Deprecated".

For OpenShift (OCP): extract OCP-specific capabilities — Virtualization, AI/ML features, networking, storage, CI/CD, developer tools, security, multi-cluster management. For OpenShift Virtualization specifically, extract it as a detailed feature with sub-capabilities including VM lifecycle management, live migration, Migration Toolkit for Virtualization (MTV), network attachment, and storage integration.

Output a valid JSON array (maximum ${getAiConfig().featureExtractionMaxFeatures} features — prioritize the most impactful and ${shortName}-specific ones). For description, write 2-4 sentences that help a Solutions Architect have an informed customer conversation. Include URLs mentioned near each feature in sourceUrls. IMPORTANT: Ensure JSON is complete and valid — never truncate mid-object.
For each feature, set "releaseNotesSection" to the release notes section label that immediately precedes it in the release notes content (e.g. "virtualization", "release_notes", "10.1_release_notes"). If the feature comes from the slide deck content, set "releaseNotesSection" to null.`

  const userPrompt = `Product: ${displayName} (${shortName})

${slideText ? `--- Slide Deck Content (primary source, ${corpus!.files.length} files) ---\n${slideText}\n` : '--- No slide deck content available for this product ---'}

--- Live Release Notes from docs.redhat.com (primary source for release-notes-only products) ---
${releaseNotesSection}

Extract ALL features including those listed in Technology Preview sections. Output JSON array only (no markdown):
[{
  "name": "string",
  "status": "GA|Tech Preview|Roadmap|Deprecated",
  "versionIntroduced": "string or null",
  "versionCurrent": "string or null",
  "description": "2-4 sentences for SA conversation depth",
  "sourceUrls": ["urls from slides near this feature"],
  "tags": ["relevant topic tags"],
  "confidence": "HIGH|MEDIUM|LOW",
  "slideSource": "filename this came from",
  "releaseNotesSection": "section label string or null"
}]`

  // 6. Call Gemini
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModel()

  if (!project) {
    console.warn('[feature-radar] GOOGLE_CLOUD_PROJECT not set — skipping Gemini extraction')
    return null
  }

  try {
    const token = await getGeminiToken()
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 10240,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[feature-radar] Gemini error ${res.status} for ${slug}: ${err.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200)}`)
      return null
    }

    const json = await res.json() as any

    // Record token usage
    const usage = json.usageMetadata
    if (usage) {
      recordGeminiUsage({
        timestamp:    new Date().toISOString(),
        callType:     'product-feature-extraction',
        customerName: slug,
        inputTokens:  usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model,
      })
    }

    // Parse response — scan all parts (Gemini 2.5 Flash may include thinking parts)
    const parts: any[] = json.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p: any) => p.text ?? '').join('\n').trim()

    // Strip markdown fences if present
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\[[\s\S]*\])/)
    if (!jsonMatch) {
      console.warn(`[feature-radar] Gemini response contained no JSON array for ${slug}`)
      return null
    }

    const rawFeatures: any[] = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
    if (!Array.isArray(rawFeatures)) {
      console.warn(`[feature-radar] Gemini response was not an array for ${slug}`)
      return null
    }

    // 7. Post-process: generate slugs, deduplicate, sort, cap
    const seen = new Map<string, ProductFeature>()
    const confidenceOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }

    for (const raw of rawFeatures) {
      const name = String(raw.name ?? '').trim()
      if (!name) continue

      const featureSlug = toFeatureSlug(name)
      const id = `${slug}-${featureSlug}`

      const status = (['GA', 'Tech Preview', 'Roadmap', 'Deprecated'].includes(raw.status))
        ? raw.status as ProductFeature['status']
        : 'GA'

      const confidence = (['HIGH', 'MEDIUM', 'LOW'].includes(raw.confidence))
        ? raw.confidence as ProductFeature['confidence']
        : 'MEDIUM'

      const feature: ProductFeature = {
        id,
        featureSlug,
        name,
        status,
        versionIntroduced: raw.versionIntroduced ?? null,
        versionCurrent: raw.versionCurrent ?? null,
        description: String(raw.description ?? '').slice(0, 1000),
        enrichedDescription: null,
        sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls.filter((u: any) => typeof u === 'string') : [],
        enrichmentUrls: [],
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t: any) => typeof t === 'string') : [],
        confidence,
        slideSource: String(raw.slideSource ?? ''),
        releaseNotesSection: (typeof raw.releaseNotesSection === 'string' && raw.releaseNotesSection.length > 0)
          ? raw.releaseNotesSection
          : null,
      }

      // Deduplicate by featureSlug — keep higher confidence entry
      const existing = seen.get(featureSlug)
      if (!existing || (confidenceOrder[feature.confidence] ?? 2) < (confidenceOrder[existing.confidence] ?? 2)) {
        seen.set(featureSlug, feature)
      }
    }

    // Sort: GA first, then Tech Preview, then Roadmap, then Deprecated
    const features = Array.from(seen.values())
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
      .slice(0, 50)

    // 8. Write cache
    const cache: ProductFeatureCache = {
      slug,
      displayName,
      features,
      corpusHash: combinedHash,
      summaryHash: summary?.contentHash ?? '',
      extractedAt: new Date().toISOString(),
      enrichedAt: null,
      geminiModel: model,
    }

    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(featureCachePath(slug), JSON.stringify(cache, null, 2), { mode: 0o600 })
    chmodSync(featureCachePath(slug), 0o600)
    _featureCacheMap.set(slug, cache)
    console.log(`[feature-radar] ${slug}: ${features.length} features extracted`)
    return cache
  } catch (e: any) {
    console.error(`[feature-radar] extraction failed for ${slug}:`, e?.message)
    return null
  }
}

// ── Enrichment ────────────────────────────────────────────────────────────────

const ALLOWED_DOMAINS = ['.redhat.com', '.openshift.com', 'github.com/openshift']

export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    // Hostname-based check for *.redhat.com and *.openshift.com
    if (['.redhat.com', '.openshift.com'].some(d => parsed.hostname.endsWith(d))) return true
    // Exact hostname + path prefix check for github.com/openshift
    if (parsed.hostname === 'github.com' && parsed.pathname.startsWith('/openshift')) return true
    return false
  } catch {
    return false
  }
}

const PRIORITY_TAGS = ['virtualization', 'migration', 'vmware', 'ai', 'lightspeed']

export async function enrichFeatures(slug: string): Promise<void> {
  const rawCache = getFeatureCache(slug)
  if (!rawCache || rawCache.features.length === 0) return
  // BKL-MC04: clone cache before mutation to avoid aliasing bugs on concurrent reads
  const cache = { ...rawCache, features: rawCache.features.map(f => ({ ...f, sourceUrls: [...f.sourceUrls] })) }

  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModel()
  if (!project) {
    console.warn('[feature-radar] GOOGLE_CLOUD_PROJECT not set — skipping enrichment')
    return
  }

  // Select features to enrich (max 10, priority order)
  const candidates: ProductFeature[] = []

  // 1. OCP Virtualization — always first
  const ocpVirt = cache.features.find(f =>
    f.name.toLowerCase().includes('virtualization') && slug === 'ocp'
  )
  if (ocpVirt) {
    // Ensure the OCP Virt docs URL is in sourceUrls
    const ocpVirtDocsUrl = 'https://docs.openshift.com/container-platform/4.17/virt/about_virt/about-virt.html'
    if (!ocpVirt.sourceUrls.includes(ocpVirtDocsUrl)) {
      ocpVirt.sourceUrls.push(ocpVirtDocsUrl)
    }
    candidates.push(ocpVirt)
  }

  // 2. Features with sourceUrls
  for (const f of cache.features) {
    if (candidates.length >= 10) break
    if (candidates.includes(f)) continue
    if (f.sourceUrls.length > 0) candidates.push(f)
  }

  // 3. Features with short descriptions
  for (const f of cache.features) {
    if (candidates.length >= 10) break
    if (candidates.includes(f)) continue
    if (f.description.length < 100) candidates.push(f)
  }

  // 4. Features with priority tags
  for (const f of cache.features) {
    if (candidates.length >= 10) break
    if (candidates.includes(f)) continue
    if (f.tags.some(t => PRIORITY_TAGS.includes(t.toLowerCase()))) candidates.push(f)
  }

  if (candidates.length === 0) {
    console.log(`[feature-radar] ${slug}: no enrichment candidates`)
    return
  }

  let enrichedCount = 0

  for (const feature of candidates) {
    // Fetch up to 3 allowed URLs
    const allowedUrls = feature.sourceUrls.filter(isAllowedUrl).slice(0, 3)
    if (allowedUrls.length === 0) continue

    let fetchedContent = ''
    const enrichmentUrls: string[] = []

    for (const url of allowedUrls) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'PAI-DailyBrief/1.0' },
          signal: AbortSignal.timeout(10000),
        })
        if (!resp.ok) continue
        const html = await resp.text()
        // Strip HTML tags, take first 2000 chars
        const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
        if (text.length > 100) {
          fetchedContent += `\n\n[${url}]\n${text}`
          enrichmentUrls.push(url)
        }
      } catch (e: any) {
        console.warn(`[feature-radar] fetch failed for ${url}:`, e?.message)
      }
    }

    if (fetchedContent.length <= 100) continue

    // Call Gemini for enrichment synthesis
    try {
      const token = await getGeminiToken()
      const apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Write an enriched description (4-6 sentences) helping a Solutions Architect discuss this feature with a customer. Include technical specifics: supported configurations, use cases, competitive advantages.' }] },
          contents: [{ role: 'user', parts: [{ text: `Feature: ${feature.name} (${feature.status})\nCurrent: ${feature.description}\nAdditional docs:\n${fetchedContent}` }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      })

      if (res.ok) {
        const json = await res.json() as any
        const usage = json.usageMetadata
        if (usage) {
          recordGeminiUsage({
            timestamp:    new Date().toISOString(),
            callType:     'product-feature-enrichment',
            customerName: slug,
            inputTokens:  usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
            model,
          })
        }

        const parts: any[] = json.candidates?.[0]?.content?.parts ?? []
        const text = parts.map((p: any) => p.text ?? '').join('\n').trim()
        if (text.length > 20) {
          feature.enrichedDescription = text
          feature.enrichmentUrls = enrichmentUrls
          enrichedCount++
        }
      }
    } catch (e: any) {
      console.warn(`[feature-radar] enrichment Gemini call failed for ${feature.name}:`, e?.message)
    }

    // Wait 500ms between enrichment calls to avoid rate limiting
    await new Promise(r => setTimeout(r, 500))
  }

  // Update cache with enrichedAt timestamp
  cache.enrichedAt = new Date().toISOString()
  writeFileSync(featureCachePath(slug), JSON.stringify(cache, null, 2), { mode: 0o600 })
  chmodSync(featureCachePath(slug), 0o600)
  _featureCacheMap.set(slug, cache)
  console.log(`[feature-radar] ${slug}: ${enrichedCount} features enriched`)
}

// ── Refresh all ───────────────────────────────────────────────────────────────

export async function refreshAllFeatures(): Promise<void> {
  const products = loadProductConfig()
  for (const product of products) {
    try {
      const cache = await extractProductFeatures(product.slug)
      if (cache) {
        await enrichFeatures(product.slug)
        console.log(`[feature-radar] ${product.slug}: ${cache.features.length} features extracted`)
      }
    } catch (e: any) {
      console.error(`[feature-radar] refresh failed for ${product.slug}:`, e?.message)
    }
  }
}
