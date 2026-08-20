/**
 * HTML Template Generator for ContentCampaign
 * Matches the gold standard output from ContentCampaign skill
 *
 * Gold standard: test/fixtures/campaign-gold-standard.html
 * Convergence test: test/unit/campaign-gold-standard.test.ts
 */

import type { AccountTeamMember } from './types.ts'
import { escapeHtml, applyInlineFormatting } from './lib/markdown-to-html.ts'
import { resolveFeatureUrl, resolveFeatureEntry } from './lib/feature-url-registry.ts'
import type { FeatureRegistryEntry } from './lib/feature-url-registry.ts'
import { getVoiceTokens } from './ae-voice.ts'
import type { VoiceProfile } from './ae-voice.ts'
import type { Signal } from './feature-module-registry.ts'
import type { CustomerObjectiveProfile, ObjectiveCategory } from './modules/intelligence-module.ts'
import { parseSections } from './modules/intelligence-module.ts'
import { classifyPersona } from './lib/persona-classifier.ts'
import { runEmailQualityCheck, renderQualityChecklist, type EmailQualityResult, type EmailCheckInput } from './lib/email-quality-checks.ts'
import { type BlockOutput, type MetricRef, validateBlock, extractLinks, toBlock } from './lib/block-output.ts'
import { isInternalUrl, isHomepageUrl, isolateLinks, restoreLinks, LinkRegistry } from './lib/link-registry.ts'
import { callGemini } from './gemini-call.ts'

const BRAND_RED = '#c41e3a'
const SPECULATION_PATTERN = /\b(likely|suggests|indicates|probably|appears|implies|may include|current use|operational reliance|technical requirements|infrastructure strategy)\b|existing\s.*(?:portfolio|tools|automation)|e\.g\.,/i

// ── Exported types for campaign data ──

export interface CampaignContact {
  name: string
  title: string
  email?: string
  linkedIn?: string
  signal?: string
  priority?: string
}

export interface ReferenceMaterial {
  resource: string
  url?: string
  keyTakeaway: string
}

export interface EligibilityRow {
  offering: string
  deployment: string
  status: string
}

export interface BVTalkingPoint {
  objective: string
  talkingPoints: string
  keyMetrics: string
}

export interface CampaignFootprint {
  current: string
  expansion: string
}

// ── Signal types (used by internal helper functions) ──

interface CampaignSignals {
  productIntel?: any
  intelligence?: any
  customerDocs?: any
  dailyBrief?: any
  subscriptions?: any
  emails?: any
  cases?: any
  accountPlan?: string
}

// ── Utility functions ──

/**
 * Truncate text at the last complete sentence within maxChars.
 * Prevents mid-word truncation (#1147).
 */
function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  // Find the last sentence boundary (. ! ?) within the limit
  const upToLimit = text.slice(0, maxChars)
  const boundaries = [
    upToLimit.lastIndexOf('. '),
    upToLimit.lastIndexOf('! '),
    upToLimit.lastIndexOf('? ')
  ]
  const lastBoundary = Math.max(...boundaries)

  if (lastBoundary > 0) {
    // Return text up to and including the punctuation (but not the space after)
    return text.slice(0, lastBoundary + 1)
  }

  // No sentence boundary found - truncate at last word boundary to avoid mid-word cut
  const lastSpace = upToLimit.lastIndexOf(' ')
  if (lastSpace > maxChars * 0.5) {
    // Only use word boundary if we're at least halfway through the limit
    return upToLimit.slice(0, lastSpace) + '…'
  }

  // Last resort: just truncate at limit with ellipsis
  return upToLimit + '…'
}

function repairTruncatedCurrency(text: string, fullSource?: string): string {
  // If text ends with a bare dollar amount ($39, $2.5), try to restore the unit from fullSource
  const trailingDollar = text.match(/\$[\d,.]+\s*[…]?$/)
  if (!trailingDollar) return text
  if (fullSource) {
    const dollarVal = trailingDollar[0].replace(/[…\s]/g, '')
    const unitMatch = fullSource.match(new RegExp(`\\${dollarVal.replace('.', '\\.')}\\s*(million|billion|M|B)\\b`, 'i'))
    if (unitMatch) {
      return text.replace(/[…]?$/, '') + ` ${unitMatch[1]}`
    }
  }
  // Heuristic: bare dollar amounts without "million/billion" are almost always truncated
  const amt = parseFloat(trailingDollar[0].replace(/[$,…]/g, ''))
  if (amt > 0 && amt < 1000 && !text.match(/\$[\d,.]+\s*(?:million|billion|M|B)\b/i)) {
    return text.replace(/[…]?$/, '') + ' million'
  }
  return text
}

function convertMarkdownBullets(text: string): string {
  const lines = text.split('\n')
  let html = ''
  let inBulletList = false

  for (const line of lines) {
    const bulletMatch = line.match(/^[•\-*]\s+(.+)$/)
    if (bulletMatch) {
      if (!inBulletList) {
        inBulletList = true
      }
      const bulletText = applyInlineFormatting(bulletMatch[1])
      html += `<p style="font-size: 15px; padding: 4px 0 4px 24px; margin: 4px 0; position: relative;"><span style="position: absolute; left: 8px; color: ${BRAND_RED}; font-size: 18px;">•</span>${bulletText}</p>\n`
    } else {
      if (inBulletList && line.trim() === '') {
        inBulletList = false
      }
      if (line.trim().length > 0) {
        const formattedLine = applyInlineFormatting(line)
        html += `<p style="font-size: 15px; margin: 0 0 10px 0;">${formattedLine}</p>\n`
      }
    }
  }

  return html
}

function extractMetrics(signals?: CampaignSignals, objectiveProfile?: CustomerObjectiveProfile): {
  revenue: string
  employees: string
  productInstances: string
  productName: string
} {
  const defaults = {
    revenue: '—',
    employees: '—',
    productInstances: '—',
    productName: 'Product',
  }

  // Priority 1: objective profile financial entries (pre-parsed, most reliable)
  // Two-pass approach: annual first, then fallback to generic revenue
  let profileRevenue: string | null = null
  if (objectiveProfile?.financial) {
    // First pass: ONLY annual/FY/full-year revenue (exclude quarterly patterns)
    for (const entry of objectiveProfile.financial) {
      const text = entry.objective || ''
      // Skip quarterly entries (Q1, Q2, Q3, Q4, quarterly)
      if (/\bQ[1-4]\b|\bquarterly\b/i.test(text)) continue

      const m = text.match(/\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
      // Match ONLY if it has annual/FY/full-year markers
      if (m && /\b(?:annual|full[- ]year|FY\s*\d{4})\b/i.test(text)) {
        profileRevenue = `$${m[1]}`
        break
      }
    }

    // Second pass: fallback to generic "revenue" if no annual found (still exclude quarterly)
    if (!profileRevenue) {
      for (const entry of objectiveProfile.financial) {
        const text = entry.objective || ''
        // Skip quarterly entries
        if (/\bQ[1-4]\b|\bquarterly\b/i.test(text)) continue

        const m = text.match(/\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
        if (m && /revenue/i.test(text)) {
          profileRevenue = `$${m[1]}`
          break
        }
      }
    }
  }

  const intel = signals?.intelligence
  if (!intel && !profileRevenue) return defaults

  const companyText = typeof intel === 'string' ? intel : (intel?.company || '')

  // Priority 2: regex on intelligence text — annual/FY markers first, then generic
  const revenueMatch = !profileRevenue ? (
    companyText.match(/(?:annual|full[- ]year|FY\s*\d{4})[^$]*\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
    || companyText.match(/record revenue of \$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
    || companyText.match(/revenue[^$]*\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
    || companyText.match(/\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
  ) : null

  const employeesMatch = companyText.match(/approximately\s+([\d,]+)\s*employees/i)
    || companyText.match(/([\d,]+)\s+employees/i)
    || companyText.match(/employ\w*\s+(?:approximately\s+)?([\d,]+)\s*(?:individuals|people|workers|staff)/i)

  let productInstances = defaults.productInstances
  let productName = defaults.productName
  if (signals?.subscriptions) {
    const subs = signals.subscriptions
    const rows = Array.isArray(subs) ? subs : (subs.rows || subs.data || [])
    if (Array.isArray(rows) && rows.length > 0) {
      const active = rows.filter((s: any) => s.status === 'Active')
      const totalQty = active.reduce((sum: number, s: any) => sum + (Number(s.quantity) || 0), 0)
      if (totalQty > 0) {
        productInstances = String(totalQty)
        const firstActive = active[0]
        const desc = firstActive?.productDescription || firstActive?.product || firstActive?.sku || 'Product'
        productName = resolveProductDisplayName(desc)
      }
    }
  }

  return {
    revenue: profileRevenue ?? (revenueMatch?.[1] ? `$${revenueMatch[1]}` : defaults.revenue),
    employees: employeesMatch?.[1] ?? defaults.employees,
    productInstances,
    productName,
  }
}

function extractStructuredIntel(signals?: CampaignSignals, objectiveProfile?: CustomerObjectiveProfile): {
  initiatives: Array<{ name: string; priority: string; detail: string }>
  competitors: Array<{ name: string; threat: string; advantage: string }>
  differentiation?: string
} {
  const result = {
    initiatives: [] as Array<{ name: string; priority: string; detail: string }>,
    competitors: [] as Array<{ name: string; threat: string; advantage: string }>,
    differentiation: undefined as string | undefined,
  }

  const intel = signals?.intelligence
  const companyText = typeof intel === 'string' ? intel : (intel?.company || '')

  const competitorSection = companyText.match(/## Competitive Landscape[\s\S]*?(?=\n## |$)/i)
  if (competitorSection) {
    const section = competitorSection[0]

    const diffMatch = section.match(/differentiates?\s+(?:itself\s+)?(?:through|by|with)\s+([\s\S]*?)(?=\n\n|Switching costs)/i)
    const differentiation = diffMatch?.[1]?.trim().split('.')[0] || ''

    const numberedRegex = /\d+\.\s+\*\*([^*:]+?)(?::?\*\*):?\s*([\s\S]*?)(?=\n\s*\d+\.\s+\*\*|\n##|$)/gs
    let match
    while ((match = numberedRegex.exec(section)) !== null) {
      const name = match[1].trim().replace(/[,.]$/, '')
      const fullDesc = match[2].trim()
      const sentences = fullDesc.split(/\.\s+/)
      const threat = sentences[0]?.trim() || ''
      const advMatch = fullDesc.match(/differenti\w+\s+(?:with|by|through|often\s+lies?\s+in)\s+([^.]+)/i)
        || fullDesc.match(/(?:advantage|strength|known for)\s+(?:is|lies in|with)\s+([^.]+)/i)
      const advantage = advMatch?.[1]?.trim() || (sentences.length > 1 ? sentences[1]?.trim() : '')
      if (name.length > 1 && name.length < 50 && !name.includes('Competitive')) {
        result.competitors.push({ name, threat, advantage })
      }
    }

    if (result.competitors.length === 0) {
      const boldBulletRegex = /[*\-]\s+\*\*([^*]+?)\*\*:?\s*(.*)/gm
      while ((match = boldBulletRegex.exec(section)) !== null) {
        const name = match[1].trim().replace(/:$/, '')
        const fullDesc = match[2].trim()
        const sentences = fullDesc.split(/\.\s+/)
        const threat = sentences[0]?.trim() || ''
        const advMatch = fullDesc.match(/differenti\w+\s+(?:with|by|through|often\s+lies?\s+in)\s+([^.]+)/i)
          || fullDesc.match(/(?:advantage|strength|known for)\s+(?:is|lies in|with)\s+([^.]+)/i)
        const advantage = advMatch?.[1]?.trim() || (sentences.length > 1 ? sentences[1]?.trim() : '')
        if (name.length > 1 && name.length < 50 && !name.match(/^(switching|integrated|specialized|established|market|competitive)/i)) {
          result.competitors.push({ name, threat, advantage })
        }
        if (result.competitors.length >= 5) break
      }
      if (result.competitors.length === 0) {
        const plainBulletRegex = /[*\-]\s+([^*\n]{2,49})$/gm
        while ((match = plainBulletRegex.exec(section)) !== null) {
          const name = match[1].trim()
          if (!name.match(/^(switching|integrated|specialized|established|market)/i)) {
            result.competitors.push({ name, threat: '', advantage: '' })
          }
          if (result.competitors.length >= 5) break
        }
      }
      if (differentiation) {
        result.differentiation = differentiation
      }
    }
  }

  // Priority 0: Read initiatives from CustomerObjectiveProfile (ADR-044)
  const NON_INITIATIVE = /\b(termination|resigned|departed|layoff|hired|appointed|guidance|raised.*guidance|lowered.*guidance|earnings|quarterly results)\b/i
  if (objectiveProfile) {
    const profileInitiatives = [
      ...objectiveProfile.security.filter(e => e.source === 'Strategic Initiatives'),
      ...objectiveProfile.operational.filter(e => e.source === 'Strategic Initiatives'),
      ...objectiveProfile.innovation.filter(e => e.source === 'Strategic Initiatives'),
      ...objectiveProfile.growth.filter(e => e.source === 'Strategic Initiatives'),
    ].filter(e => !NON_INITIATIVE.test(e.objective))
    for (const entry of profileInitiatives) {
      if (result.initiatives.length >= 5) break
      const name = entry.objective.split(' — ')[0].trim()
      const detail = entry.objective.includes(' — ') ? entry.objective.split(' — ').slice(1).join(' — ').trim() : ''
      const priority = entry.priority || 'MED'
      result.initiatives.push({ name, priority, detail })
    }
  }

  // Priority 1: Extract initiatives from account plan (has Red Hat product mapping)
  const planText = signals?.accountPlan || ''
  if (planText && result.initiatives.length === 0) {
    // Try parsing as markdown sections first (for structured account plans)
    const sections = parseSections(planText)
    const initiativesSection = sections['IT and Modernization Initiatives']
      || sections['Initiatives']
      || sections['Strategic Initiatives']

    if (initiativesSection) {
      // Parse bold bullet items with product mapping (e.g., "Initiative Name: Description → RHEL AI, OpenShift AI")
      const boldItemRegex = /[*\-]\s+\*\*([^*]+?)\*\*:?\s*([^→\n]+)(?:→\s*([^\n]+))?/gm
      let match
      while ((match = boldItemRegex.exec(initiativesSection)) !== null) {
        const name = match[1].trim().replace(/:$/, '')
        const description = match[2].trim()
        const products = match[3]?.trim() || ''

        // Include product mapping in detail if available
        const detail = products ? `${description} → ${products}` : description

        const DEAL_SUMMARY_PATTERN = /^(Red Hat Solution|Estimated Deal Size|Timeline|Next Steps|Customer Objective Addressed|Tagged Potential.*|Mapping.*|Account|Why Red Hat)$/i
        if (name.length > 5 && name.length < 80 && !DEAL_SUMMARY_PATTERN.test(name)) {
          result.initiatives.push({ name, priority: 'MED', detail })
        } else if (DEAL_SUMMARY_PATTERN.test(name)) {
          console.warn(`[campaign-template] Filtered deal-summary field from initiatives: "${name}"`)
        }
        if (result.initiatives.length >= 5) break
      }
    }

    // Fall back to regex matching for less structured account plans
    if (result.initiatives.length === 0) {
      const objectivesSection = planText.match(/Strategic Objectives:[\s\S]*?(?=\n\s*\*\*Mapping|$)/i)
        || planText.match(/Why Red Hat[\s\S]*?Strategic Objectives:[\s\S]*?(?=\n\s*\*\*Mapping|$)/i)
        || planText.match(/Modernization Initiatives[\s\S]*?(?=\n##\s|$)/i)
        || planText.match(/Why Red Hat\?[\s\S]*?(?=\n##\s|$)/i)
      if (objectivesSection) {
        const objectiveRegex = /\*\*([^*]+)\*\*:?\s*([^*\n]+)/g
        let objMatch
        while ((objMatch = objectiveRegex.exec(objectivesSection[0])) !== null) {
          const name = objMatch[1].trim()
          const detail = objMatch[2].trim()
          const DEAL_SUMMARY_PATTERN2 = /^(Red Hat Solution|Estimated Deal Size|Timeline|Next Steps|Customer Objective Addressed|Tagged Potential.*|Mapping.*|Account|Why Red Hat)$/i
          if (name.length > 5 && name.length < 80 && !DEAL_SUMMARY_PATTERN2.test(name)) {
            result.initiatives.push({ name, priority: 'MED', detail })
          }
          if (result.initiatives.length >= 5) break
        }
      }
    }
  }

  // Priority 2: Fall back to intelligence doc if no account plan initiatives
  if (result.initiatives.length === 0) {
    const intelInitSection = companyText.match(/## Strategic Initiatives[\s\S]*?(?=\n## |$)/i)
    if (intelInitSection) {
      const boldItemRegex = /[*\-]\s+\*\*([^*]+?)\*\*:?\s*(.*)/gm
      let iiMatch
      while ((iiMatch = boldItemRegex.exec(intelInitSection[0])) !== null) {
        const name = iiMatch[1].trim().replace(/:$/, '')
        const detail = iiMatch[2].trim().split(/\.\s+/)[0] || ''
        if (name.length > 5 && name.length < 80 && !name.match(/buying urgency|confidence/i)) {
          const urgencyMatch = iiMatch[2].match(/Buying Urgency:\s*(HIGH|MEDIUM|MED|LOW)/i)
          const priority = urgencyMatch ? (urgencyMatch[1].toUpperCase().startsWith('H') ? 'HIGH' : 'MED') : 'HIGH'
          result.initiatives.push({ name, priority, detail })
        }
        if (result.initiatives.length >= 5) break
      }
    }
  }

  return result
}

// ── Section renderers ──

function renderContactsSection(contacts: CampaignContact[]): string {
  if (contacts.length === 0) return ''
  const hasEmail = contacts.some(c => c.email)
  const hasLinkedIn = contacts.some(c => c.linkedIn)
  const hasSignal = contacts.some(c => c.signal)

  return `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 16px 0 12px 0;">👥 Target Contacts</h2>
<table width="100%" cellpadding="6" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Name</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Title</td>
    ${hasEmail ? '<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Email</td>' : ''}
    ${hasLinkedIn ? '<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">LinkedIn</td>' : ''}
    ${hasSignal ? '<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Signal</td>' : ''}
  </tr>
  ${contacts.map(c => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHtml(c.name)}</td>
    <td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(c.title)}</td>
    ${hasEmail ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(c.email || '—')}</td>` : ''}
    ${hasLinkedIn ? `<td style="border-bottom: 1px solid #e8eaed;">${c.linkedIn ? `<a href="${escapeHtml(c.linkedIn)}" style="color: #1a73e8;">Profile</a>` : '—'}</td>` : ''}
    ${hasSignal ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(c.signal || '—')}</td>` : ''}
  </tr>`).join('\n')}
</table>`
}

function renderFitRationale(customerName: string, content: string): string {
  return `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">📋 Why ${escapeHtml(customerName)} Is a Strong Fit</h3>
<div style="font-size: 15px; color: #5f6368; margin: 0 0 20px 0;">${convertMarkdownBullets(content)}</div>`
}

export function renderFitFromPass0(customerName: string, pass0Briefs: import('./lib/persona-selector.ts').PersonaBrief[]): string {
  const timingTriggers = pass0Briefs.map(b => b.timingTrigger).filter(Boolean)
  const valueProps = pass0Briefs.map(b => b.valueProposition).filter(Boolean)
  const rawBases = pass0Briefs.map(b => b.installedBase).filter(Boolean)
  const installedBases = [...new Set(rawBases
    .filter((b: string) => {
      if (customerName && (b.includes(customerName) || (customerName.split(/\s+/)[0].length > 2 && b.startsWith(customerName.split(/\s+/)[0] + ' ')))) return false
      if (b.length > 40 && SPECULATION_PATTERN.test(b)) return false
      if (b.length > 120 && !b.includes(',')) return false
      return true
    })
    .map((b: string) => sanitizeCreepyLines(b))
    .filter((b: string) => b.length > 0)
  )]
  const objectives = pass0Briefs.map(b => b.objectiveMatch).filter(Boolean)
    .map((o: string) => { const s = o.split(/[.!]/)[0]; return truncateAtSentence(s, 300) })

  let html = `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">📋 Why ${escapeHtml(customerName)} Is a Strong Fit</h3>`
  html += '<div style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">'

  if (timingTriggers.length > 0) {
    html += `<p style="margin: 8px 0;"><strong>What's happening now:</strong> ${escapeHtml(timingTriggers[0])}</p>`
  }
  if (valueProps.length > 0) {
    html += `<p style="margin: 8px 0;"><strong>Campaign relevance:</strong> ${escapeHtml(valueProps[0])}</p>`
  }
  if (installedBases.length > 0) {
    html += `<p style="margin: 8px 0;"><strong>Product alignment:</strong> ${escapeHtml(installedBases.join('; '))}</p>`
  }
  if (objectives.length > 0) {
    html += `<p style="margin: 8px 0;"><strong>Business context:</strong> ${escapeHtml(objectives[0])}</p>`
  }

  html += '</div>'
  return html
}

function renderReferenceMaterials(materials: ReferenceMaterial[], heading: string): string {
  return `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">📚 ${escapeHtml(heading)}</h3>
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Resource</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Key Takeaway</td>
  </tr>
  ${materials.map(m => {
    return `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${m.url ? `<a href="${escapeHtml(m.url)}" style="color: #1a73e8;">${escapeHtml(m.resource)}</a>` : escapeHtml(m.resource)}</td>
    <td style="border-bottom: 1px solid #e8eaed; font-size: 13px; color: #5f6368;">${escapeHtml(m.keyTakeaway.length > 250 ? truncateAtSentence(m.keyTakeaway, 250) : m.keyTakeaway)}</td>
  </tr>`
  }).join('\n')}
</table>`
}

function renderEligibilityTable(rows: EligibilityRow[], heading: string): string {
  return `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚖️ ${escapeHtml(heading)}</h3>
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Offering</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Deployment</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Status</td>
  </tr>
  ${rows.map(r => {
    const statusColor = /exempt/i.test(r.status) ? '#137333' : /taxable/i.test(r.status) ? '#c5221f' : '#b45309'
    const statusBg = /exempt/i.test(r.status) ? '#e6f4ea' : /taxable/i.test(r.status) ? '#fce8e6' : '#fef7e0'
    return `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHtml(r.offering)}</td>
    <td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(r.deployment)}</td>
    <td style="border-bottom: 1px solid #e8eaed;"><span style="background: ${statusBg}; color: ${statusColor}; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${escapeHtml(r.status)}</span></td>
  </tr>`
  }).join('\n')}
</table>`
}

function renderFootprintSection(footprint: CampaignFootprint): string {
  return `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">🔵 Existing Red Hat Footprint</h3>
<div style="font-size: 14px; margin: 0 0 20px 0;">
  <p style="margin: 4px 0;"><strong>Current:</strong> ${escapeHtml(sanitizeFootprint(footprint.current))}</p>
  <p style="margin: 4px 0;"><strong>Expansion:</strong> ${escapeHtml(sanitizeFootprint(footprint.expansion))}</p>
</div>`
}

function renderBVTalkingPoints(points: BVTalkingPoint[]): string {
  return `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 16px 0 12px 0;">💬 Call Prep — Key Talking Points</h2>
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Objective</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Talking Points</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Key Metrics</td>
  </tr>
  ${points.map(p => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHtml(p.objective)}</td>
    <td style="border-bottom: 1px solid #e8eaed; font-size: 13px;">${escapeHtml(p.talkingPoints)}</td>
    <td style="border-bottom: 1px solid #e8eaed; font-size: 13px; color: #5f6368;">${escapeHtml(p.keyMetrics)}</td>
  </tr>`).join('\n')}
</table>`
}


// ── Campaign Title Cleaner (extracted to src/lib/text-utils.ts) ───────────
export { cleanEmailSubject as cleanCampaignTitle } from './lib/text-utils.ts'

// ── Contact Quality Check (extracted to src/lib/contact-quality.ts) ──────
export { isRealPersonName } from './lib/contact-quality.ts'

// ── Footprint Sanitizer ───────────────────────────────────────────────────

export function sanitizeFootprint(text: string): string {
  if (!text) return ''
  return text
    .replace(/\bNN-/g, '')
    .replace(/\s*—\s*Pipeline\b/gi, '')
    .replace(/Company intelligence for [^,;.]+[,;.]?\s*/gi, '')
    .replace(/Industry analysis:\s*[^,;.]+[,;.]?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ── Creepy-Line Sanitizer ──────────────────────────────────────────────────
// Strips NEVER-category internal data from customer-facing text.
// Operates at sentence level: if a sentence matches, the whole sentence is removed.

const CREEPY_SENTENCE_PATTERNS = [
  /pipeline\s+opportunit/i,
  /pipeline\s+value/i,
  /\$\d[\d,.]*[kKmMbB]?\s+pipeline/i,
  /\$\d[\d,.]*[kKmMbB]?\s+deal/i,
  /pending\s+\$/i,
  /support\s+case/i,
  /support\s+ticket/i,
  /case\s+#\d/i,
  /ticket\s+#\d/i,
  /\d+\s+(?:RHEL\s+)?subscriptions?\b/i,
  /\d+\s+nodes?\b/i,
  /\d+\s+instances?\b/i,
  /subscription\s+count/i,
  /laid\s+off\s+\d/i,
  /headcount\s+reduction/i,
  /workforce\s+reduction/i,
  /\$\d[\d,.]*[kKmMbB]?\s+renewal/i,
  /renewal\s+of\s+\$/i,
  /\bCase\s+\d{4,}/i,
  /\bCS-\d{3,}/i,
  /\bescalation\s+#?\d/i,
]

const SKU_PATTERN = /\b[A-Z]{2,4}\d{4,6}\b/g

export function sanitizeCreepyLines(text: string): string {
  if (!text) return ''

  const sentences = text.split(/(?<=\.)\s+|\n/)
  const cleaned = sentences
    .filter(sentence => !CREEPY_SENTENCE_PATTERNS.some(p => p.test(sentence)))
    .map(sentence => sentence.replace(SKU_PATTERN, '').replace(/\s{2,}/g, ' ').trim())
    .filter(s => s.length > 0)

  // Fail-closed: when ALL sentences match creepy patterns, return empty string (#1096)
  if (cleaned.length === 0) return ''

  let result = cleaned.join(' ')
  result = result.replace(/\.\s*\./g, '.')
  // Preserve trailing period if original had one
  if (text.trimEnd().endsWith('.') && !result.trimEnd().endsWith('.')) result += '.'
  return result
}

// ── Objective Prefix Stripper (#1132) ─────────────────────────────────────

export function cleanObjectivePrefix(text: string): string {
  if (!text) return ''

  let cleanText = text.trim()

  // Strip common category prefixes with colons
  cleanText = cleanText.replace(/^(?:Revenue Trajectory|Profitability|Balance Sheet|Financial Health|Growth Outlook|Reiterated[^:]*?|Cybersecurity Enhancement|Security Initiative|Operational Efficiency|Innovation Focus|Growth Strategy)[:\s]+/i, '')

  // Strip "Raised/Lowered/Maintained Full-Year YYYY Guidance —" patterns (start of string)
  cleanText = cleanText.replace(/^(?:Raised|Lowered|Maintained|Updated|Revised)\s+Full[- ]Year\s+\d{4}\s+Guidance\s*[—–]\s*/i, '')
  // Also strip mid-sentence: "With NN% Raised Full-Year YYYY Guidance — description."
  cleanText = cleanText.replace(/(?:With\s+)?[\d.%-]+\s+(?:Raised|Lowered|Maintained|Updated|Revised)\s+Full[- ]Year\s+\d{4}\s+Guidance\s*[—–]\s*[^.]*\.\s*/gi, '')

  // Strip "Category Name —" patterns (e.g., "Major Acquisition —", "New Partnership —")
  cleanText = cleanText.replace(/^(?:Acquisition of|Major|New|Strong|Strategic|Key)\s+[A-Z][^—–]*?\s*[—–]\s*/i, '')

  // AC-4: Strip "As [Initiative] — [Description]" format from email body (#1124)
  cleanText = cleanText.replace(/^As\s+[^—–]+?\s*[—–]\s*/i, '')

  return cleanText.trim()
}

// ── Metrics Table Rendering (ADR-044 Phase 4) ────────────────────────────

export interface UsedObjective {
  objective: string
  metric: string | null
  category: string
  usedIn: string
}

const ROLE_LABELS: Record<string, string> = {
  'executive-sponsor': 'Executive',
  'technical-evaluator': 'Technical',
  'champion': 'Champion',
  'financial-gatekeeper': 'Financial',
  'practitioner': 'Practitioner',
}

export function renderMetricsTable(usedObjectives: UsedObjective[], pass0Briefs?: import('./lib/persona-selector.ts').PersonaBrief[]): string {
  if (pass0Briefs && pass0Briefs.length > 0 && usedObjectives.length === 0) {
    let html = '<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">Business Metrics Used in Outreach</h3>'
    html += '<table width="100%" cellpadding="6" cellspacing="0" style="border: 1px solid #dadce0; font-size: 13px;">'
    html += '<tr style="background: #f8f9fa; font-weight: bold;"><td>Category</td><td>Metric</td><td>Used In</td></tr>'
    for (const brief of pass0Briefs) {
      const label = ROLE_LABELS[brief.role] || brief.role
      const metric = truncateAtSentence(brief.objectiveMatch.split(/[.;]/)[0]?.trim() || brief.objectiveMatch, 120)
      html += `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(metric)}</td><td>${escapeHtml(brief.suggestedTitle)}</td></tr>`
    }
    html += '</table>'
    return html
  }

  if (usedObjectives.length === 0) return ''

  const seen = new Set<string>()
  const deduped = usedObjectives.filter(e => {
    const key = e.metric || e.objective
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let html = '<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">Business Metrics Used in Outreach</h3>'
  html += '<table width="100%" cellpadding="6" cellspacing="0" style="border: 1px solid #dadce0; font-size: 13px;">'
  html += '<tr style="background: #f8f9fa; font-weight: bold;"><td>Category</td><td>Metric</td><td>Used In</td></tr>'
  for (const e of deduped) {
    html += `<tr><td>${escapeHtml(e.category)}</td><td>${escapeHtml(e.objective)}</td><td>${escapeHtml(e.usedIn)}</td></tr>`
  }
  html += '</table>'
  return html
}

const INTERNAL_SIGNAL_PATTERN = /terminat|resign|restructur|layoff/i

// ── Objective Block Rendering (ADR-044) ───────────────────────────────────

export function renderObjectiveBlock(
  profile: CustomerObjectiveProfile | undefined,
  campaignTheme: { threat: string; solution: string },
  recipientTitle?: string,
  preMatch?: import('./lib/persona-classifier.ts').PreMatchedMetric,
): string {
  const renderTemplate = (category: string, objective: string) => {
    let cleanObj = objective.trim()

    // Strip common category prefixes with colons
    cleanObj = cleanObj.replace(/^(?:Revenue Trajectory|Profitability|Balance Sheet|Financial Health|Growth Outlook|Reiterated[^:]*?|Cybersecurity Enhancement|Security Initiative|Operational Efficiency|Innovation Focus|Growth Strategy)[:\s]+/i, '')

    // Strip "Raised/Lowered/Maintained Full-Year YYYY Guidance —" patterns
    cleanObj = cleanObj.replace(/^(?:Raised|Lowered|Maintained|Updated|Revised)\s+Full[- ]Year\s+\d{4}\s+Guidance\s*[—–]\s*/i, '')

    // Strip "Category Name —" patterns (e.g., "Major Acquisition —", "New Partnership —")
    cleanObj = cleanObj.replace(/^(?:Acquisition of|Major|New|Strong|Strategic|Key)\s+[A-Z][^—–]*?\s*[—–]\s*/i, '')

    // Strip any remaining "Word/Phrase —" at start (fallback for unlisted category prefixes)
    cleanObj = cleanObj.replace(/^[A-Z][^—–:]*?\s*[—–]\s*/, '')

    cleanObj = cleanObj.trim()

    const rawObjText = cleanObj.length > 80
      ? truncateAtSentence(cleanObj.split(/[.;]/)[0]?.trim() || cleanObj, 80)
      : cleanObj
    let objText = repairTruncatedCurrency(rawObjText, objective)
    if (/^\$[\d,.]+\s*(?:million|billion|[BMK])?$/i.test(objText.trim())) {
      const qualifierMatch = objective.match(/\$[\d,.]+\s*(?:million|billion|[BMK])?\s+(?:in\s+)?(\w+(?:\s+\w+)?)/i)
      const qualifier = qualifierMatch?.[1]?.match(/^(?:revenue|budget|spend|ARR|investment|acquisition|deal|contract)/i)?.[0]
      objText = qualifier ? `${objText.trim()} in ${qualifier.toLowerCase()}` : `${objText.trim()} in annual investment`
    }
    const { threat, solution } = campaignTheme
    const templates: Record<string, string> = {
      financial: `With ${objText}, ${threat} creates a direct headwind — ${solution} protects this trajectory.`,
      security: `Given ${objText}, ${threat} becomes a strategic exposure — ${solution} reduces this surface.`,
      operational: `With ${objText} underway, ${threat} adds operational overhead — ${solution} consolidates this.`,
      innovation: `As ${objText} accelerates, ${threat} could constrain progress — ${solution} keeps this on track.`,
      growth: `With ${objText}, ${threat} introduces friction — ${solution} removes this barrier.`,
    }
    return templates[category] || ''
  }

  if (preMatch) {
    const rawText = preMatch.entry.metric
      ? `${preMatch.entry.metric} ${preMatch.entry.objective.replace(/^[^:]+:\s*/, '').replace(preMatch.entry.metric, '').trim()}`
      : preMatch.entry.objective
    const text = repairTruncatedCurrency(rawText, preMatch.entry.objective)
    return renderTemplate(preMatch.category, text)
  }

  if (!profile) return ''

  const filterUsable = (entries: typeof allEntries) =>
    entries.filter(e => e.priority !== 'LOW' && !INTERNAL_SIGNAL_PATTERN.test(e.objective))

  const allEntries = [
    ...profile.financial.map(e => ({ ...e, category: 'financial' as const })),
    ...profile.security.map(e => ({ ...e, category: 'security' as const })),
    ...profile.operational.map(e => ({ ...e, category: 'operational' as const })),
    ...profile.innovation.map(e => ({ ...e, category: 'innovation' as const })),
    ...profile.growth.map(e => ({ ...e, category: 'growth' as const })),
  ]

  if (allEntries.length === 0) return ''

  let selected: typeof allEntries[0]
  if (recipientTitle) {
    const classification = classifyPersona({ name: '', title: recipientTitle })
    let matched: typeof allEntries[0] | undefined
    for (const { category: cat } of classification.categories) {
      const catEntries = filterUsable(profile[cat].map(e => ({ ...e, category: cat })))
      if (catEntries.length > 0) { matched = catEntries[0]; break }
    }
    if (matched) {
      selected = matched
    } else {
      const usable = filterUsable(allEntries)
      selected = usable.length > 0 ? usable[0] : allEntries[0]
    }
  } else {
    const usable = filterUsable(allEntries)
    selected = usable.length > 0 ? usable[0] : allEntries[0]
  }

  return renderTemplate(selected.category, selected.objective)
}

// ── Two-Pass Template Engine (ADR-043) ──────────────────────────────────────
// Pass 2: Deterministic email assembly from Gemini's data selections.
// No LLM involved — pure functions compose 8 blocks into emails.

// Local mirror of CampaignSelectionResult to avoid circular import with campaign-service.ts
export interface StructuredEmailSelection {
  recipientName: string
  tier: 'executive' | 'manager'
  intent: 'nurture' | 'expand' | 're-engage'
  subject: string
  signalIndex: number
  featureKeys: string[]
  peerProof: { playName: string; exampleIndex: number } | null
}

export interface StructuredCampaignSelection {
  campaignSummary: string
  customerContext: string
  positioning: string
  emails: StructuredEmailSelection[]
}

export interface ResolvedExec {
  name: string
  title: string
  email?: string
  linkedIn?: string
}

export interface StructuredPlay {
  name: string
  parentTdp: string
  customerWins?: string[]
  realWorldExamples?: Array<{ customer: string; outcome: string }>
  extractedMetrics?: Array<{ value: string; context: string }>
  talkTrack?: string
}

export interface StructuredCampaignData {
  resolvedExecs: ResolvedExec[]
  signals: Signal[]
  voiceProfile: VoiceProfile | null
  accountTeam: AccountTeamMember[]
  subscriptions: Array<{ product?: string; productDescription?: string; sku?: string; status?: string; quantity?: number }>
  structuredPlays: StructuredPlay[]
  customerName: string
  materialTitle: string
  materialUrl: string
  generatedDate: string
  rawSignals?: { productIntel?: any; intelligence?: any; customerDocs?: any; dailyBrief?: any; subscriptions?: any; emails?: any; cases?: any; accountPlan?: string }
  fitRationale?: string
  referenceMaterials?: ReferenceMaterial[]
  referenceMaterialsHeading?: string
  eligibilityTable?: EligibilityRow[]
  eligibilityHeading?: string
  footprint?: CampaignFootprint
  bvTalkingPoints?: BVTalkingPoint[]
  signalsLoaded?: string[]
  sourceAttributions?: Array<{ name: string; description: string }>
  aeEmail?: string
  aePhone?: string
  linkRegistry?: LinkRegistry
  campaignThreat?: string
  campaignSolution?: string
  objectiveProfile?: CustomerObjectiveProfile
  preMatchedMetrics?: import('./lib/persona-classifier.ts').PreMatchedMetric[]
  preMatchedPeerProofs?: import('./lib/persona-classifier.ts').PreMatchedPeerProof[]
  pass0Briefs?: import('./lib/persona-selector.ts').PersonaBrief[]
  productFitSections?: Record<string, string>
  signalQuality?: { disposition: string; signalCompleteness: number; missing: string[] }
  enablePolish?: boolean
}

// ── 8 Composable Email Blocks ───────────────────────────────────────────────

/**
 * Block 1: Signal-driven opener — 3 variants rotating by email index.
 * signalIndex resolves the actual signal text from the loaded signals array.
 */
export function buildOpener(
  signalIndex: number,
  signals: Signal[],
  openerVariant: number,
  recipientName: string,
  tier: 'executive' | 'manager' = 'manager',
  matchedBrief?: import('./lib/persona-selector.ts').PersonaBrief,
  customerName?: string,
  usedOpeners?: Set<string>,
  initiatives?: Array<{ name: string; priority: string; detail: string }>,
): BlockOutput {
  const firstName = recipientName.split(' ')[0]
  const signal = signals[signalIndex]

  // ── TOP PRIORITY: strategic initiative headlines (grounded customer events) ──
  if (initiatives && initiatives.length > 0) {
    const customerFirstWord = (customerName || 'your organization').split(/[\s,]+/)[0]

    const sorted = [...initiatives].sort((a, b) => {
      const order: Record<string, number> = { HIGH: 0, MED: 1, LOW: 2 }
      return (order[a.priority] ?? 2) - (order[b.priority] ?? 2)
    })

    const INIT_EXEC_TEMPLATES = [
      (name: string) => `${firstName}, ${customerFirstWord}'s ${name} caught my attention.`,
      (name: string) => `Hi ${firstName} — with ${customerFirstWord}'s ${name}, there's a strategic conversation worth having.`,
      (name: string) => `${firstName}, ${customerFirstWord}'s ${name} signals a shift worth examining.`,
    ]

    const INIT_MGR_TEMPLATES = [
      (name: string) => `Hi ${firstName} — ${customerFirstWord}'s ${name} has practical implications for your team.`,
      (name: string) => `${firstName}, with ${customerFirstWord}'s ${name}, there are some technical decisions worth revisiting.`,
      (name: string) => `Hi ${firstName}, ${customerFirstWord}'s ${name} creates some interesting infrastructure questions.`,
    ]

    const templates = tier === 'executive' ? INIT_EXEC_TEMPLATES : INIT_MGR_TEMPLATES

    for (const init of sorted) {
      const key = init.name.slice(0, 50)
      if (usedOpeners?.has(key)) continue

      const template = templates[openerVariant % templates.length]
      const cleanName = init.name.replace(new RegExp(`^${customerFirstWord}\\s+`, 'i'), '')
      const candidate = template(cleanName)
      usedOpeners?.add(key)
      return validateBlock('opener', toBlock(candidate))
    }
  }

  // ── SECONDARY: signal-headline path ────────────────────────────────────────
  if (signal) {
    let observation = signal.headline
    if (observation.includes(' — ')) {
      observation = observation.split(' — ')[0]
    }
    observation = observation
      .replace(/\s*(?:detected|identified|flagged|observed|reported)\s*/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (observation && /^[a-z]/.test(observation)) {
      observation = observation.charAt(0).toUpperCase() + observation.slice(1)
    }

    const customerFirstWord = (customerName || 'your organization').split(/[\s,]+/)[0]

    const EXEC_GREETINGS = [
      `${firstName}, your team's work on ${observation} caught my attention.`,
      `Hi ${firstName} — ${observation} stood out as particularly relevant to your strategy.`,
      `${firstName}, a few of us were discussing ${observation} and how it connects to ${customerFirstWord}'s priorities.`,
    ]

    const EXEC_OPENERS = [
      ...EXEC_GREETINGS,
      `${firstName}, with ${observation} reshaping priorities, there's a window worth examining.`,
      `${firstName}, ${observation} is creating a window that closes faster than most planning cycles account for.`,
      `${firstName}, ${observation} is the kind of shift that separates the organizations that act early from those that react late.`,
      `Hi ${firstName}, ${observation} is already changing how your peers allocate infrastructure investment.`,
      `Hi ${firstName}, ${observation} is driving decisions across your peer group right now.`,
    ]

    const MGR_GREETINGS = [
      `Hi ${firstName} — ${observation} stood out as relevant to what your team is working on.`,
      `${firstName}, wanted to flag ${observation} — it has practical implications for your team.`,
      `Hi ${firstName}, ${observation} connects directly to priorities I'm hearing from teams like yours.`,
    ]

    const MGR_OPENERS = [
      ...MGR_GREETINGS,
      `Hi ${firstName}, ${observation} is driving new priorities for leaders in your position.`,
      `Hi ${firstName}, ${observation} has direct implications for how your team operates day to day.`,
      `${firstName}, ${observation} is worth a closer look — the technical implications run deeper than the headline.`,
      `Hi ${firstName}, ${observation} is accelerating timelines for teams running infrastructure like yours.`,
      `${firstName}, ${observation} means the playbook your team is running today may need an update sooner than planned.`,
    ]

    const variants = tier === 'executive' ? EXEC_OPENERS : MGR_OPENERS
    for (let v = 0; v < variants.length; v++) {
      const candidate = variants[(openerVariant + v) % variants.length]
      const key = candidate.slice(0, 50)
      if (!usedOpeners || !usedOpeners.has(key)) {
        if (usedOpeners) usedOpeners.add(key)
        return validateBlock('opener', toBlock(candidate))
      }
    }
  }

  // ── FALLBACK: brief-field path (simplified) ────────────────────────────────
  if (matchedBrief) {
    const cleanBriefField = (text: string): string | null => {
      let cleaned = text
        .replace(/\*\*[^*]+\*\*:?\s*/g, '')
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      cleaned = cleaned.replace(/\btheir\b/gi, 'your')
      cleaned = cleaned.replace(/\bhis\b/gi, 'your')
      cleaned = cleaned.replace(/\bher\b/gi, 'your')
      cleaned = cleaned.replace(/\bthe company's\b/gi, 'your')
      cleaned = cleaned.replace(/\bthe organization's\b/gi, 'your')
      if (customerName) {
        const possessivePattern = new RegExp(`\\b${customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'s\\b`, 'gi')
        cleaned = cleaned.replace(possessivePattern, 'your')
      }
      if (cleaned.length < 20) return null
      const tierLimit = tier === 'executive' ? 100 : 120
      const sentenceMatch = cleaned.match(/^([^.!?]+[.!?])/)
      if (sentenceMatch && sentenceMatch[1].length <= tierLimit) return sentenceMatch[1].replace(/[.!?]$/, '')
      return truncateAtSentence(cleaned, tierLimit)
    }
    const smartLc = (s: string): string => {
      const firstWord = s.split(/\s/)[0]
      if (/^[A-Z]{2,}/.test(firstWord)) return s
      if (/^[A-Z][a-z]+[A-Z]/.test(firstWord)) return s
      if (/^[A-Z]+\d/.test(firstWord)) return s
      if (/^(?:Red|Ansible|OpenShift|Kubernetes|Docker|Azure|Google|Amazon|AWS|IBM|VMware|Terraform|Linux|GitHub|Microsoft|Oracle|SAP|Cisco|Dell|Intel|NVIDIA|MongoDB|PostgreSQL|Salesforce|ServiceNow)\b/.test(firstWord)) return s
      return s.charAt(0).toLowerCase() + s.slice(1)
    }

    const fields = [
      matchedBrief.objectiveMatch ? cleanBriefField(matchedBrief.objectiveMatch) : null,
      matchedBrief.timingTrigger ? cleanBriefField(matchedBrief.timingTrigger) : null,
      matchedBrief.valueProposition ? cleanBriefField(matchedBrief.valueProposition) : null,
    ].filter((f): f is string => f != null).map(f => smartLc(f))

    if (fields.length > 0) {
      for (let f = 0; f < fields.length; f++) {
        const field = fields[(openerVariant + f) % fields.length]
        const key = field.slice(0, 50)
        if (!usedOpeners || !usedOpeners.has(key)) {
          if (usedOpeners) usedOpeners.add(key)
          return validateBlock('opener', toBlock(`${firstName}, ${field.trim()}.`))
        }
      }
    }
  }

  // ── ULTIMATE FALLBACK ──────────────────────────────────────────────────────
  return validateBlock('opener', toBlock(`Hi ${firstName},`))
}

/**
 * Block 2: One sentence connecting the signal to the primary Red Hat product.
 * Uses the feature's product category (ansible/openshift/rhel) to frame the bridge.
 */
const SIGNAL_BRIDGES: Record<string, string> = {
  'ansible-news': "Organizations facing similar shifts are using enterprise automation to respond faster than manual operations allow.",
  'ansible-default': "Red Hat's automation platform is how organizations are converting this kind of shift into consistent, repeatable operations.",
  'openshift-news': "The teams moving fastest on this are running hybrid workloads on a platform that handles containers, VMs, and AI inference together.",
  'openshift-default': "This creates an opportunity to consolidate on a single enterprise platform — from containers to VMs to AI workloads.",
  'rhel-news': "Teams already running enterprise Linux are finding the fastest path runs through their existing infrastructure.",
  'rhel-default': "The same enterprise Linux foundation your teams already rely on extends naturally into this space.",
  'ai-news': "The organizations moving fastest on AI are deploying models on infrastructure they already control — not waiting for cloud-only options to mature.",
  'ai-default': "Enterprise AI deployment works best when it runs on the same platform your operations teams already manage.",
  'security-news': "The teams that handle this best are the ones running security policy enforcement as code — not as a quarterly audit.",
  'security-default': "Container supply chain security and runtime policy enforcement are how organizations stay ahead of this kind of risk.",
  'cost-news': "The organizations that come out ahead in cost restructuring are the ones that consolidate platforms before the deadline, not after.",
  'cost-default': "Platform consolidation is how organizations convert rising licensing and tax costs into a structural advantage.",
}

export function buildSignalBridge(
  signal: Signal | undefined,
  featureKeys: string[],
  productFitSections?: Record<string, string>,
  usedBridges?: Set<string>,
): BlockOutput {
  if (!signal || featureKeys.length === 0) return validateBlock('signalBridge', toBlock(''))

  const primaryKey = featureKeys[0]
  const product = primaryKey.includes('ansible') ? 'ansible'
    : primaryKey.includes('openshift') ? 'openshift'
    : (primaryKey.includes('rhel') || primaryKey.includes('enterprise-linux')) ? 'rhel'
    : primaryKey.includes('ai') ? 'ai'
    : primaryKey.includes('security') ? 'security'
    : null

  // Signal-driven: use product fit section from intel brief
  if (product && productFitSections?.[product]) {
    const fitText = productFitSections[product]
      .replace(/\*\*[^*]+\*\*:?\s*/g, '')
      .replace(/^\s*[-*]\s*/gm, '')
      .trim()
    const firstSentence = fitText.split(/[.!?]\s/)[0]
    if (firstSentence && firstSentence.length > 20) {
      const fitBridge = firstSentence.trim() + '.'
      const fitKey = fitBridge.slice(0, 50)
      if (!usedBridges || !usedBridges.has(fitKey)) {
        if (usedBridges) usedBridges.add(fitKey)
        return validateBlock('signalBridge', toBlock(fitBridge))
      }
    }
  }

  // Fallback: existing SIGNAL_BRIDGES lookup
  const signalType = signal.type === 'news' ? 'news' : 'default'
  const candidates: string[] = []
  if (product) {
    candidates.push(SIGNAL_BRIDGES[`${product}-${signalType}`])
    const altType = signalType === 'news' ? 'default' : 'news'
    if (SIGNAL_BRIDGES[`${product}-${altType}`]) candidates.push(SIGNAL_BRIDGES[`${product}-${altType}`])
  }
  candidates.push(`This aligns with how organizations are using Red Hat infrastructure to turn ${signalType === 'news' ? 'these shifts' : 'this kind of change'} into operational advantage.`)

  for (const candidate of candidates) {
    const key = candidate.slice(0, 50)
    if (!usedBridges || !usedBridges.has(key)) {
      if (usedBridges) usedBridges.add(key)
      return validateBlock('signalBridge', toBlock(candidate))
    }
  }
  return validateBlock('signalBridge', toBlock(candidates[0]))
}

/**
 * Block 3: Relationship line from subscription data.
 * Only rendered if subscriptions exist. Product names from subscription data, not hardcoded.
 */
const PRODUCT_DISPLAY_NAMES: Record<string, string> = {
  'enterprise linux server': 'Red Hat Enterprise Linux',
  'enterprise linux': 'Red Hat Enterprise Linux',
  'enterprise linux for': 'Red Hat Enterprise Linux',
  'openshift container platform': 'Red Hat OpenShift',
  'openshift': 'Red Hat OpenShift',
  'ansible automation platform': 'Red Hat Ansible Automation Platform',
  'ansible automation': 'Red Hat Ansible Automation Platform',
  'satellite': 'Red Hat Satellite',
  'jboss enterprise application platform': 'Red Hat JBoss EAP',
  'advanced cluster management': 'Red Hat Advanced Cluster Management',
  'advanced cluster security': 'Red Hat Advanced Cluster Security',
  'openshift ai': 'Red Hat OpenShift AI',
  'developer hub': 'Red Hat Developer Hub',
  'insights': 'Red Hat Insights',
  'smart management': 'Red Hat Smart Management',
}

const SIGNAL_PRODUCT_MAP: Record<string, string> = {
  'ocp': 'Red Hat OpenShift',
  'rhel': 'Red Hat Enterprise Linux',
  'ansible': 'Red Hat Ansible Automation Platform',
  'aap': 'Red Hat Ansible Automation Platform',
  'acs': 'Red Hat Advanced Cluster Security',
  'acm': 'Red Hat Advanced Cluster Management',
  'satellite': 'Red Hat Satellite',
  'quay': 'Red Hat Quay',
}

const PRODUCT_URLS: Record<string, string> = {
  'Red Hat Enterprise Linux': 'https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux',
  'Red Hat OpenShift': 'https://www.redhat.com/en/technologies/cloud-computing/openshift',
  'Red Hat Ansible Automation Platform': 'https://www.redhat.com/en/technologies/management/ansible',
  'Red Hat Satellite': 'https://www.redhat.com/en/technologies/management/satellite',
  'Red Hat Advanced Cluster Management': 'https://www.redhat.com/en/technologies/management/advanced-cluster-management',
  'Red Hat Advanced Cluster Security': 'https://www.redhat.com/en/technologies/cloud-computing/openshift/advanced-cluster-security-kubernetes',
  'Red Hat OpenShift AI': 'https://www.redhat.com/en/products/ai/openshift-ai',
  'Red Hat Developer Hub': 'https://www.redhat.com/en/products/developer-hub',
}

const FREE_TIER_PATTERNS = [
  'developer subscription',
  'beta access',
  'quay.io',
  'free tier',
  'developer for teams',
  'learning subscription',
]

export function isFreeTierProduct(desc: string): boolean {
  const lower = desc.toLowerCase()
  return FREE_TIER_PATTERNS.some(p => lower.includes(p))
}

function resolveProductDisplayName(desc: string): string {
  const stripped = desc.replace(/Red Hat\s*/i, '').replace(/,\s.*$/, '').trim()
  const key = stripped.toLowerCase()
  for (const [pattern, displayName] of Object.entries(PRODUCT_DISPLAY_NAMES)) {
    if (key.startsWith(pattern)) return displayName
  }
  return stripped.length > 0 ? `Red Hat ${stripped}` : ''
}

function linkProductName(displayName: string): string {
  const url = PRODUCT_URLS[displayName]
  return url ? `[${displayName}](${url})` : displayName
}

export function buildRelationshipLine(
  subscriptions: Array<{ product?: string; productDescription?: string; sku?: string; status?: string }>,
  signals?: Array<{ source: string; type: string; metadata?: Record<string, unknown> }>,
): BlockOutput {
  const activeProducts = (subscriptions || [])
    .filter(s => s.status === 'Active')
    .filter(s => !isFreeTierProduct(s.productDescription || s.product || s.sku || ''))
    .map(s => resolveProductDisplayName(s.productDescription || s.product || s.sku || ''))
    .filter(p => p.length > 0)

  const unique = [...new Set(activeProducts)]
  if (unique.length > 0) {
    const linked = unique.map(linkProductName)
    if (linked.length === 1) return validateBlock('relationshipLine', toBlock(`Your teams already rely on ${linked[0]}.`))
    const display = linked.slice(0, 3)
    return validateBlock('relationshipLine', toBlock(`Your teams already rely on ${display.slice(0, -1).join(', ')} and ${display[display.length - 1]}.`))
  }

  if (signals && signals.length > 0) {
    const products = new Set<string>()
    for (const s of signals) {
      if (s.source === 'tech-stack' || s.type === 'technology') {
        const rh = s.metadata?.redHatProducts as string[] | undefined
        if (rh) rh.forEach(p => products.add(SIGNAL_PRODUCT_MAP[p.toLowerCase()] || resolveProductDisplayName(p)))
      } else if (s.source === 'cases' || s.type === 'case') {
        const product = s.metadata?.product as string | undefined
        if (product) products.add(SIGNAL_PRODUCT_MAP[product.toLowerCase()] || resolveProductDisplayName(product))
      } else if (s.type === 'product-intel') {
        const product = s.metadata?.product as string | undefined
        if (product) products.add(SIGNAL_PRODUCT_MAP[product.toLowerCase()] || resolveProductDisplayName(product))
      }
    }
    if (products.size > 0) {
      const list = [...products].slice(0, 3)
      if (list.length === 1) return validateBlock('relationshipLine', toBlock(`Your teams work with ${list[0]}.`))
      return validateBlock('relationshipLine', toBlock(`Your teams work with ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}.`))
    }
  }

  return validateBlock('relationshipLine', toBlock(''))
}

/**
 * Block 4: Feature bullets — 3 bullets, each with name, URL, and capability description.
 * Feature name and URL resolved via resolveFeatureUrl(key) from feature-url-registry.ts.
 */
export function buildFeatureBullets(
  featureKeys: string[],
  tier: 'executive' | 'manager',
  campaignTheme?: string,
  matchedBrief?: import('./lib/persona-selector.ts').PersonaBrief,
): BlockOutput {
  const bullets: Array<{ featureName: string; url: string; applicationSentence: string }> = []
  for (let i = 0; i < featureKeys.slice(0, 3).length; i++) {
    const key = featureKeys[i]
    const entry = resolveFeatureEntry(key)
    if (!entry) continue

    // Signal-driven: use valueProposition from matched brief when relevant to this feature
    let applicationSentence = ''
    if (matchedBrief?.valueProposition) {
      const vpLower = matchedBrief.valueProposition.toLowerCase()
      if (vpLower.includes(entry.featureName.toLowerCase()) || vpLower.includes(key.replace(/-/g, ' '))) {
        const firstSentence = matchedBrief.valueProposition.split(/(?<!\d)[.!?]\s/)[0]?.trim() || matchedBrief.valueProposition
        const words = firstSentence.split(/\s+/)
        applicationSentence = words.length > 25 ? words.slice(0, 25).join(' ') : firstSentence
      }
    }

    // Fallback: static description
    if (!applicationSentence) {
      applicationSentence = getCapabilityDescription(key)
    }

    if (campaignTheme && i === 0) {
      const theme = campaignTheme.toLowerCase()
      if (theme.includes('tax') || theme.includes('cost')) {
        applicationSentence += ' — with self-managed deployment, zero SaaS tax exposure'
      } else if (theme.includes('security')) {
        applicationSentence += ' — with enterprise-grade security and compliance built in'
      }
    }
    bullets.push({ featureName: entry.featureName, url: entry.url, applicationSentence })
  }

  if (bullets.length === 0) return validateBlock('featureBullets', toBlock(''))

  const text = bullets.map(b =>
    `• [${b.featureName}](${b.url}) — ${b.applicationSentence}`
  ).join('\n')
  return validateBlock('featureBullets', toBlock(text))
}

/**
 * Derive a generic capability description from a feature key.
 */
function getCapabilityDescription(featureKey: string): string {
  const descriptions: Record<string, string> = {
    'ansible-automation-platform': 'unifies automation across hybrid environments with a single platform',
    'event-driven-ansible': 'triggers automated responses to infrastructure events in real time',
    'ansible-lightspeed-coding-assistant': 'accelerates playbook creation with AI-assisted code generation',
    'automation-mesh': 'extends automation reach across distributed networks and edge locations',
    'execution-environments': 'packages automation dependencies into portable, consistent runtime containers',
    'automation-dashboard-aap-2-6': 'provides centralized visibility into automation health and usage metrics',
    'aiops-overview': 'applies AI to IT operations for predictive incident management',
    'event-driven-automation': 'enables self-healing infrastructure through automated event response',
    'aiops-ansible-splunk-servicenow': 'connects AIOps intelligence to automated remediation workflows',
    'vertex-ai-eda-mlops': 'streamlines ML operations with automated model lifecycle management',
    'ai-monitoring-agent': 'accelerates debugging with AI-powered error analysis and recommendations',
    'mcp-server-for-aap': 'enables agentic AI systems to orchestrate automation through standard protocols',
    'openshift-container-platform': 'runs containerized workloads at scale with enterprise Kubernetes',
    'openshift-virtualization': 'migrates VMs alongside containers on a unified platform',
    'openshift-ai': 'deploys and serves AI models directly on the application platform',
    'advanced-cluster-management': 'manages multiple Kubernetes clusters from a single control plane',
    'advanced-cluster-security': 'secures container supply chain and runtime with policy enforcement',
    'getting-started-with-openshift': 'provides developer-ready environments for building cloud-native applications',
    'virtualization-in-2026': 'consolidates VM and container workloads on a modern platform foundation',
    'red-hat-enterprise-linux': 'delivers a stable, secure operating system for production workloads',
    'rhel-ai': 'runs foundation models on enterprise Linux with optimized inference',
    'red-hat-developer-hub': 'centralizes developer tools and golden paths in an internal developer portal',
    'container-security': 'hardens container images and enforces security policies across the pipeline',
    'kubernetes-clusters': 'orchestrates workloads across clusters with consistent operational patterns',
    'aiops': 'reduces incident response time with AI-driven operational intelligence',
    'ai-infrastructure-guide': 'provides reference architectures for building AI-ready infrastructure',
  }
  return descriptions[featureKey] || 'delivers enterprise-grade capabilities for modern infrastructure'
}

const VERB_PATTERN = /\b(?:replaced|consolidated|migrated|deployed|reduced|saved|achieved|realized|delivered|generated|gained|eliminated|standardized|chose|selected|adopted|cut|lowered|scaled|automated|runs?|saw)\b/i

const HAS_METRIC = /\d+%|\$[\d,.]+|[\d,.]+ (?:million|billion|M|B)\b|\d+x\b|\d+ (?:months?|years?|hours?|days?)\b/i

// Generic peer pattern fallback when no specific proof is available (#1138)
const GENERIC_PEER_PATTERN = "I've sat with a handful of leaders at this exact stage — and the ones who came out ahead all made one or two early decisions that their peers are still paying to unwind."

function cleanPeerOutcome(raw: string): string {
  let cleaned = raw
    .replace(/^Solution:\s*/i, '')
    .replace(/\.\s*[^.]*\b(?:AE|SE|TAM)\s+worked\b[^.]*\./gi, '.')
    .replace(/[^.]*\b(?:AE|SE|TAM)\s+worked\b[^.]*/gi, '')
    .replace(/\bpaid\s+up\s*front\b[^.]*/gi, '')
    .replace(/\bpaid\s+upfront\b[^.]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim()
  if (cleaned.length === 0) return ''
  const words = cleaned.split(/\s+/)
  let result: string
  if (words.length <= 25) {
    result = cleaned
  } else {
    const truncated = words.slice(0, 25).join(' ')
    const lastBoundary = truncated.search(/[.;,—]\s*\S+$/)
    result = lastBoundary > 0 ? truncated.slice(0, lastBoundary + 1).trim() : truncated.replace(/\s+\S*$/, '').trim()
  }
  return result.replace(/\.{2,}$/g, '.').replace(/\.\s*$/g, '').trim()
}

function formatPeerProofLine(customer: string, outcome: string): string {
  if (!customer || customer.trim().length === 0) return ''
  const cleaned = cleanPeerOutcome(outcome)
  if (cleaned.split(/\s+/).length < 3) return ''
  if (HAS_METRIC.test(cleaned)) {
    if (VERB_PATTERN.test(cleaned)) return `${customer} ${cleaned}`
    return `${customer} → ${cleaned}`
  }
  return `${customer} made this move — ${cleaned}`
}

export function buildPeerPattern(
  peerProof: { playName: string; exampleIndex: number } | null,
  structuredPlays: StructuredPlay[],
  preMatchedProof?: { proof: { customer: string; outcome: string } },
  usedPeerCompanies?: Set<string>,
): BlockOutput {
  const tryFormat = (customer: string, outcome: string): string | null => {
    if (usedPeerCompanies?.has(customer)) return null
    const formatted = formatPeerProofLine(customer, outcome)
    if (formatted) {
      usedPeerCompanies?.add(customer)
      return formatted
    }
    return null
  }

  // Priority 1: Pre-matched proof from Pass 0 persona briefs
  if (preMatchedProof) {
    const result = tryFormat(preMatchedProof.proof.customer, preMatchedProof.proof.outcome)
    if (result) return validateBlock('peerPattern', toBlock(result))
  }

  // Priority 2: Gemini-selected proof from material extraction
  if (peerProof) {
    const target = peerProof.playName.toLowerCase()
    const play = structuredPlays.find(p => p.name === peerProof.playName)
      || structuredPlays.find(p => p.name.toLowerCase().includes(target) || target.includes(p.name.toLowerCase()))
    const example = play?.realWorldExamples?.[peerProof.exampleIndex]
    if (example) {
      const result = tryFormat(example.customer, example.outcome)
      if (result) return validateBlock('peerPattern', toBlock(result))
    }
    if (!play) console.warn(`[template] PEER PROOF MISS: play "${peerProof.playName}" not found in ${structuredPlays.map(p => p.name).join(', ')}`)
  }

  // Priority 3: Fallback to any available SalesHub play examples — rotate through all examples
  for (const play of structuredPlays) {
    const examples = play.realWorldExamples || []
    for (const ex of examples) {
      const result = tryFormat(ex.customer, ex.outcome)
      if (result) return validateBlock('peerPattern', toBlock(result))
    }
    const metric = play.extractedMetrics?.[0]
    if (metric) return validateBlock('peerPattern', toBlock(`Organizations in similar positions have seen ${metric.value} — ${metric.context}.`))
  }

  // Priority 4: No proof available — omit entirely (#1170: never use GENERIC_PEER_PATTERN)
  return validateBlock('peerPattern', toBlock(''))
}

/**
 * Block 6: Challenger frame — wraps the Gemini-selected data point.
 * Fixed framing structure, selected data fills in.
 */
const CHALLENGER_CLOSERS = [
  'Organizations that act on this early carry a measurable advantage.',
  'The window to move first on this is narrow — and closing.',
  'Companies that address this proactively gain a structural cost edge.',
  'Early movers here will carry a permanent advantage their peers are still paying to unwind.',
]

export function buildChallengerFrame(
  signal: Signal | undefined,
  emailIndex: number = 0,
): BlockOutput {
  // Signal headline only — competitive context belongs in Call Prep, not emails
  if (!signal) return validateBlock('challengerFrame', toBlock(''))
  let insight = signal.headline
  if (insight.includes(' — ')) {
    insight = insight.split(' — ')[0]
  }
  insight = insight
    .replace(/\s*\([a-z-]+,\s*[a-z-]+\)\s*/gi, ' ')
    .replace(/\s*(?:detected|identified|flagged|observed|reported)\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!insight) return validateBlock('challengerFrame', toBlock(''))
  const closer = CHALLENGER_CLOSERS[emailIndex % CHALLENGER_CLOSERS.length]
  if (insight.endsWith('.')) return validateBlock('challengerFrame', toBlock(`${insight} ${closer}`))
  return validateBlock('challengerFrame', toBlock(`${insight}. ${closer}`))
}

function shortenTitle(name: string): string {
  const m = name.match(/^(.+?)(?:\s*[|:—–]\s*.+)?$/)
  const base = m ? m[1].trim() : name
  return base.length > 40 ? base.slice(0, 37) + '...' : base
}

export function buildReferenceLine(registry?: LinkRegistry): BlockOutput {
  if (!registry || registry.size === 0) return validateBlock('referenceLine', toBlock(''))

  const refs = registry.getExternalLinks()
  if (refs.length === 0) return validateBlock('referenceLine', toBlock(''))

  const entries = refs.slice(0, 2).map(r => [shortenTitle(r.anchor), r.url] as [string, string])
  return validateBlock('referenceLine', toBlock(`For context: ${entries.map(([name, url]) => `[${name}](${url})`).join(' and ')}.`))
}

/**
 * Block 7: CTA — AE name from account team, specific dates computed from current date.
 */
const CTA_OPTIONS = [
  { deliverable: 'a focused conversation', verb: 'Would' },
  { deliverable: 'a technical overview', verb: 'Could' },
  { deliverable: 'a TCO analysis', verb: 'Does' },
  { deliverable: 'an architecture review', verb: 'Would' },
  { deliverable: 'a strategy session', verb: 'Could' },
  { deliverable: 'a quick alignment', verb: 'Does' },
]

export function buildCTA(
  aeName: string,
  recipientName: string,
  _customerName: string,
  emailIndex: number = 0,
): BlockOutput {
  const firstName = recipientName.split(' ')[0]
  const { deliverable, verb } = CTA_OPTIONS[emailIndex % CTA_OPTIONS.length]

  const now = new Date()
  const daysOut = 7 + emailIndex * 2
  const date1 = new Date(now.getTime() + daysOut * 24 * 60 * 60 * 1000)
  const date2 = new Date(date1.getTime() + 7 * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

  return validateBlock('cta', toBlock(`${verb} ${fmt(date1)} work for ${deliverable}? If that week is tight, ${fmt(date2)} works just as well.`))
}

/**
 * Block 8: Sign-off — AE name + title.
 */
export function buildSignOff(aeName: string, aeEmail?: string, aePhone?: string): BlockOutput {
  let signOff = `${aeName}\nAccount Executive · Red Hat`
  if (aeEmail) signOff += `\n${aeEmail}`
  if (aePhone) signOff += ` | M: ${aePhone}`
  return validateBlock('signOff', toBlock(signOff))
}

const TRUSTED_URL_DOMAINS = ['redhat.com', 'developers.redhat.com']

export { isInternalUrl, isHomepageUrl } from './lib/link-registry.ts'

function sanitizeReferenceLine(line: string, registry?: LinkRegistry): string {
  if (!line) return ''
  const sourceDomains = registry?.getSourceDomains() ?? new Set<string>()
  return line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, text, url) => {
    try {
      if (isInternalUrl(url)) return text
      const host = new URL(url).hostname
      if (TRUSTED_URL_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))) return `[${text}](${url})`
      if (sourceDomains.has(host)) return `[${text}](${url})`
    } catch { /* invalid URL */ }
    return text
  })
}

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * Count words in text (splitting on whitespace).
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length
}

/**
 * Apply voice formality tokens to text.
 */
function applyFormality(
  text: string,
  formality: 'casual' | 'professional' | 'formal',
  assertionLevel: 'confident' | 'collaborative' | 'deferential',
): string {
  let result = text
  if (formality === 'casual') {
    result = result.replace(/\bwill not\b/g, "won't")
    result = result.replace(/\bcan not\b/g, "can't")
    result = result.replace(/\bdo not\b/g, "don't")
    result = result.replace(/\bis not\b/g, "isn't")
  } else if (formality === 'formal') {
    result = result.replace(/\bwon't\b/g, 'will not')
    result = result.replace(/\bcan't\b/g, 'cannot')
    result = result.replace(/\bdon't\b/g, 'do not')
    result = result.replace(/\bisn't\b/g, 'is not')
  }

  if (assertionLevel === 'deferential') {
    result = result.replace(/\bcreates\b/g, 'may create')
    result = result.replace(/\bwill\b/g, 'may')
    result = result.replace(/\bdriving\b/g, 'potentially driving')
  } else if (assertionLevel === 'confident') {
    result = result.replace(/\bcan enable\b/g, 'enables')
    result = result.replace(/\bmay\b/g, 'will')
    result = result.replace(/\bworth exploring\b/g, 'worth acting on')
  }

  return result
}

/**
 * Trim peer pattern to one sentence (first sentence only).
 */
function trimPeerPatternToOneSentence(peerPattern: string): string {
  const sentences = peerPattern.split(/\.\s+/)
  if (sentences.length === 0) return peerPattern
  const firstSentence = sentences[0].trim()
  return firstSentence.endsWith('.') ? firstSentence : `${firstSentence}.`
}

/**
 * Trim feature bullets from 3 to 2 bullets.
 */
function trimFeatureBulletsToTwo(featureBullets: string): string {
  const bullets = featureBullets.split('\n').filter(b => b.trim().length > 0)
  if (bullets.length <= 2) return featureBullets
  return bullets.slice(0, 2).join('\n')
}

/**
 * Hard trim: truncate to last complete sentence within word limit.
 * Safety net when cascade isn't aggressive enough (#1144).
 * Preserves original whitespace (newlines between blocks) — #1149.
 */
function trimToWordLimit(text: string, maxWords: number): string {
  const wordMatches = [...text.matchAll(/\S+/g)]
  if (wordMatches.length <= maxWords) return text

  const lastWord = wordMatches[maxWords - 1]
  const cutPoint = lastWord.index! + lastWord[0].length
  const truncated = text.slice(0, cutPoint)

  // Sentence boundary: period/question/exclamation followed by whitespace or end-of-string.
  // Avoids cutting at dots inside URLs (e.g. redhat.com).
  const sentenceEndRegex = /[.?!](?=\s|$)/g
  let lastSentenceEnd = -1
  let m: RegExpExecArray | null
  while ((m = sentenceEndRegex.exec(truncated)) !== null) {
    lastSentenceEnd = m.index
  }

  if (lastSentenceEnd > 0) {
    return truncated.slice(0, lastSentenceEnd + 1)
  }

  return truncated + '…'
}

// ── LLM Composition ────────────────────────────────────────────────────────

export interface CompositionBrief {
  recipientName: string
  recipientTitle: string
  company: string
  aeName: string
  tier: 'executive' | 'manager'
  hook: string
  bridgeContext: string
  relationship: string
  products: string
  peerProof: string
  references: string
  challengerClose: string
  ctaText: string
  campaignTheme: string
}

export async function composeEmailBody(brief: CompositionBrief): Promise<string | null> {
  const systemPrompt = 'You write concise, peer-level B2B prospecting emails for enterprise technology sales.'
  const userPrompt = `You are writing a prospecting email on behalf of ${brief.aeName}, an Account Executive at Red Hat, to ${brief.recipientName}, ${brief.recipientTitle} at ${brief.company}.

Write the email body ONLY. No subject line, no signature, no "Dear" or "Sincerely".

RULES:
- 120-150 words maximum
- Peer-level business tone — strategic advisor, not vendor pitch
- Lead with their specific business event: ${brief.hook}
- Connect it to a business risk or opportunity they face
- Weave in 2-3 Red Hat capabilities naturally — NO bullet lists, NO product catalog format
- Include the peer proof naturally in one sentence
- Reference the source material by name where relevant
- If they're an existing Red Hat customer, acknowledge the relationship naturally
- End with a specific meeting ask
- Do NOT invent facts — use ONLY the data provided below
- Do NOT use phrases like "I noticed", "I wanted to reach out", "I hope this finds you well"
- Do NOT use marketing buzzwords or exclamation marks

DATA FOR THIS EMAIL:
Recipient: ${brief.recipientName}, ${brief.recipientTitle} at ${brief.company}
Business Event: ${brief.hook}
Business Context: ${brief.bridgeContext}
Existing Relationship: ${brief.relationship}
Red Hat Capabilities: ${brief.products}
Peer Proof: ${brief.peerProof}
Source Material: ${brief.references}
Campaign Theme: ${brief.campaignTheme}
Meeting Ask: ${brief.ctaText}

Write the email body as plain text.`

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'campaign-compose',
      temperature: 0.7,
    })
    const text = (result.text || '').trim()

    const words = text.split(/\s+/).length
    if (words < 50 || words > 250) return null
    const firstName = brief.recipientName.split(' ')[0]
    if (!text.includes(firstName)) return null

    return text
  } catch {
    return null
  }
}

/**
 * Assemble email from composable blocks, applying word budget and tier formatting.
 */
export function assembleEmail(
  blocks: {
    opener: BlockOutput
    signalBridge: BlockOutput
    relationshipLine: BlockOutput
    featureBullets: BlockOutput
    referenceLine: BlockOutput
    peerPattern: BlockOutput
    challengerFrame: BlockOutput
    cta: BlockOutput
    signOff: BlockOutput
  },
  tier: 'executive' | 'manager',
  voiceTokens: ReturnType<typeof getVoiceTokens>,
  recipientName?: string,
): { body: string; signOff: string } {
  const t = (b: BlockOutput) => b.text
  const bodyParts = [
    t(blocks.opener),
    t(blocks.signalBridge),
    t(blocks.relationshipLine),
    t(blocks.featureBullets),
    t(blocks.referenceLine),
    t(blocks.peerPattern),
    t(blocks.challengerFrame),
    t(blocks.cta),
  ].filter(b => b.length > 0)

  let body = bodyParts.join('\n\n')

  // Apply voice formality and assertion level
  body = applyFormality(body, voiceTokens.formality, voiceTokens.assertionLevel)

  const maxWords = tier === 'executive' ? voiceTokens.wordBudget.exec : voiceTokens.wordBudget.manager
  const tolerance = maxWords * 1.2

  let wordCount = countWords(body)
  const originalCount = wordCount

  // Enforce word limit with trim cascade for both tiers (#1144, #1147)
  if (wordCount > tolerance) {
    const challengerText = t(blocks.challengerFrame)
    const peerText = t(blocks.peerPattern)
    const featureText = t(blocks.featureBullets)

    // Trim cascade: challengerFrame → peerPattern → featureBullets
    // Step 1: Remove challengerFrame (supplementary, not core)
    if (challengerText && wordCount > tolerance) {
      const trimmedParts = bodyParts.filter(b => b !== challengerText)
      body = trimmedParts.join('\n\n')
      body = applyFormality(body, voiceTokens.formality, voiceTokens.assertionLevel)
      wordCount = countWords(body)
    }

    // Step 2: Trim peerPattern to one sentence
    if (peerText && wordCount > tolerance) {
      const trimmedPeerPattern = trimPeerPatternToOneSentence(peerText)
      const trimmedParts = bodyParts.map(b => b === peerText ? trimmedPeerPattern : b).filter(b => b !== challengerText)
      body = trimmedParts.join('\n\n')
      body = applyFormality(body, voiceTokens.formality, voiceTokens.assertionLevel)
      wordCount = countWords(body)
    }

    // Step 3: Trim featureBullets from 3 to 2
    if (featureText && wordCount > tolerance) {
      const trimmedBullets = trimFeatureBulletsToTwo(featureText)
      const peerPatternContent = peerText ? trimPeerPatternToOneSentence(peerText) : peerText
      const trimmedParts = bodyParts
        .map(b => {
          if (b === featureText) return trimmedBullets
          if (b === peerText) return peerPatternContent
          return b
        })
        .filter(b => b !== challengerText)
      body = trimmedParts.join('\n\n')
      body = applyFormality(body, voiceTokens.formality, voiceTokens.assertionLevel)
      wordCount = countWords(body)
    }

    // Log warning if any trimming occurred
    if (wordCount < originalCount) {
      const recipientInfo = recipientName ? ` for ${recipientName}` : ''
      console.warn(`[template] WORD LIMIT: trimmed exec email${recipientInfo} from ${originalCount} to ${wordCount} words (tolerance: ${Math.floor(tolerance)})`)
    }

    // Hard trim safety net: if still over tolerance after cascade, truncate to maxWords (#1144)
    if (wordCount > tolerance) {
      const beforeHardTrim = wordCount
      body = trimToWordLimit(body, maxWords)
      wordCount = countWords(body)
      const recipientInfo = recipientName ? ` for ${recipientName}` : ''
      console.warn(`[template] HARD TRIM: truncated exec email${recipientInfo} from ${beforeHardTrim} to ${wordCount} words (limit: ${maxWords})`)
    }
  }

  return { body, signOff: t(blocks.signOff) }
}

// ── Structured Email Box Renderer ───────────────────────────────────────────

function renderStructuredEmailBox(
  recipientName: string,
  tier: 'executive' | 'manager',
  subject: string,
  body: string,
  signOffText: string,
  aeName: string,
  aeEmail?: string,
  aePhone?: string,
  recipientEmail?: string,
  recipientTitle?: string,
): string {
  const tierLabel = tier === 'executive' ? 'Executive' : 'Manager'
  const headerTitle = recipientTitle || tierLabel
  const bodyHtml = convertMarkdownBullets(body)

  const contactLine = [aeEmail, aePhone ? `M: ${aePhone}` : ''].filter(Boolean).join(' | ')

  return `<div style="border: 2px solid #dadce0; margin-bottom: 24px;">
  <div style="background: ${BRAND_RED}; padding: 12px 20px;">
    <span style="color: white; font-size: 16px; font-weight: bold;">📧  ${escapeHtml(recipientName)} — ${headerTitle}</span>
  </div>
  <div style="padding: 8px 20px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">
    <p style="font-size: 14px; color: #5f6368; margin: 0;">Subject: <strong style="color: #202124;">${escapeHtml(subject)}</strong></p>
    ${recipientEmail ? `<p style="font-size: 14px; color: #5f6368; margin: 4px 0 0 0;">To: <strong style="color: #202124;">${escapeHtml(recipientEmail)}</strong> <span style="color: #9aa0a6;">[inferred]</span></p>` : ''}
  </div>
  <div style="padding: 20px;">
    ${bodyHtml}
    <div style="margin-top: 20px; padding-top: 14px; border-top: 3px solid ${BRAND_RED};">
      <p style="font-size: 16px; font-weight: bold; margin: 0;">${escapeHtml(aeName)}</p>
      <p style="font-size: 14px; color: #5f6368; margin: 2px 0 0 0;">Account Executive · <span style="color: ${BRAND_RED}; font-weight: bold;">Red Hat</span></p>
      ${contactLine ? `<p style="font-size: 13px; color: #5f6368; margin: 2px 0 0 0;">${escapeHtml(contactLine)}</p>` : ''}
    </div>
  </div>
</div>`
}

// ── Main Two-Pass Function ──────────────────────────────────────────────────

/**
 * Generate campaign HTML deterministically from structured selections.
 * ADR-043 Pass 2: No LLM involved. Gemini selected data in Pass 1,
 * this function assembles emails from composable blocks.
 */

function renderDashboardMetrics(rawSignals?: CampaignSignals, objectiveProfile?: CustomerObjectiveProfile): string {
  const metrics = extractMetrics(rawSignals, objectiveProfile)
  return `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 0 0 16px 0;">📊 Customer Intelligence Dashboard</h2>
<table width="100%" cellpadding="0" cellspacing="8" style="margin-bottom: 20px;">
  <tr>
    <td width="33%" style="background: #fef7f7; padding: 14px; text-align: center; border-radius: 6px;">
      <div style="font-size: 24px; font-weight: bold; color: ${BRAND_RED};">${metrics.revenue}</div>
      <div style="font-size: 12px; color: #5f6368;">Annual Revenue</div>
    </td>
    <td width="33%" style="background: #fef7f7; padding: 14px; text-align: center; border-radius: 6px;">
      <div style="font-size: 24px; font-weight: bold; color: ${BRAND_RED};">${metrics.employees}</div>
      <div style="font-size: 12px; color: #5f6368;">Employees</div>
    </td>
    <td width="33%" style="background: #fef7f7; padding: 14px; text-align: center; border-radius: 6px;">
      <div style="font-size: 24px; font-weight: bold; color: ${BRAND_RED};">${metrics.productInstances}</div>
      <div style="font-size: 12px; color: #5f6368;">${metrics.productName} Instances</div>
    </td>
  </tr>
</table>`
}

function renderStructuredIntelSections(rawSignals?: CampaignSignals, pass0Briefs?: import('./lib/persona-selector.ts').PersonaBrief[], objectiveProfile?: CustomerObjectiveProfile): string {
  const structured = extractStructuredIntel(rawSignals, objectiveProfile)
  let sections = ''

  if (structured.initiatives.length > 0) {
    sections += `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">🎯 Strategic Initiatives</h3>
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Initiative</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0; width: 80px; text-align: center;">Priority</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Detail</td>
  </tr>
  ${structured.initiatives.map(i => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHtml(i.name)}</td>
    <td style="border-bottom: 1px solid #e8eaed; text-align: center;"><span style="background: ${i.priority === 'HIGH' ? '#c5221f' : '#f9ab00'}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${escapeHtml(i.priority)}</span></td>
    <td style="border-bottom: 1px solid #e8eaed; font-size: 13px; color: #5f6368;">${escapeHtml(i.detail)}</td>
  </tr>`).join('\n')}
</table>`
  }

  // Check for Pass 0 competitive context first
  const pass0CompetitiveBriefs = pass0Briefs?.filter(b => b.competitiveContext && b.competitiveContext.trim().length > 0) || []

  if (pass0CompetitiveBriefs.length > 0) {
    // Render Pass 0 competitive context (campaign-relevant competitors from persona briefs)
    sections += `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚔️ Competitive Position</h3>
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Role</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Competitive Context</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Red Hat Advantage</td>
  </tr>
  ${pass0CompetitiveBriefs.map(b => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHtml(b.suggestedTitle)}</td>
    <td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(b.competitiveContext || '')}</td>
    <td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(b.valueProposition)}</td>
  </tr>`).join('\n')}
</table>`
  } else if (structured.competitors.length > 0) {
    // Fallback to intelligence-based competitive rendering
    const hasThreat = structured.competitors.some(c => c.threat)
    const hasAdvantage = structured.competitors.some(c => c.advantage)
    sections += `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚔️ Competitive Position</h3>
${structured.differentiation ? `<p style="font-size: 14px; color: #5f6368; margin: 0 0 12px 0;"><strong>Differentiation:</strong> ${escapeHtml(structured.differentiation)}</p>` : ''}
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Competitor</td>
    ${hasThreat ? '<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Threat</td>' : ''}
    ${hasAdvantage ? '<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Advantage</td>' : ''}
  </tr>
  ${structured.competitors.map(c => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHtml(c.name)}</td>
    ${hasThreat ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(c.threat)}</td>` : ''}
    ${hasAdvantage ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(c.advantage)}</td>` : ''}
  </tr>`).join('\n')}
</table>`
  }

  return sections
}

async function polishEmailBody(
  rawBody: string,
  recipientName: string,
  recipientTitle: string,
  tier: 'executive' | 'manager',
  customerName: string,
  campaignTheme: string,
  wordLimit: number,
): Promise<string> {
  const { callGemini } = await import('./gemini-call.ts')

  const { cleanBody, placeholders } = isolateLinks(rawBody)

  const prompt = `Rewrite this sales email body to read naturally — like a brief colleague's note, not a template.

RULES:
- Use ONLY facts already present in the text below. Do NOT add any new information, metrics, or claims.
- Keep the same structure: greeting, context, product bullets, peer proof, call to action.
- The greeting must start with "${recipientName.split(' ')[0]}," followed by a specific observation about their business.
- Include any metrics or numbers that appear in the original (revenue figures, percentages, dollar amounts).
- Keep bullet points as bullet points (use • character).
- Keep all REF markers (REF1, REF2, etc.) exactly in place — they are placeholders for verified links that will be restored after polishing.
- Maximum ${wordLimit} words.
- Write as an AE peer, not a marketer. Conversational, not formal.
- Do NOT include the sign-off (name, title, email, phone) — that's added separately.
- Tier: ${tier} — ${tier === 'executive' ? 'brief, high-level, designed to be forwarded down with "thoughts?"' : 'more technical depth, designed to be forwarded up with "we should look at this"'}

CUSTOMER: ${customerName}
RECIPIENT: ${recipientName}, ${recipientTitle}
THEME: ${campaignTheme}

EMAIL TO POLISH:
${cleanBody}`

  try {
    const result = await callGemini(
      'You are a sales email editor. You polish raw template output into natural prose. You never add facts — only rearrange and smooth what is given.',
      prompt,
      {
        callType: 'email-polish',
        customerName,
        temperature: 0.1,
        timeoutMs: 45_000,
      },
    )

    let polished = result.text.trim()

    if (!polished || polished.length < 50) return rawBody
    if (polished.split(/\s+/).length > wordLimit * 1.3) return rawBody

    const missingRefs = placeholders.filter(p => !polished.includes(p.marker))
    if (missingRefs.length > 0) {
      console.warn(`[template] Polish dropped ${missingRefs.length} REF markers for ${recipientName} — falling back to raw`)
      return rawBody
    }

    polished = restoreLinks(polished, placeholders)

    const rawWordCount = rawBody.split(/\s+/).length
    const polishedWordCount = polished.split(/\s+/).length
    console.log(`[template] Polish pass: ${recipientName} — ${rawWordCount}w raw → ${polishedWordCount}w polished`)

    return polished
  } catch (e: any) {
    console.warn(`[template] Polish pass failed for ${recipientName}: ${e?.message}`)
    return rawBody
  }
}

export async function generateCampaignFromStructured(
  selection: StructuredCampaignSelection,
  data: StructuredCampaignData,
): Promise<string> {
  const voiceTokens = getVoiceTokens(data.voiceProfile)

  // Sanitize customer-facing fields from Gemini selection output
  selection.customerContext = sanitizeCreepyLines(selection.customerContext)
  selection.positioning = sanitizeCreepyLines(selection.positioning)

  // Use objective profile from intelligence cache (ADR-044) instead of regex extraction
  const campaignTheme = {
    threat: data.campaignThreat || 'rising infrastructure costs',
    solution: data.campaignSolution || 'consolidated infrastructure',
  }
  const fitPreMatch = data.preMatchedMetrics?.[0]
  const objectiveCorrelation = renderObjectiveBlock(
    data.objectiveProfile,
    campaignTheme,
    fitPreMatch?.recipientTitle,
    fitPreMatch,
  )

  // Find AE name from account team (always from account team, never from selection)
  const aeTeamMember = data.accountTeam.find(m => m.role === 'ae')
  const aeName = aeTeamMember?.name ?? 'Account Executive'

  // Derive AE email from name if not provided (flast@redhat.com)
  if (!data.aeEmail && aeName !== 'Account Executive') {
    const parts = aeName.trim().split(/\s+/)
    if (parts.length >= 2) {
      data.aeEmail = `${parts[0][0].toLowerCase()}${parts[parts.length - 1].toLowerCase()}@redhat.com`
    }
  }

  // Fallback contact info when no named AE and no voice profile (#1129)
  if (aeName === 'Account Executive' && !data.aeEmail && !data.aePhone) {
    data.aeEmail = 'redhat-team@redhat.com'
  }

  // Build contacts table from resolved execs
  const contacts: CampaignContact[] = data.resolvedExecs.map(e => ({
    name: e.name,
    title: e.title,
    email: e.email,
    linkedIn: e.linkedIn,
  }))

  // Track which objectives are actually used in emails
  const usedObjectives: UsedObjective[] = []

  // Track quality check results for dynamic checklist
  const qualityResults: EmailQualityResult[] = []

  // Track used openers and peer companies for dedup across emails
  const usedOpeners = new Set<string>()
  const usedBridges = new Set<string>()
  const usedPeerCompanies = new Set<string>()

  // Build per-email HTML
  const initiatives = extractStructuredIntel(data.rawSignals, data.objectiveProfile).initiatives

  const execEmailsHtml: string[] = []
  const managerEmailsHtml: string[] = []
  let execIdx = 0
  let mgrIdx = 0

  for (let i = 0; i < selection.emails.length; i++) {
    const email = selection.emails[i]

    // Find matching contact by exact recipientName
    const contact = data.resolvedExecs.find(e => e.name === email.recipientName)
    if (!contact) continue

    const openerVariant = i % 3
    const signal = data.signals[email.signalIndex]

    // Match email to its Pass 0 brief — distribute briefs across contacts (round-robin per tier)
    const contactTitle = (contact?.title || '').toLowerCase()
    const briefsByTier = (data.pass0Briefs || []).reduce((acc, b) => {
      const isExec = b.role === 'executive-sponsor' || b.role === 'financial-gatekeeper'
      const tier = isExec ? 'executive' : 'manager'
      if (!acc[tier]) acc[tier] = []
      acc[tier].push(b)
      return acc
    }, {} as Record<string, typeof data.pass0Briefs>)
    const tierBriefs = briefsByTier[email.tier] || data.pass0Briefs || []
    const exactMatch = tierBriefs.find(b =>
      b.suggestedTitle && (contactTitle === b.suggestedTitle.toLowerCase() ||
        contactTitle.includes(b.suggestedTitle.toLowerCase()) ||
        b.suggestedTitle.toLowerCase().includes(contactTitle))
    )
    const tierIndex = email.tier === 'executive' ? execIdx++ : mgrIdx++
    const matchedBrief = exactMatch || tierBriefs[tierIndex % tierBriefs.length]

    // Build all 8 blocks
    const opener = buildOpener(email.signalIndex, data.signals, openerVariant, email.recipientName, email.tier, matchedBrief, data.customerName, usedOpeners, initiatives)
    const rawSignalBridge = buildSignalBridge(signal, email.featureKeys, data.productFitSections, usedBridges)
    const recipientExec = data.resolvedExecs.find(e => e.name === email.recipientName)
    const recipientTitle = recipientExec?.title || email.tier
    const preMatch = data.preMatchedMetrics?.find(pm => pm.recipientName === email.recipientName)
    const objectiveContext = cleanObjectivePrefix(sanitizeCreepyLines(renderObjectiveBlock(
      data.objectiveProfile,
      campaignTheme,
      recipientTitle,
      preMatch,
    )))
    if (preMatch) {
      usedObjectives.push({
        objective: preMatch.entry.objective,
        metric: preMatch.entry.metric,
        category: preMatch.category.charAt(0).toUpperCase() + preMatch.category.slice(1),
        usedIn: `${email.recipientName} (${email.tier})`,
      })
    } else if (objectiveContext && data.objectiveProfile) {
      const catEntries = [
        ...data.objectiveProfile.financial.map(e => ({ ...e, category: 'Financial' })),
        ...data.objectiveProfile.security.map(e => ({ ...e, category: 'Security' })),
        ...data.objectiveProfile.operational.map(e => ({ ...e, category: 'Operational' })),
        ...data.objectiveProfile.innovation.map(e => ({ ...e, category: 'Innovation' })),
        ...data.objectiveProfile.growth.map(e => ({ ...e, category: 'Growth' })),
      ]
      const matched = catEntries.find(e => objectiveContext.includes((e.objective || '').slice(0, 30)))
      if (matched) {
        usedObjectives.push({
          objective: matched.objective,
          metric: matched.metric,
          category: matched.category,
          usedIn: `${email.recipientName} (${email.tier})`,
        })
      }
    }
    const signalBridge = objectiveContext ? toBlock(`${rawSignalBridge.text} ${objectiveContext}`) : rawSignalBridge
    const relationshipLine = buildRelationshipLine(data.subscriptions, data.signals)
    const featureBullets = buildFeatureBullets(email.featureKeys, email.tier, data.campaignThreat || data.campaignSolution, matchedBrief)
    const rawRefLine = buildReferenceLine(data.linkRegistry)
    const referenceLine = toBlock(sanitizeReferenceLine(rawRefLine.text, data.linkRegistry))
    const preMatchedProof = data.preMatchedPeerProofs?.find(p => p.recipientName === email.recipientName)
    const peerPattern = buildPeerPattern(email.peerProof, data.structuredPlays, preMatchedProof, usedPeerCompanies)
    const challengerFrame = buildChallengerFrame(signal, i)
    const cta = buildCTA(aeName, email.recipientName, data.customerName, i)
    const signOff = buildSignOff(aeName, data.aeEmail, data.aePhone)

    // LLM composition from structured brief, fallback to template assembly
    const recipientExecForCompose = data.resolvedExecs.find(e => e.name === email.recipientName)
    const compositionBrief: CompositionBrief = {
      recipientName: email.recipientName,
      recipientTitle: recipientExecForCompose?.title || email.tier,
      company: data.customerName,
      aeName,
      tier: email.tier,
      hook: opener.text,
      bridgeContext: signalBridge.text,
      relationship: relationshipLine.text,
      products: featureBullets.text,
      peerProof: peerPattern.text,
      references: referenceLine.text,
      challengerClose: challengerFrame.text,
      ctaText: cta.text,
      campaignTheme: data.campaignThreat || data.campaignSolution || '',
    }

    const composedBody = await composeEmailBody(compositionBrief)

    let assembled: { body: string; signOff: string }
    if (composedBody) {
      assembled = { body: composedBody, signOff: signOff.text }
    } else {
      assembled = assembleEmail(
        { opener, signalBridge, relationshipLine, featureBullets, referenceLine, peerPattern, challengerFrame, cta, signOff },
        email.tier,
        voiceTokens,
        email.recipientName,
      )
    }

    const finalBody = assembled.body

    // Run quality checks on polished email
    const qualityInput: EmailCheckInput = {
      body: finalBody,
      subject: email.subject,
      tier: email.tier,
      wordBudget: voiceTokens.wordBudget,
    }
    qualityResults.push(runEmailQualityCheck(qualityInput))

    const emailHtml = renderStructuredEmailBox(
      email.recipientName,
      email.tier,
      email.subject,
      finalBody,
      assembled.signOff,
      aeName,
      data.aeEmail,
      data.aePhone,
      contact?.email,
      contact?.title,
    )

    if (email.tier === 'executive') {
      execEmailsHtml.push(emailHtml)
    } else {
      managerEmailsHtml.push(emailHtml)
    }
  }

  // Build persona list for config section
  const personaList = selection.emails.length > 0
    ? selection.emails.map(e => `${escapeHtml(e.recipientName)} (${escapeHtml(e.tier)})`).join(' · ')
    : '6 personas (3 exec + 3 mgr)'

  // Reuse existing section renderers — same CSS, same layout, same structure
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #202124;">

<h1 style="font-size: 28px; color: ${BRAND_RED}; margin: 0 0 4px 0; border-bottom: 3px solid ${BRAND_RED}; padding-bottom: 12px;">Content Campaign: ${escapeHtml(data.materialTitle)}</h1>
<p style="font-size: 22px; font-weight: bold; color: #202124; margin: 8px 0 4px 0;">${escapeHtml(data.customerName)}</p>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 24px 0;">Generated ${data.generatedDate} · ${
    data.accountTeam.length > 0
      ? data.accountTeam.map(m => `${escapeHtml(m.title)}: ${escapeHtml(m.name)}`).join(' · ')
      : `AE: ${escapeHtml(aeName)}`
  }</p>

${data.signalQuality && data.signalQuality.disposition === 'BLOCKED' ? `
<div style="background: #fce8e6; border-left: 4px solid #c5221f; padding: 12px 16px; margin: 0 0 16px 0;">
  <p style="font-size: 14px; font-weight: bold; color: #c5221f; margin: 0 0 4px 0;">Generated with Incomplete Data (${data.signalQuality.signalCompleteness}% signal coverage)</p>
  <p style="font-size: 13px; color: #5f6368; margin: 0;">Missing: ${data.signalQuality.missing.join(', ')}. Some sections may contain inferred rather than verified data.</p>
</div>` : data.signalQuality && data.signalQuality.disposition === 'DEGRADED' ? `
<div style="background: #fef7e0; border-left: 4px solid #f9ab00; padding: 12px 16px; margin: 0 0 16px 0;">
  <p style="font-size: 14px; font-weight: bold; color: #b45309; margin: 0 0 4px 0;">Some signals unavailable (${data.signalQuality.signalCompleteness}% coverage)</p>
  <p style="font-size: 13px; color: #5f6368; margin: 0;">Missing: ${data.signalQuality.missing.join(', ')}.</p>
</div>` : ''}

<table width="100%" cellpadding="10" cellspacing="0" style="background: #f8f9fa; margin-bottom: 24px;">
  <tr>
    <td style="font-size: 14px; color: #5f6368;"><strong style="color: #202124;">Source:</strong> <a href="${escapeHtml(data.materialUrl)}" style="color: #1a73e8;">${escapeHtml(data.materialTitle)}</a>${
      data.sourceAttributions && data.sourceAttributions.length > 0
        ? '<br>' + data.sourceAttributions.map(sa => `<strong>${escapeHtml(sa.name)}</strong> — ${escapeHtml(sa.description)}`).join('<br>')
        : ''
    }</td>
  </tr>
</table>

${renderContactsSection(contacts)}

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 16px 0 12px 0;">🎯 Generation Config</h2>
<table width="100%" cellpadding="6" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 16px; border: 1px solid #e8eaed;">
  <tr><td style="font-weight: bold; width: 120px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Model</td><td style="border-bottom: 1px solid #e8eaed;">Two-Pass (ADR-043): Gemini selection + deterministic assembly</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">AE Voice</td><td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(aeName)} (${voiceTokens.formality}, ${voiceTokens.assertionLevel})</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Account Team</td><td style="border-bottom: 1px solid #e8eaed;">${
    data.accountTeam.length > 0
      ? data.accountTeam.map(m => `${escapeHtml(m.name)} (${escapeHtml(m.title)})`).join(', ')
      : escapeHtml(aeName) + ' (AE)'
  }</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Email Tiers</td><td style="border-bottom: 1px solid #e8eaed;">${execEmailsHtml.length} Executive (${voiceTokens.wordBudget.exec} words) + ${managerEmailsHtml.length} Manager (${voiceTokens.wordBudget.manager} words)</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Target Personas</td><td style="border-bottom: 1px solid #e8eaed;">${personaList}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Signals Used</td><td style="border-bottom: 1px solid #e8eaed;">${data.signals.length} signals loaded</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa;">Assembly</td><td>8-block deterministic template (no LLM polish)</td></tr>
</table>

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 16px 0 12px 0;">✅ Email Quality Checklist</h2>
<table width="100%" cellpadding="4" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 20px;">
${renderQualityChecklist(qualityResults, voiceTokens.wordBudget)}
</table>

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

${renderDashboardMetrics(data.rawSignals, data.objectiveProfile)}

${data.pass0Briefs && data.pass0Briefs.length > 0
  ? renderFitFromPass0(data.customerName, data.pass0Briefs)
  : (data.fitRationale || selection.customerContext) ? renderFitRationale(data.customerName, (data.fitRationale || selection.customerContext) + (objectiveCorrelation ? '\n' + objectiveCorrelation : '')) : ''}

${renderMetricsTable(usedObjectives, data.pass0Briefs)}

${renderStructuredIntelSections(data.rawSignals, data.pass0Briefs, data.objectiveProfile)}

${data.referenceMaterials && data.referenceMaterials.length > 0 ? renderReferenceMaterials(data.referenceMaterials, data.referenceMaterialsHeading || 'Reference Material') : ''}

${data.eligibilityTable && data.eligibilityTable.length > 0 ? renderEligibilityTable(data.eligibilityTable, data.eligibilityHeading || 'Eligibility') : ''}

${data.footprint ? renderFootprintSection(data.footprint) : ''}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

${data.bvTalkingPoints && data.bvTalkingPoints.length > 0 ? renderBVTalkingPoints(data.bvTalkingPoints) : ''}

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 0 0 8px 0;">Email Templates by Role</h2>

${execEmailsHtml.length > 0 ? `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 0 0 8px 0;">📧 Executive Outreach</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">≤${voiceTokens.wordBudget.exec} words · colleague's note — forward down with 'thoughts?'</p>

${execEmailsHtml.join('\n')}` : ''}

${managerEmailsHtml.length > 0 ? `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 24px 0 8px 0;">📧 Manager Outreach</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">≤${voiceTokens.wordBudget.manager} words · technical depth — forward up with 'we should look at this'</p>

${managerEmailsHtml.join('\n')}` : ''}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 24px 0;">
<p style="text-align: center; font-size: 13px; color: #80868b;">Generated by ContentCampaign (Two-Pass ADR-043) · Source: DailyBriefDashboard Intelligence · ${data.generatedDate}</p>
</body></html>`

  return html
}
