/**
 * Context Orchestrator — Unified context assembly for all consumers
 *
 * Wraps templateAll (Layer 1) and handles Layer 2/3 context loading
 * so consumers get a single structured context object instead of
 * assembling context from 11+ independent data sources.
 *
 * Council review #1033, Phase 3 fix for architectural drift.
 */

import type { Signal } from '../feature-module-registry.ts'
import type { AccountTeamMember, Customer } from '../types.ts'
import type { TemplateResult, TemplateOptions } from './templates/types.ts'
import type { EngagementTimelineEntry } from './deterministic-overrides.ts'
import { loadCustomerSignals, type SignalLoadResult } from './signal-loader.ts'
import { templateAll } from './signal-templates.ts'
import { getAccountTeam, toPromptContext } from '../account-team.ts'
import { CACHE_DIR } from './paths.ts'
import { toSlug } from '../cache-layer.ts'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConsumerContextRequest {
  customer: Customer
  consumerType: 'meeting-prep' | 'campaign' | 'playbook' | 'account-plan' | 'dashboard' | 'value-positioning' | 'expansion-opps'
  options?: {
    meetingEvent?: any
    materialContent?: any
    signals?: Signal[]
    productFilter?: string[]
    includeEmail?: boolean
    includeBVA?: boolean
    includeSolutionPlays?: boolean
    includeDriveDocs?: boolean
    includeIntelligence?: boolean
    includeEngagementTimeline?: boolean
    format?: 'playbook' | 'brief' | 'campaign' | 'meeting-prep'
    preloadedDriveDocs?: { driveDocsContext: string; bvaContext: string }
    preloadedIntelligence?: string
  }
}

export interface ConsumerContext {
  // Layer 1: Signals (from templateAll)
  signalContext: string
  signals: Signal[]
  templateResult: TemplateResult
  accountTeam: AccountTeamMember[]
  teamContext: string

  // Layer 2: Documents & content
  driveDocsContext?: string
  emailContext?: string
  bvaContext?: string
  intelligenceContext?: string
  solutionPlaysContext?: string

  // Layer 3: Meeting/interaction-specific
  meetingHistoryContext?: string
  organizerContext?: string
  engagementTimeline?: EngagementTimelineEntry[]

  // Metadata
  provenance: ProvenanceEntry[]
  productSlugs: string[]
  slug: string
}

export interface ProvenanceEntry {
  source: string
  loaded: boolean
  tokenEstimate: number
}

// ── Default options per consumer type ────────────────────────────────────────

const CONSUMER_DEFAULTS: Record<string, Partial<ConsumerContextRequest['options']>> = {
  'meeting-prep': {
    includeEmail: true,
    includeDriveDocs: true,
    includeBVA: true,
    includeIntelligence: true,
    includeEngagementTimeline: true,
    format: 'meeting-prep',
  },
  'campaign': {
    includeIntelligence: true,
    format: 'campaign',
  },
  'playbook': {
    includeEmail: true,
    includeIntelligence: true,
    includeDriveDocs: true,
    format: 'playbook',
  },
  'account-plan': {
    includeIntelligence: true,
    includeDriveDocs: true,
    format: 'playbook',
  },
  'dashboard': {
    format: 'brief',
  },
  'value-positioning': {
    includeIntelligence: true,
    format: 'playbook',
  },
  'expansion-opps': {
    includeIntelligence: true,
    format: 'playbook',
  },
}

function consumerTypeToFormat(consumerType: string): TemplateOptions['format'] {
  return (CONSUMER_DEFAULTS[consumerType]?.format as TemplateOptions['format']) ?? 'playbook'
}

// ── Layer 2 Context Loaders ─────────────────────────────────────────────────

export function loadIntelligenceContext(slug: string): string {
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
  if (!existsSync(intelPath)) return ''

  try {
    const intel = JSON.parse(readFileSync(intelPath, 'utf-8'))
    const parts: string[] = []

    const companyText = intel.company ?? intel.companyIntelligence
    if (companyText) {
      parts.push(typeof companyText === 'string'
        ? companyText.slice(0, 5000)
        : JSON.stringify(companyText).slice(0, 5000))
    }

    const industryText = intel.industry ?? intel.industryAnalysis
    if (industryText) {
      parts.push(typeof industryText === 'string'
        ? industryText.slice(0, 3000)
        : JSON.stringify(industryText).slice(0, 3000))
    }

    return parts.join('\n\n')
  } catch {
    return ''
  }
}

export function loadEmailIntelligence(slug: string): string {
  const noisePatterns = [
    /^invitation:/i, /^accepted:/i, /^declined:/i,
    /^updated invitation:/i, /^canceled event:/i,
    /^ooo alert/i, /^out of office/i,
  ]
  try {
    const emailCachePath = resolve(CACHE_DIR, `${slug}-emails.json`)
    if (!existsSync(emailCachePath)) return ''
    const emailData = JSON.parse(readFileSync(emailCachePath, 'utf-8'))
    const emails = emailData.data || emailData || []
    if (!Array.isArray(emails) || emails.length === 0) return ''

    const threads: string[] = []
    const seen = new Set<string>()

    for (const email of emails) {
      const subject = (email.subject || '').trim()
      if (!subject) continue
      if (noisePatterns.some(p => p.test(subject))) continue
      if ((email.from || '').includes('gemini')) continue

      const threadKey = subject.replace(/^(Re: |Fwd: )+/i, '').toLowerCase().substring(0, 40)
      if (seen.has(threadKey)) continue
      seen.add(threadKey)

      const body = (email.bodyText || email.snippet || '').trim()
      if (!body || body.length < 30) continue

      const paragraphs = body.split(/\n\n+/).filter((p: string) => {
        const t = p.trim()
        return t.length > 20 && !t.startsWith('On ') && !t.startsWith('--') && !t.includes('sent from my')
      })
      const excerpt = paragraphs[0]?.trim().replace(/\n+/g, ' ').slice(0, 300) || ''
      if (!excerpt) continue

      const date = (email.date || '').substring(0, 10)
      const from = (email.from || '').replace(/<[^>]+>/g, '').trim()
      threads.push(`**${subject}** (${date}, ${from})\n${excerpt}`)
    }

    if (threads.length === 0) return ''
    return `## Email Thread Intelligence\nKey business discussions from recent email threads:\n\n${threads.slice(0, 8).join('\n\n')}`
  } catch { return '' }
}

export function loadEngagementTimeline(slug: string): EngagementTimelineEntry[] {
  const entries: EngagementTimelineEntry[] = []

  const noisePatterns = [
    /^invitation:/i, /^accepted:/i, /^declined:/i,
    /^updated invitation:/i, /^canceled event:/i,
    /^ooo alert/i, /^notes:/i, /^out of office/i,
  ]
  const isNoise = (s: string) => noisePatterns.some(p => p.test(s))
  const seenSummaries = new Set<string>()

  // Source 1: Graph engagement nodes
  try {
    const { loadGraph } = require('./intelligence-graph.ts')
    const graph = loadGraph(slug, CACHE_DIR)
    if (graph) {
      const engagementNodes = Object.values(graph.nodes).filter((n: any) => n.type === 'engagement')
      for (const node of engagementNodes as any[]) {
        const props = node.properties as Record<string, any>
        const date = props.date || props.timestamp || node.updatedAt || ''
        const subject = node.name || ''
        if (!date || !subject) continue
        if (isNoise(subject)) continue
        const clean = subject.replace(/^(Re: |Fwd: )+/i, '')
        const key = clean.toLowerCase().substring(0, 40)
        if (seenSummaries.has(key)) continue
        seenSummaries.add(key)
        entries.push({ date: String(date), summary: clean, source: 'graph' })
      }
    }
  } catch { /* graph not available */ }

  // Source 2: Email cache
  try {
    const emailCachePath = resolve(CACHE_DIR, `${slug}-emails.json`)
    if (existsSync(emailCachePath)) {
      const emailData = JSON.parse(readFileSync(emailCachePath, 'utf-8'))
      const emails = emailData.data || emailData || []
      if (Array.isArray(emails)) {
        for (const email of emails.slice(0, 20)) {
          const date = email.date || email.receivedAt || ''
          const subject = email.subject || ''
          if (!date || !subject) continue
          if (isNoise(subject)) continue
          const clean = subject.replace(/^(Re: |Fwd: )+/i, '')
          const key = clean.toLowerCase().substring(0, 40)
          if (seenSummaries.has(key)) continue
          seenSummaries.add(key)
          const messageId = email.id || email.messageId || ''
          const gmailUrl = messageId ? `https://mail.google.com/mail/u/0/#inbox/${messageId}` : undefined
          entries.push({ date: String(date), summary: clean, source: 'email', sourceUrl: gmailUrl })
        }
      }
    }
  } catch { /* email cache not available */ }

  // Source 3: Meeting prep history
  const history = readPrepHistory(slug)
  const seenTitles = new Set<string>()
  for (const h of history.slice(0, 5)) {
    const titleKey = h.meetingTitle?.toLowerCase()
    if (!titleKey || seenTitles.has(titleKey)) continue
    seenTitles.add(titleKey)
    entries.push({
      date: h.meetingStart,
      summary: `Meeting: ${h.meetingTitle}`,
      source: 'prep-history',
      sourceUrl: h.docUrl,
    })
  }

  return entries
}

export async function loadDriveDocsContext(
  customer: Customer,
  slug: string,
): Promise<{ driveDocsContext: string; bvaContext: string }> {
  let driveDocsContext = ''
  let bvaContext = ''

  try {
    const { findCustomerDriveFolder } = await import('./customer-folder.ts')
    const { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } = await import('../google.ts')
    const { google } = await import('googleapis')
    const { extractDocTextWithTabs } = await import('../customer/doc-extractors.ts')

    const customerFolderId = await findCustomerDriveFolder(customer)
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const history = readPrepHistory(slug)
    const lastPrepDate = history[0]?.generatedAt
    const sinceDate = lastPrepDate
      ? new Date(lastPrepDate)
      : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

    const recentDocs = await drive.files.list({
      q: `'${customerFolderId}' in parents and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '${sinceDate.toISOString()}' and trashed = false`,
      fields: 'files(id,name,modifiedTime,webViewLink)',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    const customerShortName = customer.name.split(/[,.]/, 1)[0].trim()
    const geminiNotesQuery = `fullText contains '${customerShortName.replace(/'/g, "\\'")}' and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.presentation') and (name contains 'Notes by Gemini' or name contains 'Business Value' or name contains 'kick off' or name contains 'transcript') and modifiedTime > '${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()}' and trashed = false`
    let geminiNotes: any[] = []
    try {
      const notesRes = await drive.files.list({
        q: geminiNotesQuery,
        fields: 'files(id,name,modifiedTime,webViewLink,mimeType)',
        pageSize: 10,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      geminiNotes = notesRes.data.files ?? []
    } catch (e: any) {
      console.warn(`[context-orchestrator] Gemini notes search failed:`, e.message)
    }

    const seenIds = new Set<string>()
    const allDocs = [...(recentDocs.data.files ?? []), ...geminiNotes].filter(d => {
      if (seenIds.has(d.id!)) return false
      seenIds.add(d.id!)
      return true
    })

    if (allDocs.length > 0) {
      const docTexts: string[] = []
      const bvaTexts: string[] = []
      for (const doc of allDocs.slice(0, 12)) {
        try {
          let text: string | null = null
          if (doc.mimeType === 'application/vnd.google-apps.presentation') {
            try {
              const exported = await drive.files.export({ fileId: doc.id!, mimeType: 'text/plain' }, { responseType: 'text' })
              text = typeof exported.data === 'string' ? exported.data : null
            } catch { /* Slides export failed */ }
          } else {
            text = await extractDocTextWithTabs(doc.id!, auth)
          }
          if (!text) continue
          const isGeminiNote = geminiNotes.some(g => g.id === doc.id)
          const isBVA = /business\s*value|bva|kick\s*off/i.test(doc.name ?? '')
          let extracted: string
          if (isGeminiNote) {
            const summaryMatch = text.match(/Summary\n([\s\S]*?)(?=\n(?:Next steps|Details|Transcript|$))/i)
            const nextStepsMatch = text.match(/Next steps\n([\s\S]*?)(?=\n(?:Details|Transcript|$))/i)
            const summary = summaryMatch?.[1]?.trim() || ''
            const nextSteps = nextStepsMatch?.[1]?.trim() || ''
            if (summary || nextSteps) {
              extracted = [summary ? `**Summary:** ${summary}` : '', nextSteps ? `**Next Steps:** ${nextSteps}` : ''].filter(Boolean).join('\n\n')
            } else {
              extracted = text.slice(0, 4000)
            }
          } else {
            extracted = text.slice(0, 2000)
          }
          const label = isGeminiNote ? '(Gemini meeting notes)' : `(modified ${new Date(doc.modifiedTime!).toLocaleDateString()})`
          const docEntry = `### ${doc.name} ${label}\n${extracted}`
          if (isBVA) {
            bvaTexts.push(docEntry)
          } else {
            docTexts.push(docEntry)
          }
        } catch { /* skip unreadable docs */ }
      }
      if (bvaTexts.length > 0) {
        bvaContext = `## Business Value Assessment Context (CRITICAL — ground §1 and §4 in this)\n${bvaTexts.join('\n\n')}`
        console.log(`[context-orchestrator] BVA context: ${bvaTexts.length} docs for ${customer.name}`)
      }
      if (docTexts.length > 0) {
        driveDocsContext = `## Account Notes, Meeting Transcripts & Recent Documents\n${docTexts.join('\n\n')}`
      }
      console.log(`[context-orchestrator] Drive scan: ${docTexts.length + bvaTexts.length} docs (${geminiNotes.length} Gemini notes, ${bvaTexts.length} BVA) for ${customer.name}`)
    }
  } catch (e: any) {
    console.warn(`[context-orchestrator] Drive folder scan failed for ${customer.name}:`, e.message)
  }

  return { driveDocsContext, bvaContext }
}

export function loadOrganizerIntent(slug: string): string {
  try {
    const emailCachePath = resolve(CACHE_DIR, `${slug}-emails.json`)
    if (!existsSync(emailCachePath)) return ''
    const emailData = JSON.parse(readFileSync(emailCachePath, 'utf-8'))
    const emails = emailData.data || emailData || []
    if (!Array.isArray(emails)) return ''

    const planningEmail = emails.find((e: any) => {
      const subj = (e.subject || '').toLowerCase()
      const from = (e.from || '').toLowerCase()
      const isCalendarInvite = subj.startsWith('invitation:') || subj.startsWith('updated invitation:') || subj.startsWith('canceled event:')
      const isAutoGenerated = from.includes('calendar-notification') || from.includes('gemini-notes')
      if (isCalendarInvite || isAutoGenerated) return false
      return subj.includes('next meeting') || subj.includes('next step') || subj.includes('agenda') || subj.includes('briefing') || subj.includes('planning') || (subj.includes('follow') && (subj.includes('up') || subj.includes('plan')))
    })
    if (!planningEmail) return ''

    let body = (planningEmail.bodyText || planningEmail.body || planningEmail.snippet || '').slice(0, 500)
    body = body.replace(/\n--\s*\n[\s\S]*/m, '').replace(/\nOn .* wrote:\s*\n[\s\S]*/m, '')
    body = body.replace(/\n(Thanks|Best|Regards|Cheers),?\s*\n[\s\S]*/mi, '')
    body = body.replace(/<https?:\/\/[^>]+>/g, '').replace(/\s{2,}/g, ' ')
    const firstPara = body.split(/\n\n/)[0] || body
    if (firstPara && firstPara.length > 20) return firstPara.replace(/\n+/g, ' ').trim()
    return ''
  } catch { return '' }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readPrepHistory(slug: string): any[] {
  const historyPath = resolve(CACHE_DIR, 'meeting-prep', `${slug}-history.json`)
  if (!existsSync(historyPath)) return []
  try { return JSON.parse(readFileSync(historyPath, 'utf-8')) } catch { return [] }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Main Orchestrator ───────────────────────────────────────────────────────

export async function buildConsumerContext(
  request: ConsumerContextRequest
): Promise<ConsumerContext> {
  const slug = toSlug(request.customer.name)
  const defaults = CONSUMER_DEFAULTS[request.consumerType] ?? {}
  const opts = { ...defaults, ...request.options }
  const provenance: ProvenanceEntry[] = []

  // ── Layer 1: Signals + templateAll ────────────────────────────────────────

  let signals: Signal[]
  if (opts.signals) {
    signals = opts.signals
    provenance.push({ source: 'signals-provided', loaded: true, tokenEstimate: 0 })
  } else {
    const signalResult = await loadCustomerSignals(slug, request.customer.name, { ensureFresh: true })
    signals = signalResult.registrySignals
    provenance.push({
      source: 'signal-loader',
      loaded: signals.length > 0,
      tokenEstimate: estimateTokens(JSON.stringify(signals)),
    })
  }

  const accountTeam = getAccountTeam(request.customer)
  const teamContext = toPromptContext(accountTeam)

  const templateResult = await templateAll(signals, accountTeam, {
    format: opts.format ?? consumerTypeToFormat(request.consumerType),
    productFilter: opts.productFilter,
    customerSlug: slug,
  })

  provenance.push({
    source: 'templateAll',
    loaded: !!templateResult.deterministic,
    tokenEstimate: estimateTokens(templateResult.deterministic + templateResult.narrativeContext),
  })

  // ── Layer 2: Documents & content ──────────────────────────────────────────

  let intelligenceContext: string | undefined
  if (opts.includeIntelligence) {
    intelligenceContext = (opts.preloadedIntelligence || loadIntelligenceContext(slug)) || undefined
    provenance.push({
      source: 'intelligence',
      loaded: !!intelligenceContext,
      tokenEstimate: estimateTokens(intelligenceContext ?? ''),
    })
  }

  let emailContext: string | undefined
  if (opts.includeEmail) {
    emailContext = loadEmailIntelligence(slug) || undefined
    provenance.push({
      source: 'email-intelligence',
      loaded: !!emailContext,
      tokenEstimate: estimateTokens(emailContext ?? ''),
    })
  }

  let driveDocsContext: string | undefined
  let bvaContext: string | undefined
  if (opts.preloadedDriveDocs) {
    driveDocsContext = opts.preloadedDriveDocs.driveDocsContext || undefined
    bvaContext = opts.preloadedDriveDocs.bvaContext || undefined
    provenance.push({ source: 'drive-docs', loaded: !!driveDocsContext, tokenEstimate: estimateTokens(driveDocsContext ?? '') })
    provenance.push({ source: 'bva', loaded: !!bvaContext, tokenEstimate: estimateTokens(bvaContext ?? '') })
  } else if (opts.includeDriveDocs || opts.includeBVA) {
    const driveResult = await loadDriveDocsContext(request.customer, slug)
    if (opts.includeDriveDocs) {
      driveDocsContext = driveResult.driveDocsContext || undefined
      provenance.push({
        source: 'drive-docs',
        loaded: !!driveDocsContext,
        tokenEstimate: estimateTokens(driveDocsContext ?? ''),
      })
    }
    if (opts.includeBVA) {
      bvaContext = driveResult.bvaContext || undefined
      provenance.push({
        source: 'bva',
        loaded: !!bvaContext,
        tokenEstimate: estimateTokens(bvaContext ?? ''),
      })
    }
  }

  let solutionPlaysContext: string | undefined
  if (opts.includeSolutionPlays !== false) {
    const plays = templateResult.structured?.solutionPlays ?? []
    if (plays.length > 0) {
      solutionPlaysContext = plays.map(p =>
        `- **${p.playName}** (${p.tdp}, ${p.confidence}): ${p.triggerTechnologies.join(', ')}${p.talkTrack ? `\n  Talk track: ${p.talkTrack.slice(0, 200)}` : ''}`
      ).join('\n')
    }
    provenance.push({
      source: 'solution-plays',
      loaded: !!solutionPlaysContext,
      tokenEstimate: estimateTokens(solutionPlaysContext ?? ''),
    })
  }

  // ── Layer 3: Meeting/interaction-specific ──────────────────────────────────

  let engagementTimeline: EngagementTimelineEntry[] | undefined
  if (opts.includeEngagementTimeline) {
    engagementTimeline = loadEngagementTimeline(slug)
    provenance.push({
      source: 'engagement-timeline',
      loaded: (engagementTimeline?.length ?? 0) > 0,
      tokenEstimate: estimateTokens(JSON.stringify(engagementTimeline ?? [])),
    })
  }

  let meetingHistoryContext: string | undefined
  const history = readPrepHistory(slug)
  if (history.length > 0) {
    const recentHistory = history.slice(0, 5)
    meetingHistoryContext = recentHistory.map((h: any) => {
      const date = new Date(h.meetingStart).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      const actions = (h.actionItems ?? []).slice(0, 3)
      const actionSummary = actions.length > 0
        ? ` — Key items: ${actions.join('; ')}`
        : ''
      return `- ${date}: "${h.meetingTitle}"${actionSummary}${h.docUrl ? ` [doc](${h.docUrl})` : ''}`
    }).join('\n')
    provenance.push({
      source: 'meeting-history',
      loaded: true,
      tokenEstimate: estimateTokens(meetingHistoryContext),
    })
  }

  let organizerContext: string | undefined
  if (request.consumerType === 'meeting-prep') {
    organizerContext = loadOrganizerIntent(slug) || undefined
    provenance.push({
      source: 'organizer-intent',
      loaded: !!organizerContext,
      tokenEstimate: estimateTokens(organizerContext ?? ''),
    })
  }

  // ── Infer product slugs ───────────────────────────────────────────────────

  let productSlugs = opts.productFilter ?? []
  if (productSlugs.length === 0) {
    try {
      const { readSheetCache } = await import('../cache-layer.ts')
      const subCache = readSheetCache(request.customer.name)
      if (subCache?.rows) {
        const nameToSlug: Record<string, string> = {
          'openshift': 'ocp', 'rhel': 'rhel', 'enterprise linux': 'rhel',
          'ansible': 'aap', 'satellite': 'satellite', 'quay': 'quay',
          'openshift ai': 'rhoai', 'developer hub': 'rhdh',
          'advanced cluster security': 'acs', 'advanced cluster management': 'acm',
        }
        const slugs: string[] = []
        const productNames = [...new Set(subCache.rows.map((r: any) => r.productDescription ?? '').filter(Boolean))] as string[]
        for (const name of productNames) {
          const lower = name.toLowerCase()
          for (const [key, val] of Object.entries(nameToSlug)) {
            if (lower.includes(key)) { slugs.push(val); break }
          }
        }
        productSlugs = [...new Set(slugs)]
      }
    } catch { /* no subscription data */ }
  }

  return {
    signalContext: templateResult.deterministic,
    signals,
    templateResult,
    accountTeam,
    teamContext,
    driveDocsContext,
    emailContext,
    bvaContext,
    intelligenceContext,
    solutionPlaysContext,
    meetingHistoryContext,
    organizerContext,
    engagementTimeline,
    provenance,
    productSlugs,
    slug,
  }
}
