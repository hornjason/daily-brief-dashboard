// ── Domain waterfall helpers (extracted from setup-routes.ts for shared use) ──
// BKL-BOOT-05: bootstrap-orchestrator needs these functions but they were
// private to setup-routes.ts. Extracted here so both modules can import them.

import { getGeminiToken } from './gemini-auth.ts'
import { getGeminiModel, getGeminiModelLite } from './ai-config.ts'

/** Legal suffixes to strip from company names before Clearbit lookup */
export const LEGAL_SUFFIXES = /,?\s*\b(Inc\.?|LLC\.?|L\.?L\.?C\.?|Corp\.?|Corporation|Ltd\.?|Limited|L\.?P\.?|Co(?:-?op)?\.?|Group|Holdings|Incorporated)\s*$/i

/** Strip legal entity suffixes and normalize whitespace */
export function stripLegalSuffixes(name: string): string {
  return name.replace(LEGAL_SUFFIXES, '').replace(/\s+/g, ' ').trim()
}

/** Tightened similarity check: the first substantive token (≥3 chars) of the
 * query must appear in the result tokens (or vice versa). The previous
 * "any overlap" predicate let unrelated suffix words like "Inc" or "Group"
 * carry the match — e.g. "Uber Technologies" passing against "Ub3r" via
 * a stray shared token. Anchoring on the first token prevents that. */
export function nameMatchesClearbit(query: string, resultName: string): boolean {
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3)
  const rWords = resultName.toLowerCase().split(/\s+/).filter(w => w.length >= 3)
  if (qWords.length === 0 || rWords.length === 0) return false
  // First substantive token of query must appear in result tokens (or vice versa).
  return rWords.includes(qWords[0]) || qWords.includes(rWords[0])
}

export interface WaterfallResult {
  domain: string | null
  tier: 'clearbit' | 'llm' | null
  verified: boolean | null  // null = not checked, true = reachable, false = unreachable
}

/** Tier 1: Clearbit autocomplete (free, no key)
 *
 * BKL-DOM-INF-02: Optional `signal` chains a caller-owned AbortController to the
 * per-call 5s timeout via `AbortSignal.any`, so when the bootstrap inference
 * waterfall's 60s race fires the in-flight fetch is cancelled instead of
 * orphaned. Bun supports `AbortSignal.any` since 1.0.
 */
export async function tier1Clearbit(companyName: string, signal?: AbortSignal): Promise<string | null> {
  const stripped = stripLegalSuffixes(companyName)
  try {
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000)
    const res = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(stripped)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: combinedSignal }
    )
    if (!res.ok) return null
    const hits: { name: string; domain: string }[] = await res.json()
    if (hits.length === 0) return null
    const first = hits[0]
    if (!first.domain) return null
    if (!nameMatchesClearbit(stripped, first.name)) return null
    return first.domain.toLowerCase()
  } catch {
    return null
  }
}

/** Tier 2: Gemini via Vertex AI (container-safe — no subprocess) */
export async function tier2LLM(companyName: string): Promise<string | null> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  if (!project) { console.warn('[infer-domains] GOOGLE_CLOUD_PROJECT unset — Gemini disabled, falling through to Clearbit'); return null }

  try {
    const token = await getGeminiToken()
    const model = getGeminiModelLite()

    const safeName = companyName.replace(/['"\\]/g, '')
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
    const systemPrompt = 'You are a company domain lookup tool. Reply with ONLY the primary domain (e.g. rei.com), nothing else. If genuinely unknown, reply unknown. Companies may be known by brand names, acronyms, or DBAs different from their legal name — use the most recognizable one.'
    const userPrompt = `What is the primary official website domain for this company: '${safeName}'? Note: this may be a legal entity name — use the brand/DBA name if better known (e.g. "Recreational Equipment Inc" → rei.com, "International Business Machines" → ibm.com). Reply with ONLY the domain, nothing else. If genuinely unknown, reply 'unknown'.`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } },
      }),
    })
    if (!res.ok) return null
    const json = await res.json() as any
    let domain = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').replace(/['"]/g, '')
    if (domain === 'unknown' || domain === '' || !domain.includes('.')) return null
    domain = domain.split('/')[0]
    if (!/^[a-z0-9]([a-z0-9\-._]{0,251}[a-z0-9])?$/.test(domain)) return null
    return domain
  } catch (e: any) { console.warn(`[infer-domains] tier2LLM error for "${companyName}":`, e?.message ?? e); return null }
}

/** Tier 2 with variant retries: tries the full name, then the legal-stripped
 * name, then iteratively drops the LAST word from the stripped name. Useful
 * for names like "Intrado Life Safety" where the full division name stumps
 * the LLM but the root brand ("Intrado") resolves cleanly.
 *
 * Constraints: ≤ 4 total attempts, minimum 2 words per variant, minimum 2
 * characters per variant. Returns the first non-null result. */
export async function tier2WithVariants(companyName: string): Promise<string | null> {
  const attempted = new Set<string>()
  const variants: string[] = []

  // Variant 1: full original name
  variants.push(companyName)

  // Variant 2: legal-suffix-stripped name (only if different)
  const stripped = stripLegalSuffixes(companyName)
  if (stripped !== companyName && stripped.length >= 2) {
    variants.push(stripped)
  }

  // Variants 3+: iteratively drop the LAST word from the stripped name,
  // keeping minimum 2 words per variant.
  const words = stripped.split(/\s+/).filter(Boolean)
  for (let n = words.length - 1; n >= 2 && variants.length < 4; n--) {
    const candidate = words.slice(0, n).join(' ')
    if (candidate.length >= 2) variants.push(candidate)
  }

  for (const variant of variants) {
    if (attempted.has(variant)) continue
    attempted.add(variant)
    if (variants.length > 1) {
      console.log(`[infer-domains] ${companyName} → variant: "${variant}" ...`)
    }
    const hit = await tier2LLM(variant)
    if (hit) {
      if (variant !== companyName) console.log(`[infer-domains] ${companyName} → variant "${variant}" resolved: ${hit}`)
      return hit
    }
  }
  return null
}

/** Tier 3: Domain validation — HEAD request with timeout */
export async function tier3Validate(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    })
    return res.ok || res.status === 301 || res.status === 302 || res.status === 403
  } catch {
    return false
  }
}

/** Run the full waterfall for a single company name. Returns domain + metadata. */
export async function waterfallInferDomain(companyName: string): Promise<WaterfallResult> {
  // Tier 1: Gemini (LLM) — primary, with variant retries
  const t2 = await tier2WithVariants(companyName)
  if (t2) {
    console.log(`[infer-domains] ${companyName} → gemini: ${t2}`)
    const verified = await tier3Validate(t2)
    return { domain: t2, tier: 'llm', verified }
  }

  // Tier 2: Clearbit fallback
  console.log(`[infer-domains] ${companyName} → gemini miss, trying clearbit`)
  const t1 = await tier1Clearbit(companyName)
  if (t1) {
    console.log(`[infer-domains] ${companyName} → clearbit: ${t1}`)
    const verified = await tier3Validate(t1)
    return { domain: t1, tier: 'clearbit', verified }
  }

  console.log(`[infer-domains] ${companyName} → gemini+clearbit miss, no domain`)
  return { domain: null, tier: null, verified: null }
}

// ── BKL-DOM-BATCH-01 ─────────────────────────────────────────────────────────
/**
 * Reject internal/private/loopback hosts and malformed domains. Used by the
 * batch inference path before persisting any LLM-returned domain to
 * customers.json. Exported so callers in bootstrap-orchestrator.ts can apply
 * the same gate the validator uses.
 */
export function isPublicDomain(d: string): boolean {
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(d)) return false
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(d)) return false
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(d)) return false
  return true
}

/**
 * Batch domain inference via Gemini Flash-Lite. Replaces the per-company
 * waterfall loop for the bootstrap auto-inference path: one round-trip per 20
 * names instead of one per name. Returns a Map keyed by the input company
 * name (exact string) → resolved domain or null. Every input name appears in
 * the returned Map. On parse failure or API error for a chunk, every name in
 * that chunk maps to null.
 */
export async function batchInferDomains(names: string[], signal?: AbortSignal): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  if (names.length === 0) return result

  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  if (!project) {
    console.warn('[infer-domains] GOOGLE_CLOUD_PROJECT unset — batch inference disabled')
    for (const n of names) result.set(n, null)
    return result
  }

  const model = getGeminiModelLite()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  for (let i = 0; i < names.length; i += 20) {
    const chunk = names.slice(i, i + 20)
    // Default every name in this chunk to null; overwrite on success.
    for (const n of chunk) result.set(n, null)

    let token: string
    try {
      token = await getGeminiToken()
    } catch (e: any) {
      console.warn('[infer-domains] batch token fetch failed:', e?.message ?? e)
      continue
    }

    const prompt = `For each company name below, return its primary official website domain.
Rules:
- Use the brand/DBA domain, not legal entity name (e.g. "Recreational Equipment" → "rei.com", "Taylor Fresh Foods" → "taylorfarms.com")
- Return ONLY a valid JSON object mapping each company name exactly as given to its domain string
- If genuinely unknown or a shell entity with no website, use null
- No explanations, no markdown, no code fences — raw JSON only

Companies:
${JSON.stringify(chunk, null, 2)}`

    try {
      // BKL-DOM-INF-02: chain caller-owned signal with the per-call 30s timeout
      // so the bootstrap waterfall can abort in-flight Gemini calls when its
      // outer 60s race fires.
      const combinedSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: combinedSignal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
        }),
      })
      if (!res.ok) {
        console.warn(`[infer-domains] batch HTTP ${res.status} for chunk of ${chunk.length}`)
        continue
      }
      const json = await res.json() as any
      const raw = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
      const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
      let parsed: unknown
      try {
        parsed = JSON.parse(stripped)
      } catch (e: any) {
        console.warn(`[infer-domains] batch JSON parse failed: ${e?.message ?? e}`)
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[infer-domains] batch response not a JSON object — discarding chunk')
        continue
      }
      const obj = parsed as Record<string, unknown>
      for (const name of chunk) {
        const v = obj[name]
        if (typeof v === 'string') {
          const cleaned = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').split('/')[0]
          result.set(name, cleaned.length > 0 ? cleaned : null)
        } else {
          result.set(name, null)
        }
      }
    } catch (e: any) {
      console.warn(`[infer-domains] batch call failed: ${e?.message ?? e}`)
      // chunk already defaulted to null above — keep going
    }
  }

  return result
}
