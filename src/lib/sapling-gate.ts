import { callGemini } from '../gemini-call.ts'

export interface SaplingResult {
  score: number
  flaggedSentences: Array<{ sentence: string; score: number }>
}

function getSaplingApiKey(): string | undefined {
  if (process.env.SAPLING_API_KEY) return process.env.SAPLING_API_KEY
  try {
    const { readFileSync } = require('fs')
    const envContent = readFileSync(`${process.env.HOME}/.claude/.env`, 'utf-8')
    const match = envContent.match(/^SAPLING_API_KEY=(.+)$/m)
    return match?.[1]?.trim()
  } catch {
    return undefined
  }
}

export async function scoreSaplingAI(text: string, recipientName?: string): Promise<SaplingResult> {
  const key = getSaplingApiKey()
  if (!key) {
    console.warn('[sapling] SAPLING_API_KEY not set — skipping detection')
    return { score: 0, flaggedSentences: [] }
  }

  try {
    const response = await fetch('https://api.sapling.ai/api/v1/aidetect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, text, sent_scores: true }),
    })

    if (!response.ok) {
      console.warn(`[sapling] API error ${response.status} — failing open`)
      return { score: 0, flaggedSentences: [] }
    }

    const data = await response.json() as {
      score: number
      sentence_scores?: Array<{ sentence: string; score: number }>
    }

    const score = data.score ?? 0
    const flaggedSentences = (data.sentence_scores || [])
      .filter(s => s.score > 0.5)

    const label = score > 0.8 ? 'FAIL' : score > 0.5 ? 'WARN' : 'PASS'
    console.log(`[sapling] ${recipientName || 'unknown'}: score ${score.toFixed(3)} (${label})`)

    return { score, flaggedSentences }
  } catch (err: any) {
    console.warn(`[sapling] error — ${err.message?.slice(0, 80)} — failing open`)
    return { score: 0, flaggedSentences: [] }
  }
}

export async function humanizeEmail(
  text: string,
  saplingResult: SaplingResult,
  recipientName: string,
  recipientTitle: string,
  company: string,
): Promise<string | null> {
  const systemPrompt = 'You rewrite AI-generated B2B emails to sound like a real person wrote them. Keep all facts, names, links, and data points. Change the sentence structure and word choice to sound natural.'

  const flaggedList = saplingResult.flaggedSentences
    .map(s => `- "${s.sentence}" (score: ${s.score.toFixed(2)})`)
    .join('\n')

  const userPrompt = `Rewrite this email to sound more human. The AI detection score is ${saplingResult.score.toFixed(3)}.

Flagged sentences:
${flaggedList || 'None specifically flagged'}

Original email:
${text}

Context: This email is to ${recipientName}, ${recipientTitle} at ${company}.

Rules:
- Keep ALL facts, names, URLs, links, and data points exactly as they appear
- Change sentence structure, vary sentence length, use natural transitions
- Keep the same overall length (120-160 words)
- Do not add new information or marketing language
- Output ONLY the rewritten email body, nothing else`

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'campaign-humanize',
      temperature: 0.9,
    })

    const rewritten = (result.text || '').trim()
    const words = rewritten.split(/\s+/).length
    if (words < 50 || words > 250) {
      console.warn(`[humanize] ${recipientName}: rejected rewrite — ${words} words`)
      return null
    }

    return rewritten
  } catch (err: any) {
    console.warn(`[humanize] ${recipientName}: error — ${err.message?.slice(0, 80)}`)
    return null
  }
}
