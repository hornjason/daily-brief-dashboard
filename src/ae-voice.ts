/**
 * AE Voice Detection — analyze sent emails and cache style profiles
 *
 * Two-part API:
 * 1. getVoiceProfile(aeName) — load from cache → skill voices → null
 * 2. detectVoiceProfile(aeName) — analyze sent emails, cache to local + Drive
 *
 * Voice profiles match the format in ~/.claude/skills/ContentCampaign/voices/
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { callGemini } from './gemini-call.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { aes, customers } from './server-state.ts'
import { toSlug, readEmailCache } from './cache-layer.ts'
import type { EmailHighlight } from './types.ts'
import { CACHE_DIR } from './lib/paths.ts'

// ── Config paths ──────────────────────────────────────────────────────────────

const STYLE_GUIDES_DIR = resolve(CACHE_DIR, 'style-guides')
const SKILL_VOICES_DIR = resolve(process.env.HOME ?? '', '.claude/skills/ContentCampaign/voices')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceProfile {
  aeName: string
  characteristics: string[]
  promptInstruction: string
  exampleEmail?: string
  detectedFrom: string  // e.g., "47 emails across 11 customers"
  detectedAt: string
  phone?: string
  email?: string
  // Structured design tokens for two-pass template assembly (ADR-043)
  formality?: 'casual' | 'professional' | 'formal'
  wordBudget?: { exec: number; manager: number }
  assertionLevel?: 'confident' | 'collaborative' | 'deferential'
}

// ── Voice token resolution ───────────────────────────────────────────────

/**
 * Resolve voice design tokens with defaults.
 * Used by the template engine (ADR-043 Pass 2) to shape sentence structure.
 */
export function getVoiceTokens(profile: VoiceProfile | null): {
  formality: 'casual' | 'professional' | 'formal'
  wordBudget: { exec: number; manager: number }
  assertionLevel: 'confident' | 'collaborative' | 'deferential'
} {
  return {
    formality: profile?.formality ?? 'professional',
    wordBudget: profile?.wordBudget ?? { exec: 150, manager: 200 },
    assertionLevel: profile?.assertionLevel ?? 'collaborative',
  }
}

// ── Local cache helpers ───────────────────────────────────────────────────────

function styleGuideCachePath(aeSlug: string): string {
  return resolve(STYLE_GUIDES_DIR, `${aeSlug}.json`)
}

function readLocalCache(aeName: string): VoiceProfile | null {
  try {
    const path = styleGuideCachePath(toSlug(aeName))
    if (!existsSync(path)) return null
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    // Validate structure
    if (!data.aeName || !Array.isArray(data.characteristics) || !data.promptInstruction) {
      return null
    }
    return data as VoiceProfile
  } catch {
    return null
  }
}

function writeLocalCache(profile: VoiceProfile): void {
  try {
    const path = styleGuideCachePath(toSlug(profile.aeName))
    const dir = resolve(path, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(path, JSON.stringify(profile, null, 2), { mode: 0o600 })
  } catch (e: any) {
    console.warn('[ae-voice] local cache write failed:', e.message)
  }
}

// ── Skill voice file parsing ──────────────────────────────────────────────────

function parseSkillVoiceFile(aeSlug: string): VoiceProfile | null {
  try {
    const path = resolve(SKILL_VOICES_DIR, `${aeSlug}.md`)
    if (!existsSync(path)) return null
    const markdown = readFileSync(path, 'utf-8')

    // Extract ## Prompt Instruction section
    const promptMatch = markdown.match(/## Prompt Instruction\n\n([\s\S]+?)(?=\n##|$)/)
    if (!promptMatch) return null
    const promptInstruction = promptMatch[1].trim()

    // Extract ## Voice Characteristics bullets
    const charMatch = markdown.match(/## Voice Characteristics\n\n([\s\S]+?)(?=\n##|$)/)
    if (!charMatch) return null
    const characteristics = charMatch[1]
      .split('\n')
      .filter(l => l.trim().startsWith('-'))
      .map(l => l.replace(/^-\s*/, '').trim())

    // Extract AE name from title (# Voice Profile: Name)
    const nameMatch = markdown.match(/# Voice Profile:\s*(.+)/)
    const aeName = nameMatch ? nameMatch[1].trim() : aeSlug

    // Extract example email if present
    const exampleMatch = markdown.match(/## Example Email[^`]*```\n([\s\S]+?)```/)
    const exampleEmail = exampleMatch ? exampleMatch[1].trim() : undefined

    // Extract phone and email from signature block
    const phoneMatch = markdown.match(/M:\s*\(?\d{3}\)?\s*\d{3}[-.\s]?\d{4}/)
    const phone = phoneMatch ? phoneMatch[0].replace(/^M:\s*/, '') : undefined
    const emailMatch = markdown.match(/([a-zA-Z0-9._%+-]+@redhat\.com)/)
    const email = emailMatch ? emailMatch[1] : undefined

    return {
      aeName,
      characteristics,
      promptInstruction,
      exampleEmail,
      phone,
      email,
      detectedFrom: 'skill voice file',
      detectedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// ── Public API: load voice profile ────────────────────────────────────────────

/**
 * Load voice profile with fallback chain:
 * 1. Local cache: data/cache/style-guides/{ae-slug}.json
 * 2. Skill voices: ~/.claude/skills/ContentCampaign/voices/{ae-slug}.md
 * 3. null (not detected yet)
 */
export async function getVoiceProfile(aeName: string): Promise<VoiceProfile | null> {
  const slug = toSlug(aeName)

  // 1. Check local cache
  const cached = readLocalCache(aeName)
  if (cached) return cached

  // 2. Parse skill voice file if exists
  const skillProfile = parseSkillVoiceFile(slug)
  if (skillProfile) {
    // Cache it locally for next time
    writeLocalCache(skillProfile)
    return skillProfile
  }

  // 3. Not found
  return null
}

// ── Email filtering and sampling ──────────────────────────────────────────────

/**
 * Find all customers for this AE, read their email caches, filter to emails
 * FROM the AE (match AE's email in the "from" field).
 */
function collectAESentEmails(aeName: string): { emails: EmailHighlight[]; customerCount: number } {
  const ae = aes.find(a => a.name === aeName)
  if (!ae) throw new Error(`AE "${aeName}" not found`)

  const aeCustomers = customers.filter(c => c.ae === aeName)
  let allEmails: EmailHighlight[] = []

  for (const customer of aeCustomers) {
    const cached = readEmailCache(toSlug(customer.name))
    if (!cached) continue

    // Filter to emails FROM this AE
    // Use name-based matching: from field must contain all name tokens
    const fromAE = cached.filter(email => {
      if (!email.from) return false
      const fromLower = email.from.toLowerCase()

      // Match name tokens (e.g., "Carolanne Farrell" → both "carolanne" and "farrell" must be present)
      const nameTokens = aeName.toLowerCase().split(/\s+/)
      return nameTokens.every(token => fromLower.includes(token))
    })

    allEmails.push(...fromAE)
  }

  return { emails: allEmails, customerCount: aeCustomers.length }
}

// ── Gemini voice detection ───────────────────────────────────────────────────

async function callGeminiForVoiceDetection(
  aeName: string,
  emails: EmailHighlight[],
): Promise<{ characteristics: string[]; promptInstruction: string; exampleEmail: string }> {
  // Sample up to 15 emails for analysis (balance: enough signal, not excessive tokens)
  const sampled = emails.slice(0, 15)
  const emailSamples = sampled.map((e, i) =>
    `[Email ${i + 1}]\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}\n`
  ).join('\n')

  const userPrompt = `Analyze these emails sent by ${aeName} and create a voice profile.

Emails:
${emailSamples}

Extract:
1. Voice characteristics (5-8 bullet points): tone, formality level, sentence structure patterns, vocabulary level, greeting style, sign-off style, how they handle asks/CTAs
2. A prompt instruction paragraph (2-3 sentences) that could be given to an AI to replicate this person's writing style
3. One representative example email (the most characteristic snippet from the samples — choose the one that best exemplifies their voice)

Return as JSON with this exact structure:
{
  "characteristics": ["bullet 1", "bullet 2", ...],
  "promptInstruction": "When generating emails in ${aeName}'s voice: ...",
  "exampleEmail": "Subject: ...\n\nBody text..."
}`

  // Define response schema for structured JSON output
  const responseSchema = {
    type: 'object',
    properties: {
      characteristics: {
        type: 'array',
        items: { type: 'string' },
      },
      promptInstruction: { type: 'string' },
      exampleEmail: { type: 'string' },
    },
    required: ['characteristics', 'promptInstruction', 'exampleEmail'],
  }

  const result = await callGemini('', userPrompt, {
    callType: 'ae-voice-detection',
    customerName: aeName,
    temperature: 0.3,
    responseSchema,
    // No deltaKey — email sets change as more emails are sent
  })

  if (!result.text) throw new Error('Gemini returned empty response')

  const parsed = JSON.parse(result.text)
  return {
    characteristics: parsed.characteristics ?? [],
    promptInstruction: parsed.promptInstruction ?? '',
    exampleEmail: parsed.exampleEmail ?? '',
  }
}

// ── Drive upload ──────────────────────────────────────────────────────────────

async function uploadVoiceProfileToDrive(profile: VoiceProfile, aeName: string): Promise<void> {
  try {
    const ae = aes.find(a => a.name === aeName)
    if (!ae?.driveFolderId) {
      console.warn(`[ae-voice] AE "${aeName}" has no Drive folder — skipping Drive upload`)
      return
    }

    // Ensure Config subfolder exists
    const configFolderId = await driveClient.ensureChildFolder(ae.driveFolderId, 'Config')

    // Upload as JSON document
    const jsonContent = JSON.stringify(profile, null, 2)
    await driveClient.upsertDoc(configFolderId, 'style-guide.json', jsonContent, {
      onConflict: 'rewrite',
    })

    console.log(`[ae-voice] uploaded voice profile for ${aeName} to Drive`)
  } catch (e: any) {
    console.warn('[ae-voice] Drive upload failed:', e.message)
  }
}

// ── Public API: detect voice profile ──────────────────────────────────────────

/**
 * Detect voice from AE's sent emails:
 * 1. Find all customers for this AE
 * 2. Read email caches for those customers
 * 3. Filter to emails FROM the AE
 * 4. Send to Gemini for analysis
 * 5. Cache result locally + to Drive
 */
export async function detectVoiceProfile(aeName: string): Promise<VoiceProfile> {
  const { emails, customerCount } = collectAESentEmails(aeName)

  if (emails.length === 0) {
    throw new Error(`No sent emails found for AE "${aeName}" — cannot detect voice profile`)
  }

  console.log(`[ae-voice] analyzing ${emails.length} emails from ${aeName} across ${customerCount} customers`)

  const analysis = await callGeminiForVoiceDetection(aeName, emails)

  const profile: VoiceProfile = {
    aeName,
    characteristics: analysis.characteristics,
    promptInstruction: analysis.promptInstruction,
    exampleEmail: analysis.exampleEmail,
    detectedFrom: `${emails.length} emails across ${customerCount} customers`,
    detectedAt: new Date().toISOString(),
  }

  // Cache locally
  writeLocalCache(profile)

  // Upload to Drive (async, non-blocking)
  uploadVoiceProfileToDrive(profile, aeName).catch(e =>
    console.warn('[ae-voice] Drive upload failed:', e.message)
  )

  return profile
}
