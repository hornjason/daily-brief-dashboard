// Test: 1 Gemini batch call per AE → Clearbit fallback for misses
// Read-only — no writes to customers.json

import { getGeminiToken } from '../src/gemini-auth.ts'
import { getGeminiModelLite } from '../src/settings-api.ts'
import { tier1Clearbit } from '../src/domain-waterfall.ts'

const { customers: all } = await Bun.file('/data/config/customers.json').json() as {
  customers: { name: string; domain?: string; inactive?: boolean; ae: string }[]
}
const customers = all.filter(c => !c.inactive)
const aes = [...new Set(customers.map(c => c.ae))]

console.log(`\nLoaded ${customers.length} customers across ${aes.length} AE(s): ${aes.join(', ')}\n`)

async function geminiAEBatch(names: string[]): Promise<Record<string, string | null>> {
  const token = await getGeminiToken()
  const model = getGeminiModelLite()
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const prompt = `For each company name below, return its primary official website domain.
Rules:
- Use the brand/DBA domain, not legal entity name (e.g. "Recreational Equipment" → "rei.com", "Taylor Fresh Foods" → "taylorfarms.com")
- Return ONLY a valid JSON object mapping each company name exactly as given to its domain string
- If genuinely unknown or a shell entity with no website, use null
- No explanations, no markdown, no code fences — raw JSON only

Companies:
${JSON.stringify(names, null, 2)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const json = await res.json() as any
  const raw = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()

  try {
    return JSON.parse(raw)
  } catch {
    console.error('  ⚠ JSON parse failed, raw response:', raw.slice(0, 200))
    return {}
  }
}

const allResults: { name: string; ae: string; domain: string | null; source: string }[] = []

for (const ae of aes) {
  const aeCustomers = customers.filter(c => c.ae === ae)
  const names = aeCustomers.map(c => c.name)

  console.log(`${'─'.repeat(60)}`)
  console.log(`AE: ${ae} (${names.length} customers)`)
  console.log(`${'─'.repeat(60)}`)

  // Step 1: one Gemini batch call for the whole AE
  const batchStart = Date.now()
  console.log(`\n[Gemini batch] ${names.length} companies...`)
  let geminiResults: Record<string, string | null> = {}
  try {
    geminiResults = await geminiAEBatch(names)
    console.log(`  → ${Date.now() - batchStart}ms`)
  } catch (e: any) {
    console.error(`  Gemini batch failed: ${e.message}`)
  }

  // Step 2: Clearbit fallback for any nulls or missing
  const misses = names.filter(n => !geminiResults[n])
  if (misses.length > 0) {
    console.log(`\n[Clearbit fallback] ${misses.length} misses: ${misses.join(', ')}`)
    for (const name of misses) {
      const cbStart = Date.now()
      const domain = await tier1Clearbit(name).catch(() => null)
      console.log(`  ${domain ? '✅' : '❌'} ${name.padEnd(38)} → ${domain ?? '(none)'} [${Date.now() - cbStart}ms]`)
      if (domain) geminiResults[name] = domain
    }
  }

  // Report per-AE
  console.log(`\nResults for ${ae}:`)
  for (const name of names) {
    const domain = geminiResults[name] ?? null
    const source = domain
      ? (misses.includes(name) ? 'clearbit' : 'gemini')
      : 'miss'
    const status = domain ? '✅' : '❌'
    const sourceTag = source === 'clearbit' ? ' [clearbit]' : source === 'miss' ? '' : ''
    console.log(`  ${status} ${name.padEnd(40)} → ${(domain ?? '(none)').padEnd(28)}${sourceTag}`)
    allResults.push({ name, ae, domain, source })
  }
}

// Final summary
console.log(`\n${'='.repeat(60)}`)
console.log('FINAL SUMMARY')
console.log('='.repeat(60))
const resolved = allResults.filter(r => r.domain).length
const fromGemini = allResults.filter(r => r.source === 'gemini').length
const fromClearbit = allResults.filter(r => r.source === 'clearbit').length
const missed = allResults.filter(r => !r.domain).length

console.log(`Total:    ${allResults.length} customers`)
console.log(`Resolved: ${resolved}/${allResults.length} (${Math.round(resolved/allResults.length*100)}%)`)
console.log(`  Gemini:   ${fromGemini}`)
console.log(`  Clearbit: ${fromClearbit}`)
console.log(`  Missed:   ${missed}`)
if (missed > 0) {
  console.log(`\nUnresolvable:`)
  allResults.filter(r => !r.domain).forEach(r => console.log(`  ${r.name} (${r.ae})`))
}
