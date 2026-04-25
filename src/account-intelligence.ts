/**
 * Account Intelligence — BKL-AI01 through BKL-AI04
 *
 * AI-powered company and industry intelligence generation chain:
 *   1. identifyIndustry()        — Gemini + Google Search grounding for industry/segment
 *   2. generateCompanyIntelligence() — deep-dive company brief with grounding
 *   3. generateIndustryAnalysis()    — industry technology landscape with grounding
 *   4. writeIntelligenceDocs()       — create/update Google Docs in Drive
 *
 * Follows the same Gemini auth pattern as src/customer.ts (Vertex AI endpoint,
 * service account key or OAuth fallback).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { getGeminiToken } from './gemini-auth.ts'
import { makeAuth } from './google.ts'
import { sanitizePromptInput } from './utils.ts'
import { getGeminiModel } from './settings-api.ts'
import { aes, customers, CUSTOMERS_PATH } from './server-state.ts'
import { readSheetCache } from './cache-layer.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { fetchGeminiWithRetry, type GeminiFetchContext } from './gemini-fetch.ts'
import type { Customer } from './types.ts'

// ── Config paths ──────────────────────────────────────────────────────────────

const CONFIG_DIR_PATH  = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')

// ── BKL-AI-03: Intelligence cache TTL ────────────────────────────────────────
const INTELLIGENCE_CACHE_TTL_DAYS = Number(process.env.INTELLIGENCE_CACHE_TTL_DAYS) || 7
const INTELLIGENCE_CACHE_TTL_MS   = INTELLIGENCE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000

function readIntelligenceCache(customerName: string): { company: string; industry: string; industryClassification?: string; cachedAt: string; skipped?: boolean; companyDocUrl?: string; industryDocUrl?: string } | null {
  if (!JOB_CACHE_PATH) return null
  try {
    const slug = customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    const p = JOB_CACHE_PATH.replace('/intelligence-jobs.json', `/intelligence/${slug}.json`)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}

// ── Gemini call with Google Search grounding ─────────────────────────────────

interface GeminiGroundedOptions {
  systemPrompt: string
  userPrompt: string
  maxOutputTokens?: number
  temperature?: number
}

async function callGeminiGrounded(opts: GeminiGroundedOptions & { callType?: string; customerName?: string }): Promise<string> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModel()
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — required for Gemini via Vertex AI')

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: opts.systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: opts.userPrompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: opts.temperature ?? 1.0,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      thinkingConfig: { thinkingBudget: 0 },
    },
  })
  const ctx: GeminiFetchContext = { model, project, location, callType: opts.callType, customerName: opts.customerName, timeoutMs: 60_000, logPrefix: '[intelligence]' }
  const res = await fetchGeminiWithRetry(url, getGeminiToken, body, ctx)
  const json = await res.json() as any
  // BKL-M52: record token usage for cost tracking
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType:     opts.callType ?? 'intelligence-grounded',
      customerName: opts.customerName ?? 'unknown',
      inputTokens:  usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
  }
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    const finishReason = json.candidates?.[0]?.finishReason ?? 'unknown'
    const safetyRatings = JSON.stringify(json.candidates?.[0]?.safetyRatings ?? [])
    throw new Error(`Gemini returned no text content (finishReason=${finishReason}, safetyRatings=${safetyRatings})`)
  }
  return text
}

// ── Structured Gemini call with grounding (for industry identification) ──────

// Grounded + structured: Vertex AI doesn't allow google_search + responseSchema together.
// So we use grounding for search, ask for JSON in the prompt, and parse the text response.
async function callGeminiGroundedStructured(opts: GeminiGroundedOptions & { responseSchema: object; callType?: string; customerName?: string }): Promise<any> {
  const text = await callGeminiGrounded({
    ...opts,
    systemPrompt: opts.systemPrompt + '\n\nIMPORTANT: Return your response as valid JSON matching this schema: ' + JSON.stringify(opts.responseSchema),
  })
  // Extract JSON from the response — try multiple extraction strategies
  // Strategy 1: ```json ... ``` block
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
  if (fenceMatch) return JSON.parse(fenceMatch[1])
  // Strategy 2: first { to last } (handles grounding citations after the JSON)
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)) } catch { /* fall through */ }
  }
  // Strategy 3: strip markdown formatting and retry
  const stripped = text.replace(/\[\d+\]/g, '').replace(/\*\*/g, '').trim()
  const strippedBrace = stripped.indexOf('{')
  const strippedLastBrace = stripped.lastIndexOf('}')
  if (strippedBrace !== -1 && strippedLastBrace > strippedBrace) {
    try { return JSON.parse(stripped.slice(strippedBrace, strippedLastBrace + 1)) } catch { /* fall through */ }
  }
  // Strategy 4: grounded response had no JSON — re-prompt without grounding (structured-only fallback)
  // Vertex AI allows responseSchema on non-grounded calls. Use it as a last resort.
  try {
    const project  = process.env.GOOGLE_CLOUD_PROJECT
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
    const model    = getGeminiModel()
    const token    = await getGeminiToken()
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
    const fallbackRes = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: opts.userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: opts.maxOutputTokens ?? 1024,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
          responseSchema: (opts as any).responseSchema,
        },
      }),
    })
    if (fallbackRes.ok) {
      const fallbackJson = await fallbackRes.json() as any
      const fallbackText = fallbackJson.candidates?.[0]?.content?.parts?.[0]?.text
      if (fallbackText) {
        try { return JSON.parse(fallbackText) } catch { /* fall through */ }
      }
    }
  } catch { /* fall through to final error */ }
  throw new Error('Gemini grounded response did not contain valid JSON')
}

// ── BKL-AI01: Identify industry/segment per customer ─────────────────────────

export interface IndustryResult {
  industry: string
  segment: string
  description: string
  competitors: string[]
}

const INDUSTRY_SCHEMA = {
  type: 'object' as const,
  properties: {
    industry: { type: 'string' as const },
    segment: { type: 'string' as const },
    description: { type: 'string' as const },
    competitors: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['industry', 'segment', 'description', 'competitors'],
}

export async function identifyIndustry(customerName: string): Promise<IndustryResult> {
  console.log(`[acct-intel] Identifying industry for ${customerName}`)

  const result = await callGeminiGroundedStructured({
    systemPrompt: `You are an industry classification analyst. Use Google Search to verify current information about the company. Return accurate, specific industry and market segment classifications.`,
    userPrompt: `What industry and market segment does "${sanitizePromptInput(customerName, 200)}" operate in?

Return:
- industry: The broad industry (e.g. "Financial Services", "Healthcare", "Technology", "Retail")
- segment: The specific market segment within that industry (e.g. "Cloud Infrastructure", "Digital Payments", "Enterprise SaaS")
- description: One sentence describing what the company does
- competitors: Top 3 direct competitors by name`,
    responseSchema: INDUSTRY_SCHEMA,
    callType: 'intelligence-industry',
    customerName,
  })

  console.log(`[acct-intel] ${customerName} → ${result.industry} / ${result.segment}`)
  return result
}

/**
 * Persist a found Drive folder ID back to customers.json so future runs skip fuzzy match (BKL-DATA-03).
 * Uses atomic write pattern (tmp + rename) with mode 0o600, same as cacheIndustryResult.
 */
function persistCustomerFolderId(customerName: string, folderId: string): void {
  // Read fresh from disk to avoid stale-overwrite
  let data: { customers: Customer[] }
  try {
    data = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
  } catch {
    data = { customers: [] }
  }

  const idx = data.customers.findIndex(c => c.name === customerName)
  if (idx >= 0) {
    data.customers[idx].driveFolderId = folderId
  }

  const tmp = CUSTOMERS_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, CUSTOMERS_PATH)

  // Update in-memory state too
  const memIdx = customers.findIndex(c => c.name === customerName)
  if (memIdx >= 0) {
    customers[memIdx].driveFolderId = folderId
  }

  console.log(`[acct-intel] Persisted Drive folder ID for ${customerName}: ${folderId}`)
}

/**
 * Cache industry/segment result into customers.json for the given customer.
 * Uses atomic write pattern (tmp + rename) with mode 0o600.
 */
export function cacheIndustryResult(customerName: string, result: IndustryResult): void {
  // Read fresh from disk to avoid stale-overwrite
  let data: { customers: Customer[] }
  try {
    data = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
  } catch {
    data = { customers: [] }
  }

  const idx = data.customers.findIndex(c => c.name === customerName)
  if (idx >= 0) {
    // Add industry fields to the customer object
    ;(data.customers[idx] as any).industry = result.industry
    ;(data.customers[idx] as any).segment = result.segment
    ;(data.customers[idx] as any).industryDescription = result.description
    ;(data.customers[idx] as any).industryCompetitors = result.competitors
    ;(data.customers[idx] as any).industryUpdatedAt = new Date().toISOString()
  }

  const tmp = CUSTOMERS_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, CUSTOMERS_PATH)

  // Update in-memory state too
  const memIdx = customers.findIndex(c => c.name === customerName)
  if (memIdx >= 0) {
    ;(customers[memIdx] as any).industry = result.industry
    ;(customers[memIdx] as any).segment = result.segment
    ;(customers[memIdx] as any).industryDescription = result.description
    ;(customers[memIdx] as any).industryCompetitors = result.competitors
    ;(customers[memIdx] as any).industryUpdatedAt = new Date().toISOString()
  }

  console.log(`[acct-intel] Cached industry for ${customerName}: ${result.industry}/${result.segment}`)
}

// ── BKL-AI02: Company Intelligence Brief ─────────────────────────────────────

const COMPANY_INTEL_SYSTEM_PROMPT = `You are a senior B2B competitive intelligence analyst with 20 years of experience
in enterprise IT markets, specializing in {industry_segment}. Today's date is {date}.
Your training data may be outdated — always verify claims using search.

Rules:
1. Ground ALL financial figures, revenue claims, leadership names, and strategic
   initiatives in verifiable sources. Cite the source inline after each claim.
2. If a fact cannot be verified, explicitly mark it as [UNVERIFIED] with your
   confidence level (HIGH/MEDIUM/LOW).
3. Focus on developments from the past 12 months. Flag anything older.
4. NEVER include analysis that would apply to any company in this industry —
   every claim must be specific to {company_name}.
5. Do NOT use generic business phrases like "strong brand recognition" or
   "well-positioned for growth" without specific evidence.
6. For every strength, identify a counter-argument or risk.
7. For every opportunity, identify the barrier to capture.
8. Structure analysis as PESTLE first (macro-environment), then SWOT
   (informed by PESTLE findings), then competitive positioning.`

const COMPANY_INTEL_USER_PROMPT = `<context>
Target Company: {company_name}
Industry/Segment: {industry_segment}
Account Executive: {ae_name}
Seller Portfolio: Red Hat Enterprise Linux (RHEL), OpenShift (container platform),
  Ansible (automation), Red Hat AI (MLOps/inference platform)
Existing Relationship: {relationship_notes}
</context>

<task>
Generate a comprehensive account intelligence brief for {company_name} following
the section structure below. Use Google Search to verify all claims. Every factual
assertion must cite its source.
</task>

<format>
## Executive Summary
3-5 sentences. Lead with the single most actionable insight for the account team.
State what has CHANGED in the last 90 days. End with the recommended next action.

## Company Overview
Business model, revenue (cite source + fiscal year), employee count, headquarters,
key products/services. Focus on facts relevant to enterprise IT buying.
Confidence: [HIGH/MEDIUM/LOW]

## Leadership & Organizational Changes
C-suite roster. Flag any changes in the last 12 months (new CIO/CTO/VP Infra is
a trigger event). Note any public statements about technology strategy.
Confidence: [HIGH/MEDIUM/LOW]

## PESTLE Analysis
For each factor, provide:
- The specific development (name the regulation, policy, economic trend)
- The date or timeframe
- The mechanism of impact on {company_name} specifically (not the industry generally)
- Impact severity (1-10) and likelihood (1-10)
If no specific development exists for a factor, state "No material developments
identified for {company_name} in the past 12 months" — do NOT generalize.

### Political
### Economic
### Social
### Technological
### Legal
### Environmental

## SWOT Analysis
Informed by PESTLE findings above. For each item:
- State the specific, verifiable fact (not a generic observation)
- Cite the source
- Rate confidence (HIGH/MEDIUM/LOW)
- For strengths: identify the counter-risk
- For opportunities: identify the barrier to capture

### Strengths (Internal, Positive)
### Weaknesses (Internal, Negative)
### Opportunities (External, Positive — informed by PESTLE)
### Threats (External, Negative — informed by PESTLE)

## Competitive Landscape
Who are {company_name}'s top 3-5 competitors? How does {company_name} differentiate?
What are the switching costs? Include market share data if available (cite source).

## Strategic Initiatives & Trigger Events
Recent announcements, M&A activity, partnerships, product launches, leadership changes,
regulatory actions, earnings guidance changes. Rate each trigger's buying urgency:
- HIGH: Creates immediate need (new CTO, cloud migration announcement, M&A)
- MEDIUM: Creates near-term opportunity (hiring patterns, RFP signals)
- LOW: Background trend worth monitoring

## Financial Health
Revenue trajectory, profitability, recent earnings, guidance. Cite specific filings
(10-K, 10-Q, earnings call transcript). For private companies, use available signals
(funding rounds, employee growth, office expansions) and mark confidence accordingly.

## Technology Landscape Assessment
What is {company_name}'s current IT infrastructure? (on-premises %, cloud providers,
container adoption, automation maturity). Sources: job postings, tech blog posts,
conference talks, partnership announcements, case studies.
- Current cloud provider(s)
- Container/Kubernetes adoption status
- Automation tooling in use
- AI/ML initiatives

## Whitespace & Opportunity Mapping (Red Hat Product Fit)
Based ONLY on the technology gaps and business priorities identified in the sections
above, assess where Red Hat's portfolio addresses {company_name}'s specific needs:

For each recommendation:
1. State the specific business need or technology gap (from sections above)
2. Identify the capability requirement (without naming a vendor)
3. Explain how Red Hat's specific product addresses this requirement
4. Cite a relevant customer success story or technical differentiation
5. Note competitive alternatives the customer may evaluate

### RHEL Fit
### OpenShift Fit
### Ansible Fit
### Red Hat AI Fit

## Recommended Next Steps
3-5 specific, actionable recommendations for the account team:
- WHO to contact (title/role, not name unless publicly available)
- WHAT to discuss (tied to a specific trigger event or gap identified above)
- WHEN to act (urgency based on trigger timeline)
- HOW to position (which pain point to lead with)

## Watchpoints
Potential risks or unknowns to monitor: funding changes, leadership turnover,
regulatory changes, competitive moves, contract renewals with incumbent vendors.

## Sources
Complete list of all sources cited in this document with URLs.
</format>

<anti_patterns>
AVOID THESE — they make the report useless:
1. "Wikipedia Summary" — Do not restate publicly available company descriptions.
   Add insight the account team cannot get from the company's About page.
2. "Generic SWOT" — If a strength/weakness/opportunity/threat could apply to ANY
   company in this industry, delete it and replace with something specific.
3. "Hallucinated Confidence" — Never present uncertain information as fact.
   When in doubt, mark [UNVERIFIED].
4. "So What? Report" — Every finding must connect to an ACTION the account team
   can take. Information without action is noise.
5. "Forced Fit" — Do not recommend Red Hat products where there is no evidence
   of a matching need. "No clear fit identified" is an acceptable answer.
6. "Stale Intelligence" — Prioritize the last 12 months. Flag anything older.
</anti_patterns>`

export async function generateCompanyIntelligence(customer: Customer, industry: string): Promise<string> {
  const aeName = customer.ae ?? 'Unknown'
  const segment = (customer as any).segment ?? industry
  const industrySegment = `${industry} / ${segment}`
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // Check for custom prompt doc in Drive (Account Intelligence AI Prompts)
  let customPrompt: string | null = null
  try {
    customPrompt = await fetchCustomPromptFromDrive(customer)
  } catch (e) {
    console.warn(`[acct-intel] No custom prompt doc for ${customer.name}, using default`)
  }

  const systemPrompt = (customPrompt ?? COMPANY_INTEL_SYSTEM_PROMPT)
    .replace(/\{company_name\}/g, customer.name)
    .replace(/\{industry_segment\}/g, industrySegment)
    .replace(/\{date\}/g, date)

  const userPrompt = COMPANY_INTEL_USER_PROMPT
    .replace(/\{company_name\}/g, customer.name)
    .replace(/\{industry_segment\}/g, industrySegment)
    .replace(/\{ae_name\}/g, aeName)
    .replace(/\{relationship_notes\}/g, 'See existing account data')
    .replace(/\{date\}/g, date)

  console.log(`[acct-intel] Generating company intelligence for ${customer.name}`)
  const brief = await callGeminiGrounded({
    systemPrompt,
    userPrompt,
    maxOutputTokens: 8192,
    temperature: 1.0,
    callType: 'intelligence-company',
    customerName: customer.name,
  })

  console.log(`[acct-intel] Company intelligence generated for ${customer.name} (${brief.length} chars)`)
  return brief
}

// ── BKL-AI03: Industry Technology Analysis ───────────────────────────────────

const INDUSTRY_ANALYSIS_SYSTEM_PROMPT = `You are a senior industry analyst with expertise in global technology markets.
Today's date is {date}. Your training data may be outdated — always verify
claims using search.

Rules:
1. Ensure geographic balance: give equal depth to North America, Europe, and
   Asia-Pacific. Include Middle East, Africa, and Latin America where relevant.
2. In each section, cite regional case studies or company examples across at
   least 3 global markets. If data for a region is unavailable, explicitly
   state "No data found for [region]" rather than omitting it.
3. Use international sources (OECD, IMF, WTO, McKinsey, BCG, Statista, regional
   trade organizations, country regulators) alongside US sources.
4. Every factual claim must cite its source inline.
5. Mark unverified claims as [UNVERIFIED].
6. Do NOT assume US infrastructure, regulatory, or adoption levels apply globally.
7. Maintain a strategic, executive-ready analytical tone throughout.`

const INDUSTRY_ANALYSIS_USER_PROMPT = `<context>
Target Company: {company_name}
Company Industry/Segment: {industry_segment}
Analysis Purpose: Help an Account Solution Architect at Red Hat understand how
  technology is reshaping {company_name}'s industry, to identify where Red Hat's
  portfolio (RHEL, OpenShift, Ansible, Red Hat AI) creates value.
</context>

<task>
Generate a comprehensive industry technology analysis for the {industry_segment}
sector that {company_name} operates in.

Step 1 — Subsegment Identification:
First, identify 4-8 key subsegments of the {industry_segment} industry based on
TECHNOLOGY BUYING BEHAVIOR (not production process). For each subsegment provide:
- Name and 1-2 sentence description
- Typical company size range
- IT budget as % of revenue (cite source if available)
- Top 3 technology priorities for next 12-18 months

Step 2 — Include ALL identified subsegments in the analysis below.
</task>

<format>
## Executive Summary
5-7 sentences. The single most important technology trend reshaping {industry_segment},
why it matters for {company_name} specifically, and what it means for Red Hat's
engagement strategy.

## Industry Structure Analysis
Global market size and concentration. Dominant business models. Competitive pressures
across regions. Revenue/GDP share estimates by region (North America, EMEA, APAC, LATAM)
and channel (cite sources). Identify how {company_name} fits within this structure.

## Subsegment Technology Landscape
For each identified subsegment:
- Current technology adoption baseline (on-premises vs cloud vs hybrid)
- Key technology investments planned for next 18 months
- Regulatory/compliance drivers affecting technology choice
- Regional variation in adoption patterns
Identify which subsegment {company_name} primarily operates in.

## Value Chain Mapping & Technology Enablement
Map the full value chain from product development to customer service.
For each phase:
- Describe how IT is being applied across geographies
- Explain regional differences in use cases, adoption drivers, and constraints
- Provide examples from companies in at least 3 different continents
- Identify the highest-impact technology gap at each phase

## Emerging Technology Deep-Dive
For each of these technologies, analyze impact on {industry_segment}:

### Cloud-Native Infrastructure & Containers
### AI/ML and Generative AI
### Automation & Infrastructure as Code
### IoT and Edge Computing
### Digital Twins and Simulation
### Cybersecurity & Zero Trust

For each:
- Current adoption rate by subsegment and region (cite surveys)
- 2-3 real company implementation examples from different regions
- Barriers to adoption specific to {industry_segment}
- 3-year trajectory forecast

## Technology Adoption Chain
In what order does {industry_segment} typically adopt technologies?
Map the adoption chain:
1. CURRENT STATE: Baseline IT infrastructure
2. PRESSURE POINTS: Business pressures driving change
3. ADOPTION SEQUENCE: Cloud > Containers > Automation > AI/ML (or different?)
4. FRICTION POINTS: Industry-specific barriers
5. TECHNOLOGY FIT: Which categories address highest-impact gaps

## IT Vendor Ecosystem
Map the vendor landscape for {industry_segment}:
- Include vendors from multiple regions (not only US hyperscalers)
- Comment on open source adoption trends in this industry
- Identify consolidation trends and market gaps by geography
- Note where Red Hat's portfolio (RHEL, OpenShift, Ansible, Red Hat AI)
  fits in the vendor landscape — but ONLY where evidence supports fit

## Strategic Outlook & Recommendations
Region-specific recommendations for {company_name} and similar enterprises:
- What technologies to prioritize based on subsegment and geography
- Regional risks and regulatory constraints to account for
- Strategic moves needed to stay competitive
- Where Red Hat can add the most value based on the gaps identified above

## Sources
Complete list of all sources cited with URLs.
</format>

<anti_patterns>
1. Do NOT be US-centric. If 80%+ of evidence comes from US sources, flag it
   and add regional caveats.
2. Do NOT recommend Red Hat products where there is no evidence of fit.
3. Do NOT use generic technology trend descriptions — tie every trend to
   {industry_segment} specifically with evidence.
4. Do NOT speculate on market share or revenue without citing a source.
5. Do NOT assume all regions have the same infrastructure maturity.
</anti_patterns>`

export async function generateIndustryAnalysis(customer: Customer, industry: string): Promise<string> {
  const segment = (customer as any).segment ?? industry
  const industrySegment = `${industry} / ${segment}`
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const systemPrompt = INDUSTRY_ANALYSIS_SYSTEM_PROMPT
    .replace(/\{date\}/g, date)

  const userPrompt = INDUSTRY_ANALYSIS_USER_PROMPT
    .replace(/\{company_name\}/g, customer.name)
    .replace(/\{industry_segment\}/g, industrySegment)
    .replace(/\{date\}/g, date)

  console.log(`[acct-intel] Generating industry analysis for ${customer.name} (${industrySegment})`)
  const analysis = await callGeminiGrounded({
    systemPrompt,
    userPrompt,
    maxOutputTokens: 8192,
    temperature: 1.0,
    callType: 'intelligence-analysis',
    customerName: customer.name,
  })

  console.log(`[acct-intel] Industry analysis generated for ${customer.name} (${analysis.length} chars)`)
  return analysis
}

// ── BKL-AI04: Write Intelligence Docs to Google Drive ────────────────────────

export interface IntelligenceDocUrls {
  companyDocUrl: string
  industryDocUrl: string
  folderId: string
}

/**
 * Find the customer's Drive folder using the same priority chain as _fetchCustomerDocsImpl
 * in src/customer.ts: per-customer driveFolderId > AE folder > fuzzy match.
 */
async function findCustomerDriveFolder(customer: Customer): Promise<string> {
  if (customer.driveFolderId) return customer.driveFolderId

  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  const ae = aes.find(a => a.name === customer.ae)
  const aeFolderId = ae?.driveFolderId
  if (!aeFolderId) throw new Error(`No Drive folder found for customer ${customer.name} — no per-customer or AE folder ID`)

  // List subfolders of AE folder and fuzzy match
  const custFolders = await drive.files.list({
    q: `'${aeFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 200,
  })

  const folderList = custFolders.data.files ?? []
  const match = fuzzyFindFolder(folderList, customer.name)
  if (match) {
    // Persist found folderId to customers.json for fast path next time (BKL-DATA-03)
    persistCustomerFolderId(customer.name, match.id)
    return match.id
  }

  // One level deeper (e.g. "Accounts" subfolder)
  for (const sub of folderList.slice(0, 10)) {
    if (!sub.id) continue
    const deeper = await drive.files.list({
      q: `'${sub.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 100,
    })
    const deepMatch = fuzzyFindFolder(deeper.data.files ?? [], customer.name)
    if (deepMatch) {
      // Persist found folderId to customers.json for fast path next time (BKL-DATA-03)
      persistCustomerFolderId(customer.name, deepMatch.id)
      return deepMatch.id
    }
  }

  throw new Error(`No Drive folder found for customer ${customer.name} under AE ${customer.ae}`)
}

/** Reuse the same fuzzy matching logic from customer.ts */
function normalizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s+(inc|llc|ltd|corp|corporation|incorporated|limited|co|group|holdings|international|technologies|logistics|solutions|services|foods|systems|global|networks|software|health sciences|cancer center|cancer research)\.?\s*$/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

function folderMatchScore(folderName: string, customerName: string): number {
  const fn = normalizeFolderName(folderName)
  const cn = normalizeFolderName(customerName)
  if (fn === cn) return 1
  if (fn.includes(cn) || cn.includes(fn)) return 0.9
  const fWords = new Set(fn.split(/\s+/).filter(w => w.length > 2))
  const cWords = cn.split(/\s+/).filter(w => w.length > 2)
  if (fWords.size === 0 || cWords.length === 0) return 0
  const overlap = cWords.filter(w => fWords.has(w)).length
  return overlap / Math.max(fWords.size, cWords.length)
}

function fuzzyFindFolder(
  folders: { id?: string | null; name?: string | null }[],
  customerName: string,
): { id: string; name: string } | undefined {
  let bestScore = 0
  let bestFolder: { id: string; name: string } | undefined
  for (const f of folders) {
    if (!f.id || !f.name) continue
    const score = folderMatchScore(f.name, customerName)
    if (score > bestScore) { bestScore = score; bestFolder = { id: f.id, name: f.name } }
  }
  return bestScore >= 0.5 ? bestFolder : undefined
}

/**
 * Find or create "Account Intelligence" subfolder inside the customer's Drive folder.
 */
async function ensureIntelligenceSubfolder(customerFolderId: string): Promise<string> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // Check for existing subfolder
  const existing = await drive.files.list({
    q: `'${customerFolderId}' in parents and name = 'Account Intelligence' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 1,
  })

  if (existing.data.files?.length && existing.data.files[0].id) {
    console.log(`[acct-intel] Found existing Account Intelligence subfolder`)
    return existing.data.files[0].id
  }

  // Create new subfolder
  const created = await drive.files.create({
    requestBody: {
      name: 'Account Intelligence',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [customerFolderId],
    },
    fields: 'id',
  })

  if (!created.data.id) throw new Error('Failed to create Account Intelligence subfolder')
  console.log(`[acct-intel] Created Account Intelligence subfolder: ${created.data.id}`)
  return created.data.id
}

/**
 * BKL-INTEL-03: Read a Google Doc and count non-empty lines.
 * Used to validate that generated intelligence docs have substantive content.
 */
export async function validateIntelligenceDocContent(
  docId: string,
  docName: string,
): Promise<{ valid: boolean; lineCount: number }> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const docs = google.docs({ version: 'v1', auth })
  const doc = await docs.documents.get({ documentId: docId })

  // Flatten all text from paragraph elements
  const bodyContent = doc.data.body?.content ?? []
  const lines: string[] = []
  for (const element of bodyContent) {
    if (element.paragraph?.elements) {
      const lineText = element.paragraph.elements
        .map((el: any) => el.textRun?.content ?? '')
        .join('')
      lines.push(lineText)
    }
  }

  const nonEmptyLines = lines.filter(l => l.trim().length > 0).length
  console.log(`[acct-intel] Doc "${docName}" has ${nonEmptyLines} non-empty lines`)
  return { valid: nonEmptyLines >= 5, lineCount: nonEmptyLines }
}

/**
 * Create or update a Google Doc in the given folder.
 * If a doc with the same name exists, clears it and writes new content.
 * If not, creates a new doc.
 */
async function upsertGoogleDoc(
  folderId: string,
  docName: string,
  markdownContent: string,
): Promise<string> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const docs = google.docs({ version: 'v1', auth })

  // BKL-INTEL-01: Delete all existing docs with this name, then create one fresh doc.
  // pageSize:1 left duplicates — query all (up to 100) and delete every match.
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${docName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
    fields: 'files(id,name)', pageSize: 100,
  })

  const existingFiles = existing.data.files ?? []
  if (existingFiles.length > 0) {
    console.log(`[acct-intel] Deleting ${existingFiles.length} existing doc(s) named "${docName}"`)
    for (const f of existingFiles) {
      if (f.id) {
        await drive.files.delete({ fileId: f.id })
      }
    }
  }

  // Create a single fresh doc
  console.log(`[acct-intel] Creating fresh doc: ${docName}`)
  const created = await drive.files.create({
    requestBody: {
      name: docName,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId],
    },
    fields: 'id',
  })

  const docId = created.data.id!
  if (!docId) throw new Error(`Failed to create doc: ${docName}`)

  // Insert content
  try {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: 1 },
            text: markdownContent,
          },
        }],
      },
    })
  } catch (e: any) {
    console.error(`[acct-intel] batchUpdate failed for new doc ${docId} (${docName}):`, e?.message ?? e)
    throw e
  }

  const url = `https://docs.google.com/document/d/${docId}/edit`
  console.log(`[acct-intel] Doc ready: ${docName} → ${url}`)
  return url
}

/**
 * Try to read a custom prompt from the customer's "Account Intelligence AI Prompts" doc
 * in their Drive folder. Returns null if not found.
 */
async function fetchCustomPromptFromDrive(customer: Customer): Promise<string | null> {
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const auth = makeAuth(GDRIVE_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Search in customer folder and Account Intelligence subfolder
    const result = await drive.files.list({
      q: `name contains 'Account Intelligence AI Prompts' and mimeType = 'application/vnd.google-apps.document' and trashed = false and ('${customerFolderId}' in parents)`,
      fields: 'files(id,name)', pageSize: 1,
    })

    if (!result.data.files?.length || !result.data.files[0].id) {
      // Also check Account Intelligence subfolder
      const subfolders = await drive.files.list({
        q: `'${customerFolderId}' in parents and name = 'Account Intelligence' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)', pageSize: 1,
      })
      if (subfolders.data.files?.length && subfolders.data.files[0].id) {
        const subResult = await drive.files.list({
          q: `name contains 'Account Intelligence AI Prompts' and mimeType = 'application/vnd.google-apps.document' and trashed = false and ('${subfolders.data.files[0].id}' in parents)`,
          fields: 'files(id,name)', pageSize: 1,
        })
        if (!subResult.data.files?.length) return null
        const exportRes = await drive.files.export(
          { fileId: subResult.data.files[0].id!, mimeType: 'text/plain' },
          { responseType: 'text' },
        )
        const text = String(exportRes.data ?? '').trim()
        return text.length > 50 ? text : null
      }
      return null
    }

    const exportRes = await drive.files.export(
      { fileId: result.data.files[0].id, mimeType: 'text/plain' },
      { responseType: 'text' },
    )
    const text = String(exportRes.data ?? '').trim()
    return text.length > 50 ? text : null
  } catch {
    return null
  }
}

/**
 * Read-only Drive folder scan — looks for already-existing company and industry
 * intelligence docs in the customer's Account Intelligence subfolder.
 *
 * Does NOT generate anything. Used by /api/customer/:name/intelligence-status as
 * a fallback when no in-memory job record exists, so a fresh container restart
 * still surfaces previously-generated docs to the dashboard.
 *
 * @param slug      Customer name / slug (used for log lines)
 * @param folderId  Customer Drive folder ID (the parent of "Account Intelligence")
 * @returns         { companyDocUrl, industryDocUrl } when both docs exist, else null
 */
export async function discoverExistingIntelDocs(
  slug: string,
  folderId: string,
): Promise<{ companyDocUrl: string; industryDocUrl: string } | null> {
  if (!folderId) return null
  try {
    const auth = makeAuth(GDRIVE_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Find the "Account Intelligence" subfolder — read-only, no creation
    const subfolders = await drive.files.list({
      q: `'${folderId}' in parents and name = 'Account Intelligence' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 1,
    })
    const intelFolderId = subfolders.data.files?.[0]?.id
    if (!intelFolderId) return null

    // Look for both docs by suffix — names are "<Customer> - Company Intelligence" and "<Customer> - Industry Analysis"
    const docs = await drive.files.list({
      q: `'${intelFolderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
      fields: 'files(id,name)', pageSize: 50,
    })
    const files = docs.data.files ?? []
    const companyDoc = files.find(f => /Company Intelligence$/i.test(f.name ?? ''))
    const industryDoc = files.find(f => /Industry Analysis$/i.test(f.name ?? ''))
    if (!companyDoc?.id || !industryDoc?.id) return null

    console.log(`[acct-intel] discoverExistingIntelDocs: found existing docs for ${slug}`)
    return {
      companyDocUrl: `https://docs.google.com/document/d/${companyDoc.id}/edit`,
      industryDocUrl: `https://docs.google.com/document/d/${industryDoc.id}/edit`,
    }
  } catch (e: any) {
    console.warn(`[acct-intel] discoverExistingIntelDocs failed for ${slug}: ${e?.message ?? e}`)
    return null
  }
}

export async function writeIntelligenceDocs(
  customer: Customer,
  companyBrief: string,
  industryAnalysis: string,
): Promise<IntelligenceDocUrls> {
  console.log(`[acct-intel] Writing intelligence docs for ${customer.name}`)

  const customerFolderId = await findCustomerDriveFolder(customer)
  const intelFolderId = await ensureIntelligenceSubfolder(customerFolderId)

  const companyDocName = `${customer.name} - Company Intelligence`
  const industryDocName = `${customer.name} - Industry Analysis`

  // Add generation timestamp header to each doc
  const timestamp = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const companyContent = `Generated: ${timestamp}\n\n${companyBrief}`
  const industryContent = `Generated: ${timestamp}\n\n${industryAnalysis}`

  const [companyDocUrl, industryDocUrl] = await Promise.all([
    upsertGoogleDoc(intelFolderId, companyDocName, companyContent),
    upsertGoogleDoc(intelFolderId, industryDocName, industryContent),
  ])

  console.log(`[acct-intel] Intelligence docs written for ${customer.name}`)
  return { companyDocUrl, industryDocUrl, folderId: intelFolderId }
}

// ── Full pipeline orchestrator ───────────────────────────────────────────────

export interface IntelligenceJobStatus {
  status: 'pending' | 'running' | 'complete' | 'error'
  step?: string
  companyDocUrl?: string
  industryDocUrl?: string
  folderId?: string
  error?: string
  startedAt?: string
  completedAt?: string
  /**
   * Set when the docs were not generated by this process but discovered on Drive
   * via discoverExistingIntelDocs() — distinguishes a freshly-created run from a
   * surviving doc set found after a container restart.
   */
  discoveredAt?: string
}

/** In-memory job tracker keyed by customer name */
const jobs = new Map<string, IntelligenceJobStatus>()

let JOB_CACHE_PATH = ''

export function initJobPersistence(cacheDir: string): void {
  JOB_CACHE_PATH = `${cacheDir}/intelligence-jobs.json`
  try {
    const existing = JSON.parse(readFileSync(JOB_CACHE_PATH, 'utf-8')) as Record<string, IntelligenceJobStatus>
    for (const [key, val] of Object.entries(existing)) {
      if (val.status === 'running') val.status = 'error'
      jobs.set(key, val)
    }
    console.log(`[acct-intel] Loaded ${jobs.size} persisted jobs`)
  } catch { /* first run */ }
}

function persistJobs(): void {
  if (!JOB_CACHE_PATH) return
  try {
    writeFileSync(JOB_CACHE_PATH, JSON.stringify(Object.fromEntries(jobs.entries())), { mode: 0o600 })
  } catch { /* non-fatal */ }
}

function setJob(id: string, status: IntelligenceJobStatus): void {
  jobs.set(id, status)
  persistJobs()
}

export function getJobStatus(customerName: string): IntelligenceJobStatus | undefined {
  return jobs.get(customerName)
}

export function getRunningJob(): (IntelligenceJobStatus & { customerName?: string }) | null {
  for (const [name, job] of jobs) {
    if (job.status === 'running') return { ...job, customerName: name }
  }
  return null
}

/** BKL-INTEL-03: Return all jobs as an array for batch validation. */
export function getAllJobs(): Array<{ customerName: string } & IntelligenceJobStatus> {
  return Array.from(jobs.entries()).map(([customerName, status]) => ({ customerName, ...status }))
}

/** BKL-INTEL-03: Reset a job to pending so it gets re-queued on the next batch run. */
export function requeueJob(customerName: string): void {
  const existing = jobs.get(customerName)
  setJob(customerName, {
    status: 'pending',
    startedAt: existing?.startedAt,
  })
  console.log(`[acct-intel] Re-queued job for ${customerName}`)
}

/**
 * Run the full intelligence pipeline for a customer:
 *   1. Identify industry/segment (BKL-AI01)
 *   2. Generate company intelligence (BKL-AI02)
 *   3. Generate industry analysis (BKL-AI03)
 *   4. Write docs to Drive (BKL-AI04)
 *
 * Runs async — caller gets job ID immediately, polls status via getJobStatus().
 */
export async function runIntelligencePipeline(customerName: string): Promise<string> {
  const customer = customers.find(c => c.name === customerName)
  if (!customer) throw new Error(`Customer not found: ${customerName}`)

  const jobId = customerName

  // BKL-AI-03: TTL check — skip regeneration if cached intel is fresh
  const cachedIntel = readIntelligenceCache(customerName)
  if (cachedIntel?.cachedAt && !cachedIntel.skipped) {
    const age = Date.now() - new Date(cachedIntel.cachedAt).getTime()
    if (age < INTELLIGENCE_CACHE_TTL_MS && cachedIntel.company) {
      console.log(`[acct-intel] Skipping ${customerName} — cache is ${Math.round(age / 86400000)}d old (TTL: ${INTELLIGENCE_CACHE_TTL_DAYS}d)`)

      // BKL-ENRICH-01: If customers.json is missing industry/segment (e.g., after a data wipe),
      // re-run identifyIndustry() even though the Drive doc cache is fresh.
      // This is a cheap single Gemini call — avoids re-generating the expensive company/industry docs.
      if (!(customer as any).industry) {
        try {
          console.log(`[acct-intel] customers.json missing industry for ${customerName} despite fresh cache — re-running identifyIndustry`)
          const industryResult = await identifyIndustry(customerName)
          cacheIndustryResult(customerName, industryResult)
        } catch (e: any) {
          console.warn(`[acct-intel] identifyIndustry repair failed for ${customerName}:`, e?.message ?? e)
        }
      }

      setJob(jobId, {
        status: 'complete',
        step: 'skipped (cache fresh)',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ...(cachedIntel.companyDocUrl ? { companyDocUrl: cachedIntel.companyDocUrl } : {}),
        ...(cachedIntel.industryDocUrl ? { industryDocUrl: cachedIntel.industryDocUrl } : {}),
      })
      return jobId
    }
  }

  // BKL-AI-04: Skip customers with no data — no Gemini call needed
  const accountNumbers = customer.accountNumbers ?? []
  const sheetData = readSheetCache(customerName)
  const subscriptions = sheetData?.rows ?? []
  if (accountNumbers.length === 0 && subscriptions.length === 0) {
    // BKL-INTEL-04: identifyIndustry only needs the company name — run it even for no-data customers
    if (!(customer as any).industry) {
      setJob(jobId, { ...jobs.get(jobId)!, status: 'running', step: 'identifying industry (no-data path)', startedAt: new Date().toISOString() })
      try {
        const industryResult = await identifyIndustry(customerName)
        cacheIndustryResult(customerName, industryResult)
        console.log(`[acct-intel] Industry identified for ${customerName} (no-data path): ${industryResult.industry}`)
      } catch (e: any) {
        console.warn(`[acct-intel] identifyIndustry failed for ${customerName}:`, e?.message ?? e)
      }
    }

    const existingCache = readIntelligenceCache(customerName)
    if (!existingCache?.skipped) {
      console.log(`[acct-intel] Skipping ${customerName} — no account numbers or subscriptions; writing stub`)
      if (JOB_CACHE_PATH) {
        try {
          const intelligenceDir = JOB_CACHE_PATH.replace('/intelligence-jobs.json', '/intelligence')
          mkdirSync(intelligenceDir, { recursive: true })
          const slug = customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
          // Preserve existing company/industry docs if present (customer may have lost account numbers after initial run)
          writeFileSync(`${intelligenceDir}/${slug}.json`, JSON.stringify({
            customerName,
            company: existingCache?.company ?? '',
            industry: existingCache?.industry ?? '',
            industryClassification: (customer as any).industry ?? existingCache?.industryClassification ?? '',
            cachedAt: new Date().toISOString(),
            skipped: true,
            skipReason: 'No account numbers or subscriptions',
            ...(existingCache?.companyDocUrl ? { companyDocUrl: existingCache.companyDocUrl } : {}),
            ...(existingCache?.industryDocUrl ? { industryDocUrl: existingCache.industryDocUrl } : {}),
          }), { mode: 0o600 })
        } catch (e: any) { console.warn('[acct-intel] Stub cache write failed:', e.message) }
      }
    } else {
      console.log(`[acct-intel] Skipping ${customerName} — no data, stub already cached`)
    }
    setJob(jobId, { status: 'complete', step: 'skipped (no data)', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() })
    return jobId
  }

  // Set initial status
  setJob(jobId, { status: 'running', step: 'identifying industry', startedAt: new Date().toISOString() })

  // Run pipeline in background (don't await here)
  ;(async () => {
    try {
      // Step 1: Identify industry
      setJob(jobId, { ...jobs.get(jobId)!, step: 'identifying industry' })
      const industryResult = await identifyIndustry(customerName)
      cacheIndustryResult(customerName, industryResult)

      // Steps 2+3: Run in parallel — independent of each other (BKL-AI24)
      setJob(jobId, { ...jobs.get(jobId)!, step: 'generating company intelligence + industry analysis' })
      const [companyResult, industryResult2] = await Promise.allSettled([
        generateCompanyIntelligence(customer, industryResult.industry),
        generateIndustryAnalysis(customer, industryResult.industry),
      ])
      const companyBrief = companyResult.status === 'fulfilled' ? companyResult.value : null
      const industryAnalysis = industryResult2.status === 'fulfilled' ? industryResult2.value : null
      if (!companyBrief && !industryAnalysis) throw new Error('Both company and industry generation failed')
      if (companyResult.status === 'rejected') console.warn(`[acct-intel] Company intel failed for ${customerName}:`, (companyResult.reason as any)?.message)
      if (industryResult2.status === 'rejected') console.warn(`[acct-intel] Industry analysis failed for ${customerName}:`, (industryResult2.reason as any)?.message)

      // Step 4: Write docs to Drive
      setJob(jobId, { ...jobs.get(jobId)!, step: 'writing docs to Drive' })
      const docUrls = await writeIntelligenceDocs(customer, companyBrief ?? '', industryAnalysis ?? '')

      // BKL-INTEL-03: Validate doc content in parallel — must have >= 5 lines or re-queue next run
      setJob(jobId, { ...jobs.get(jobId)!, step: 'validating doc content' })
      const docsToValidate = [
        { docId: docUrls.companyDocUrl?.match(/\/d\/([^/]+)\//)?.[1], docName: `${customerName} - Company Intelligence` },
        { docId: docUrls.industryDocUrl?.match(/\/d\/([^/]+)\//)?.[1], docName: `${customerName} - Industry Analysis` },
      ].filter(d => d.docId)

      const validations = await Promise.all(
        docsToValidate.map(({ docId, docName }) => validateIntelligenceDocContent(docId!, docName))
      )

      for (let i = 0; i < docsToValidate.length; i++) {
        const { docName } = docsToValidate[i]
        const { valid, lineCount } = validations[i]
        if (!valid) {
          console.warn(`[acct-intel] Doc "${docName}" for ${customerName} has only ${lineCount} lines — marking for re-generation`)
          throw new Error(`Doc content too thin (${lineCount} lines) — re-run to regenerate`)
        }
      }

      // Dual-write local intelligence cache (ADR-008) — brief pipeline reads this
      if (JOB_CACHE_PATH) {
        try {
          const intelligenceDir = JOB_CACHE_PATH.replace('/intelligence-jobs.json', '/intelligence')
          mkdirSync(intelligenceDir, { recursive: true })
          const slug = customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
          writeFileSync(
            `${intelligenceDir}/${slug}.json`,
            JSON.stringify({
              customerName,
              company: companyBrief ?? '',
              industry: industryAnalysis ?? '',
              industryClassification: industryResult.industry,
              cachedAt: new Date().toISOString(),
              companyDocUrl: docUrls.companyDocUrl,
              industryDocUrl: docUrls.industryDocUrl,
            }),
            { mode: 0o600 }
          )
          console.log(`[acct-intel] Intelligence cache written for ${customerName}`)
        } catch (e: any) { console.warn('[acct-intel] Cache write failed:', e.message) }
      }

      setJob(jobId, {
        status: 'complete',
        companyDocUrl: docUrls.companyDocUrl,
        industryDocUrl: docUrls.industryDocUrl,
        folderId: docUrls.folderId,
        startedAt: jobs.get(jobId)!.startedAt,
        completedAt: new Date().toISOString(),
      })

      console.log(`[acct-intel] Pipeline complete for ${customerName}`)
    } catch (e: any) {
      console.error(`[acct-intel] Pipeline failed for ${customerName}:`, e)
      setJob(jobId, {
        status: 'error',
        error: String(e?.message ?? e).slice(0, 300),
        startedAt: jobs.get(jobId)?.startedAt,
      })
    }
  })()

  return jobId
}
