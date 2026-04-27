// ── Domain waterfall helpers (extracted from setup-routes.ts for shared use) ──
// BKL-BOOT-05: bootstrap-orchestrator needs these functions but they were
// private to setup-routes.ts. Extracted here so both modules can import them.

import { getGeminiToken } from './gemini-auth.ts'
import { getGeminiModel } from './settings-api.ts'

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

/** Tier 1: Clearbit autocomplete (free, no key) */
export async function tier1Clearbit(companyName: string): Promise<string | null> {
  const stripped = stripLegalSuffixes(companyName)
  try {
    const res = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(stripped)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
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
  if (!project) return null  // Vertex AI not configured — skip silently

  try {
    const token = await getGeminiToken()
    const model = getGeminiModel()

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
    const systemPrompt = 'You are a company domain lookup tool. Reply with ONLY the primary domain (e.g. rei.com), nothing else. If genuinely unknown, reply unknown. Companies may be known by brand names, acronyms, or DBAs different from their legal name — use the most recognizable one.'
    const userPrompt = `What is the primary official website domain for this company: '${companyName}'? Note: this may be a legal entity name — use the brand/DBA name if better known (e.g. "Recreational Equipment Inc" → rei.com, "International Business Machines" → ibm.com). Reply with ONLY the domain, nothing else. If genuinely unknown, reply 'unknown'.`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
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
  } catch {
    return null
  }
}

/** Tier 3: Domain validation — HEAD request with timeout */
export async function tier3Validate(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000),
      redirect: 'follow',
    })
    return res.ok || res.status === 301 || res.status === 302 || res.status === 403
  } catch {
    return false
  }
}

/** Run the full waterfall for a single company name. Returns domain + metadata. */
export async function waterfallInferDomain(companyName: string): Promise<WaterfallResult> {
  // Tier 1: Clearbit
  const t1 = await tier1Clearbit(companyName)
  if (t1) {
    console.log(`[infer-domains] ${companyName} → tier1: ${t1}`)
    const verified = await tier3Validate(t1)
    return { domain: t1, tier: 'clearbit', verified }
  }

  // Tier 2: LLM fallback
  console.log(`[infer-domains] ${companyName} → tier1 miss, trying tier2`)
  const t2 = await tier2LLM(companyName)
  if (t2) {
    console.log(`[infer-domains] ${companyName} → tier2: ${t2}`)
    const verified = await tier3Validate(t2)
    return { domain: t2, tier: 'llm', verified }
  }

  console.log(`[infer-domains] ${companyName} → tier1+tier2 miss, no domain`)
  return { domain: null, tier: null, verified: null }
}
