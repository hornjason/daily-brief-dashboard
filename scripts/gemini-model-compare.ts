// Quick model comparison for tech-stack extraction quality
// Tests multiple Gemini models against multiple customers
import { getGeminiToken } from '../src/gemini-auth.ts'
import { fetchGeminiWithRetry } from '../src/gemini-fetch.ts'

const PROJECT_ID = process.env.VERTEX_PROJECT_ID || 'jhorn-pai'
const LOCATION = process.env.VERTEX_LOCATION || 'us-east1'

const MODELS = [
  'gemini-3.5-flash',
  'gemini-2.5-pro',
]

const CUSTOMERS = [
  'A10 Networks',
  'Fred Hutchinson Cancer Center',
  'Dropbox',
]

const systemPrompt = `You are a technology detection system. Research the company using Google Search. Find specific products and vendor tools, not generic categories. Return a JSON array of technologies.

Rules:
- Find SPECIFIC vendor products and tools (e.g., "Terraform" not "IaC", "ServiceNow" not "ITSM", "Jenkins" not "CI/CD")
- Classify each as "proprietary" (customer-built/specific) or "industry-tool" (widely used vendor/OSS)
- Context: "using" | "evaluating" | "migrating_from"
- Confidence: HIGH (explicitly mentioned in sources) | MEDIUM (strongly implied) | LOW (inferred)
- For each, include redHatProducts that complement: ocp, rhel, aap, acs, acm, satellite, rhdh, quay
- Include a "why" field: one sentence on why the customer uses this
- Include a "matchable" field: true if this is a specific vendor product that could match a partner solution or competitive play, false if it's a generic language/tool (Python, Bash, Go)
- Return ONLY the JSON array, no markdown`

function makeUserPrompt(customer: string): string {
  return `CUSTOMER: ${customer}

Research ${customer}'s technology stack using Google Search. Find job postings, case studies, partner announcements, and engineering blog posts.

Return JSON array:
[{"name":"...","category":"proprietary"|"industry-tool","context":"using"|"evaluating"|"migrating_from","confidence":"HIGH"|"MEDIUM"|"LOW","redHatProducts":["ocp","rhel"],"why":"one sentence","matchable":true}]

Return ONLY the JSON array.`
}

async function runModel(modelName: string, customer: string) {
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelName}:generateContent`

  const body: any = {
    contents: [{ role: 'user', parts: [{ text: makeUserPrompt(customer) }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    tools: [{ googleSearch: {} }],
  }

  if (modelName.startsWith('gemini-3')) {
    body.generationConfig.thinkingConfig = { thinkingLevel: 'minimal' }
  } else {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  const start = Date.now()
  try {
    const resp = await fetchGeminiWithRetry(url, getGeminiToken, JSON.stringify(body), { timeoutMs: 120000 })
    const elapsed = Date.now() - start
    const data = JSON.parse(resp)

    const text = data.candidates?.[0]?.content?.parts
      ?.filter((p: any) => p.text && !p.thought)
      ?.map((p: any) => p.text)
      ?.join('') ?? ''

    let techs: any[] = []
    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      techs = JSON.parse(cleaned)
    } catch {
      console.log(`  [${modelName}] Failed to parse JSON response`)
    }

    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0

    return { model: modelName, customer, elapsed, techs, inputTokens, outputTokens }
  } catch (e: any) {
    return { model: modelName, customer, elapsed: Date.now() - start, techs: [], error: e.message }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Gemini Model Comparison: Tech-Stack Extraction')
  console.log('═══════════════════════════════════════════════════════\n')

  for (const customer of CUSTOMERS) {
    console.log(`\n━━━ ${customer} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

    for (const model of MODELS) {
      console.log(`  ▸ ${model}`)
      const result = await runModel(model, customer)

      if (result.error) {
        console.log(`    ERROR: ${result.error}\n`)
        continue
      }

      console.log(`    Time: ${(result.elapsed/1000).toFixed(1)}s | Tokens: ${result.inputTokens}in/${result.outputTokens}out`)
      console.log(`    Technologies found: ${result.techs.length}`)

      const matchable = result.techs.filter((t: any) => t.matchable === true || t.matchable === undefined)
      const notMatchable = result.techs.filter((t: any) => t.matchable === false)
      const withRedHat = result.techs.filter((t: any) =>
        Array.isArray(t.redHatProducts) && t.redHatProducts.length > 0
      )

      console.log(`    Matchable: ${matchable.length} | Not matchable: ${notMatchable.length} | With RH mapping: ${withRedHat.length}`)
      console.log(`    ┌──────── ──────────── ─────────────────────────────────────`)

      for (const t of result.techs) {
        const rh = Array.isArray(t.redHatProducts) ? t.redHatProducts.join(',') : ''
        const match = t.matchable === false ? '✗' : '✓'
        const conf = (t.confidence ?? '?').padEnd(6)
        const ctx = (t.context ?? '?').padEnd(14)
        console.log(`    │ ${match} ${conf} ${ctx} ${t.name}${rh ? ` → [${rh}]` : ''}`)
      }
      console.log(`    └──────────────────────────────────────────────────────────`)
      console.log()
    }
  }

  console.log('\n═══ Comparison Complete ═══')
}

main().catch(console.error)
