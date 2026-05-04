// Batch domain inference test — one Gemini call per batch of N companies
// Usage: bun run scripts/test-batch-inference.ts
// Reads from /data/config/customers.json (container) — read only, no writes

import { getGeminiToken } from '../src/gemini-auth.ts'
import { getGeminiModelLite } from '../src/settings-api.ts'

const CUSTOMERS_PATH = '/data/config/customers.json'

const { customers: all } = await Bun.file(CUSTOMERS_PATH).json() as {
  customers: { name: string; domain?: string; inactive?: boolean; ae: string }[]
}
const customers = all.filter(c => !c.inactive)
const names = customers.map(c => c.name)

console.log(`\nLoaded ${names.length} customers across AEs: ${[...new Set(customers.map(c => c.ae))].join(', ')}\n`)

async function batchLookup(batch: string[]): Promise<Record<string, string | null>> {
  const token = await getGeminiToken()
  const model = getGeminiModelLite()
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const prompt = `For each company name below, return its primary official website domain (e.g. "rei.com", "taylorfarms.com").
Rules:
- Use the brand/DBA domain, not the legal entity name (e.g. "Recreational Equipment" → "rei.com", "Taylor Fresh Foods" → "taylorfarms.com")
- Return ONLY a valid JSON object mapping each company name exactly as given to its domain string
- If genuinely unknown or a shell entity with no website, map to null
- No explanations, no markdown, no code fences — raw JSON only

Companies:
${JSON.stringify(batch, null, 2)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const json = await res.json() as any
  const raw = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    console.error('JSON parse failed. Raw response:\n', raw)
    return {}
  }
}

async function runBatchSize(batchSize: number) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`BATCH SIZE: ${batchSize} (${Math.ceil(names.length / batchSize)} call${Math.ceil(names.length / batchSize) > 1 ? 's' : ''})`)
  console.log('='.repeat(60))

  const start = Date.now()
  const results: Record<string, string | null> = {}
  let callCount = 0

  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize)
    callCount++
    const callStart = Date.now()
    console.log(`\nCall ${callCount}: [${batch.join(', ')}]`)
    try {
      const res = await batchLookup(batch)
      const callMs = Date.now() - callStart
      console.log(`  → ${callMs}ms`)
      for (const [name, domain] of Object.entries(res)) {
        results[name] = domain
        const status = domain ? '✅' : '❌'
        const existing = customers.find(c => c.name === name)?.domain
        const diff = existing && domain && existing !== domain ? ` ⚠ was: ${existing}` : ''
        console.log(`  ${status} ${name.padEnd(40)} → ${domain ?? '(none)'}${diff}`)
      }
      // Flag any names in batch not returned
      for (const name of batch) {
        if (!(name in res)) {
          console.log(`  ⚠ ${name.padEnd(40)} → MISSING FROM RESPONSE`)
          results[name] = null
        }
      }
    } catch (e: any) {
      console.error(`  Call failed: ${e.message}`)
      for (const name of batch) results[name] = null
    }
  }

  const totalMs = Date.now() - start
  const resolved = Object.values(results).filter(Boolean).length
  const missed = Object.values(results).filter(v => v === null).length

  console.log(`\nSummary: ${resolved}/${names.length} resolved, ${missed} missed, ${callCount} call(s), ${totalMs}ms total`)
  if (missed > 0) {
    console.log(`Missed: ${Object.entries(results).filter(([,v]) => !v).map(([k]) => k).join(', ')}`)
  }
  return { batchSize, resolved, missed, totalMs, calls: callCount }
}

// Test batch sizes: all at once, 15, 10, 5
const sizes = [names.length, 15, 10, 5].filter((v, i, a) => a.indexOf(v) === i && v <= names.length)
const summary: { batchSize: number; resolved: number; missed: number; totalMs: number; calls: number }[] = []

for (const size of sizes) {
  const result = await runBatchSize(size)
  summary.push(result)
  if (size !== sizes[sizes.length - 1]) {
    console.log('\nWaiting 3s before next batch size...')
    await Bun.sleep(3000)
  }
}

console.log('\n' + '='.repeat(60))
console.log('COMPARISON')
console.log('='.repeat(60))
console.log('Batch size | Resolved | Calls | Total time')
for (const r of summary) {
  console.log(`${String(r.batchSize).padEnd(10)} | ${r.resolved}/${names.length}     | ${r.calls}     | ${r.totalMs}ms`)
}
