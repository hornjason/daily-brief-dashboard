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
import { classifyPersona } from './lib/persona-classifier.ts'
import { runEmailQualityCheck, renderQualityChecklist, type EmailQualityResult, type EmailCheckInput } from './lib/email-quality-checks.ts'

const BRAND_RED = '#c41e3a'

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

// ── Template options ──

interface CampaignHTMLOptions {
  materialTitle: string
  materialUrl: string
  customerName: string
  aeName: string
  generatedDate: string
  focus?: string
  style?: string
  accountTeam?: AccountTeamMember[]
  signals?: {
    productIntel?: any
    intelligence?: any
    customerDocs?: any
    dailyBrief?: any
    subscriptions?: any
    emails?: any
    cases?: any
    accountPlan?: string
  }
  markdown: string
  signalsLoaded?: string[]
  contacts?: CampaignContact[]
  fitRationale?: string
  referenceMaterials?: ReferenceMaterial[]
  referenceMaterialsHeading?: string
  eligibilityTable?: EligibilityRow[]
  eligibilityHeading?: string
  footprint?: CampaignFootprint
  bvTalkingPoints?: BVTalkingPoint[]
}

// ── Internal types ──

interface ParsedCampaign {
  summary: string
  customerContext: string
  positioning: string[]
  valuePropsList: string[]
  emailTemplates: EmailTemplate[]
}

interface EmailTemplate {
  persona: string
  tier: string
  subject: string
  body: string
}

// ── Markdown parsing ──

function parseCampaignMarkdown(markdown: string): ParsedCampaign {
  const sections: ParsedCampaign = {
    summary: '',
    customerContext: '',
    positioning: [],
    valuePropsList: [],
    emailTemplates: [],
  }

  const sectionBlocks = markdown.split(/\n(?=#{1,3}\s)/)

  for (const block of sectionBlocks) {
    const headerMatch = block.match(/^#{1,3}\s+(.+)/)
    if (!headerMatch) continue

    const header = headerMatch[1].trim()
    const content = block.slice(headerMatch[0].length).trim()

    if (/campaign summary/i.test(header)) {
      sections.summary = content
    } else if (/customer context/i.test(header)) {
      sections.customerContext = content
    } else if (/^positioning$/i.test(header)) {
      const items = content.split(/\n\n+/).filter(p => p.trim().length > 0)
      sections.positioning = items
    } else if (/^email templates$/i.test(header)) {
      continue
    } else if (/—|–/.test(header) && !/campaign|customer|positioning|email templates/i.test(header)) {
      const tierMatch = header.match(/^(.+?)\s*[—–]\s*(.+)$/)
      if (!tierMatch) continue

      const persona = tierMatch[1].trim()
      const tier = tierMatch[2].trim()

      const subjectMatch = content.match(/\*?\*?Subject:?\*?\*?\s*(.+)/i)
      const subject = subjectMatch ? subjectMatch[1].trim() : ''

      let body = content
      if (subjectMatch) {
        const subjectIdx = content.indexOf(subjectMatch[0])
        body = content.slice(subjectIdx + subjectMatch[0].length).trim()
      }

      body = body.replace(/^\*?\*?Body:?\*?\*?\s*/i, '').trim()
      body = body.replace(/\n*(?:Best regards|Sincerely|Thanks|Regards),?[\s\S]*$/i, '')
      body = body.replace(/\n*(?:Link|Peer reference):?\s*\[?[^\]]*\]?\s*$/i, '')

      if (persona && (subject || body)) {
        sections.emailTemplates.push({ persona, tier, subject, body: body.trim() })
      }
    }
  }

  return sections
}

// ── Utility functions ──

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

function extractMetrics(signals?: CampaignHTMLOptions['signals'], objectiveProfile?: CustomerObjectiveProfile): {
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
  let profileRevenue: string | null = null
  if (objectiveProfile?.financial) {
    for (const entry of objectiveProfile.financial) {
      const text = entry.objective || ''
      const m = text.match(/\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
      if (m && /revenue|annual|full[- ]year/i.test(text)) {
        profileRevenue = `$${m[1]}`
        break
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

function extractStructuredIntel(signals?: CampaignHTMLOptions['signals']): {
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

  // Extract initiatives from intelligence company text ("## Strategic Initiatives")
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

  const planText = signals?.accountPlan || ''
  if (planText) {
    // Match multiple account plan formats:
    // Format 1: "Strategic Objectives:" section
    // Format 2: "IT and Modernization Initiatives" with bold bullet items
    // Format 3: "Why Red Hat?" section with bold items
    const objectivesSection = planText.match(/Strategic Objectives:[\s\S]*?(?=\n\s*\*\*Mapping|$)/i)
      || planText.match(/Why Red Hat[\s\S]*?Strategic Objectives:[\s\S]*?(?=\n\s*\*\*Mapping|$)/i)
      || planText.match(/Modernization Initiatives[\s\S]*?(?=\n##\s|$)/i)
      || planText.match(/Why Red Hat\?[\s\S]*?(?=\n##\s|$)/i)
    if (objectivesSection && result.initiatives.length === 0) {
      const objectiveRegex = /\*\*([^*]+)\*\*:?\s*([^*\n]+)/g
      let objMatch
      while ((objMatch = objectiveRegex.exec(objectivesSection[0])) !== null) {
        const name = objMatch[1].trim()
        const detail = objMatch[2].trim()
        if (name.length > 5 && name.length < 80 && !name.includes('Mapping') && !name.includes('Account') && !name.includes('Why Red Hat')) {
          result.initiatives.push({ name, priority: 'HIGH', detail })
        }
        if (result.initiatives.length >= 5) break
      }
    }

  }

  return result
}

function extractContacts(signals?: CampaignHTMLOptions['signals']): Array<{ name: string; title: string; email?: string }> {
  const contacts: Array<{ name: string; title: string; email?: string }> = []
  const intel = signals?.intelligence
  const companyText = typeof intel === 'string' ? intel : (intel?.company || '')

  const leadershipSection = companyText.match(/## Leadership[\s\S]*?(?=\n## |$)/i)
  if (leadershipSection) {
    const section = leadershipSection[0]
    const titleWords = 'President|CEO|CFO|CTO|CIO|COO|CMO|Chief|Executive Vice|EVP|SVP|Senior Vice President|VP|Vice President|Director|Head of'
    // Pattern 1: "Name, Title" (e.g., "Dhrupad Trivedi, CEO")
    const p1 = new RegExp(`([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)+),\\s*((?:${titleWords})[^.\\n]*)`, 'gi')
    // Pattern 2: "Title Name" (e.g., "CEO Dhrupad Trivedi" or "President and CEO Dhrupad Trivedi")
    const p2 = new RegExp(`(?:${titleWords})(?:\\s+(?:and|&)\\s+(?:${titleWords}))*[^A-Z]*([A-Z][a-z]+\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)`, 'g')
    // Pattern 3: "Name was appointed Title" (e.g., "Michelle Caron was appointed CFO")
    const p3 = new RegExp(`([A-Z][a-z]+\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)\\s+was\\s+appointed\\s+((?:${titleWords})[^.,]*)`, 'gi')
    let match
    while ((match = p1.exec(section)) !== null) {
      const name = match[1].trim()
      const title = match[2].trim()
      if (name.length > 3 && !contacts.some(c => c.name === name)) contacts.push({ name, title })
    }
    while ((match = p3.exec(section)) !== null) {
      const name = match[1].trim()
      const title = match[2].trim()
      if (name.length > 3 && !contacts.some(c => c.name === name)) contacts.push({ name, title })
    }
    while ((match = p2.exec(section)) !== null) {
      const name = match[1].trim()
      if (name.length > 3 && !contacts.some(c => c.name === name)) {
        const titleMatch = match[0].match(new RegExp(`((?:${titleWords})(?:\\s+(?:and|&)\\s+(?:${titleWords}))*)`, 'i'))
        contacts.push({ name, title: titleMatch?.[1]?.trim() || '' })
      }
    }
  }

  const planText = signals?.accountPlan || ''
  if (planText) {
    const teamSection = planText.match(/## (?:Key Stakeholders|Team Members)[\s\S]*?(?=\n## |$)/i)
    if (teamSection) {
      const memberRegex = /\*\*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\*\*:?\s*([^.\n]+)/g
      let match
      while ((match = memberRegex.exec(teamSection[0])) !== null) {
        const name = match[1].trim()
        const title = match[2].trim()
        if (!contacts.some(c => c.name === name)) {
          contacts.push({ name, title })
        }
      }
    }
  }

  return contacts
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
    <td style="border-bottom: 1px solid #e8eaed; font-size: 13px; color: #5f6368;">${escapeHtml(m.keyTakeaway)}</td>
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

function renderEmailBox(email: EmailTemplate, aeName: string): string {
  return `<div style="border: 2px solid #dadce0; margin-bottom: 24px;">
  <div style="background: ${BRAND_RED}; padding: 12px 20px;">
    <span style="color: white; font-size: 16px; font-weight: bold;">📧  ${escapeHtml(email.persona)}</span>
  </div>
  <div style="padding: 8px 20px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">
    <p style="font-size: 14px; color: #5f6368; margin: 0;">Subject: <strong style="color: #202124;">${escapeHtml(email.subject)}</strong></p>
  </div>
  <div style="padding: 20px;">
    ${convertMarkdownBullets(email.body)}
    <div style="margin-top: 20px; padding-top: 14px; border-top: 3px solid ${BRAND_RED};">
      <p style="font-size: 16px; font-weight: bold; margin: 0;">${escapeHtml(aeName)}</p>
      <p style="font-size: 14px; color: #5f6368; margin: 2px 0 0 0;">Account Executive · <span style="color: ${BRAND_RED}; font-weight: bold;">Red Hat</span></p>
    </div>
  </div>
</div>`
}

// ── Main export ──

export function generateCampaignHTML(options: CampaignHTMLOptions): string {
  const parsed = parseCampaignMarkdown(options.markdown)
  const metrics = extractMetrics(options.signals)
  const structured = extractStructuredIntel(options.signals)

  // Resolve contacts: prefer explicit, fall back to extracted
  const contacts: CampaignContact[] = options.contacts ?? extractContacts(options.signals).map(c => ({
    name: c.name,
    title: c.title,
    email: c.email,
  }))

  // Split emails by tier
  const execEmails = parsed.emailTemplates.filter(e => /executive/i.test(e.tier))
  const managerEmails = parsed.emailTemplates.filter(e => /manager/i.test(e.tier))
  const otherEmails = parsed.emailTemplates.filter(e => !(/executive/i.test(e.tier) || /manager/i.test(e.tier)))
  const primaryEmails = execEmails.length > 0 ? execEmails : (managerEmails.length > 0 ? otherEmails : parsed.emailTemplates)

  // Fit rationale: prefer explicit, fall back to parsed customer context
  const fitContent = options.fitRationale || parsed.customerContext

  // Run quality checks against parsed emails
  const defaultWordBudget = { exec: 120, manager: 200 }
  const markdownQualityResults: EmailQualityResult[] = parsed.emailTemplates.map(email => {
    const tier: 'executive' | 'manager' = /executive/i.test(email.tier) ? 'executive' : 'manager'
    return runEmailQualityCheck({
      body: email.body,
      subject: email.subject,
      tier,
      wordBudget: defaultWordBudget,
    })
  })

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #202124;">

<h1 style="font-size: 28px; color: ${BRAND_RED}; margin: 0 0 4px 0; border-bottom: 3px solid ${BRAND_RED}; padding-bottom: 12px;">Content Campaign: ${escapeHtml(options.materialTitle)}</h1>
<p style="font-size: 22px; font-weight: bold; color: #202124; margin: 8px 0 4px 0;">${escapeHtml(options.customerName)}</p>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 24px 0;">Generated ${options.generatedDate} · ${
  options.accountTeam && options.accountTeam.length > 0
    ? options.accountTeam.map(m => `${escapeHtml(m.title)}: ${escapeHtml(m.name)}`).join(' · ')
    : `AE: ${escapeHtml(options.aeName)}`
}${options.focus ? ` · Focus: ${escapeHtml(options.focus)}` : ''}${options.style ? ` · Style: ${escapeHtml(options.style)}` : ''}</p>

<table width="100%" cellpadding="10" cellspacing="0" style="background: #f8f9fa; margin-bottom: 24px;">
  <tr>
    <td style="font-size: 14px; color: #5f6368;"><strong style="color: #202124;">Source:</strong> <a href="${escapeHtml(options.materialUrl)}" style="color: #1a73e8;">${escapeHtml(options.materialTitle)}</a></td>
  </tr>
</table>

${renderContactsSection(contacts)}

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 16px 0 12px 0;">🎯 Generation Config</h2>
<table width="100%" cellpadding="6" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 16px; border: 1px solid #e8eaed;">
  <tr><td style="font-weight: bold; width: 120px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Model</td><td style="border-bottom: 1px solid #e8eaed;">Gemini 2.5 Pro (Vertex AI)</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">AE Voice</td><td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(options.aeName)}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Account Team</td><td style="border-bottom: 1px solid #e8eaed;">${
    options.accountTeam && options.accountTeam.length > 0
      ? options.accountTeam.map(m => `${escapeHtml(m.name)} (${escapeHtml(m.title)})`).join(', ')
      : escapeHtml(options.aeName) + ' (AE)'
  }</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Email Tiers</td><td style="border-bottom: 1px solid #e8eaed;">3 Executive (≤120 words) + 3 Manager (200-250 words)</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Target Personas</td><td style="border-bottom: 1px solid #e8eaed;">${parsed.emailTemplates.length > 0 ? parsed.emailTemplates.map(e => `${escapeHtml(e.persona)} (${escapeHtml(e.tier)})`).join(' · ') : '6 personas (3 exec + 3 mgr)'}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Signals Used</td><td style="border-bottom: 1px solid #e8eaed;">${options.signalsLoaded?.join(', ') || 'Intelligence brief, customer docs, subscriptions, cases, account plan'}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa;">Council Rules</td><td>11 council-validated email design rules (see checklist below)</td></tr>
</table>

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 16px 0 12px 0;">✅ Email Quality Checklist</h2>
<table width="100%" cellpadding="4" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 20px;">
${renderQualityChecklist(markdownQualityResults, defaultWordBudget)}
</table>

<hr style="border: none; border-top: 1px solid #dadce0; margin: 24px 0;">

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 0 0 16px 0;">📊 Customer Intelligence Dashboard</h2>

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
</table>

${fitContent ? renderFitRationale(options.customerName, fitContent) : ''}

${structured.initiatives.length > 0 ? `
<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">🎯 Strategic Initiatives</h3>
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
</table>` : ''}

${structured.competitors.length > 0 ? `
<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚔️ Competitive Position</h3>
${structured.differentiation ? `<p style="font-size: 14px; color: #5f6368; margin: 0 0 12px 0;"><strong>Differentiation:</strong> ${escapeHtml(structured.differentiation)}</p>` : ''}
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Competitor</td>
    ${structured.competitors.some(c => c.threat) ? `<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Threat</td>` : ''}
    ${structured.competitors.some(c => c.advantage) ? `<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Advantage</td>` : ''}
  </tr>
  ${structured.competitors.map(c => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHtml(c.name)}</td>
    ${structured.competitors.some(cc => cc.threat) ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(c.threat)}</td>` : ''}
    ${structured.competitors.some(cc => cc.advantage) ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(c.advantage)}</td>` : ''}
  </tr>`).join('\n')}
</table>` : ''}

${options.referenceMaterials && options.referenceMaterials.length > 0 ? renderReferenceMaterials(options.referenceMaterials, options.referenceMaterialsHeading || 'Reference Material') : ''}

${options.eligibilityTable && options.eligibilityTable.length > 0 ? renderEligibilityTable(options.eligibilityTable, options.eligibilityHeading || 'Eligibility') : ''}

${options.footprint ? renderFootprintSection(options.footprint) : ''}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

${parsed.positioning.length > 0 ? `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 0 0 20px 0;">Positioning Matches</h2>

${parsed.positioning.map((p, i) => `<div style="border-left: 4px solid ${BRAND_RED}; padding: 16px 20px; margin-bottom: 20px; background: #fef7f7;">
  <p style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: ${BRAND_RED}; font-weight: bold; margin: 0 0 8px 0;">MATCH #${i + 1}</p>
  <p style="font-size: 15px; color: #3c4043; margin: 0; line-height: 1.6;">${applyInlineFormatting(escapeHtml(p))}</p>
</div>`).join('\n')}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">` : ''}

${options.bvTalkingPoints && options.bvTalkingPoints.length > 0 ? renderBVTalkingPoints(options.bvTalkingPoints) : ''}

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 0 0 8px 0;">Email Templates by Role</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">Copy each email body and paste into Gmail compose. Rich formatting transfers automatically.</p>

${primaryEmails.map(email => renderEmailBox(email, options.aeName)).join('\n')}

${managerEmails.length > 0 ? `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 24px 0 8px 0;">📧 Manager Outreach</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">≤200 words · technical depth — forward up with 'we should look at this'</p>

${managerEmails.map(email => renderEmailBox(email, options.aeName)).join('\n')}` : ''}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 24px 0;">
<p style="text-align: center; font-size: 13px; color: #80868b;">Generated by ContentCampaign · Source: DailyBriefDashboard Intelligence · ${options.generatedDate}</p>
</body></html>`

  return html
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
]

const SKU_PATTERN = /\b[A-Z]{2,4}\d{4,6}\b/g

export function sanitizeCreepyLines(text: string): string {
  if (!text) return ''

  const sentences = text.split(/(?<=\.)\s+|\n/)
  const cleaned = sentences
    .filter(sentence => !CREEPY_SENTENCE_PATTERNS.some(p => p.test(sentence)))
    .map(sentence => sentence.replace(SKU_PATTERN, '').replace(/\s{2,}/g, ' ').trim())
    .filter(s => s.length > 0)

  if (cleaned.length === 0) return text.replace(SKU_PATTERN, '').trim()

  let result = cleaned.join(' ')
  result = result.replace(/\.\s*\./g, '.')
  // Preserve trailing period if original had one
  if (text.trimEnd().endsWith('.') && !result.trimEnd().endsWith('.')) result += '.'
  return result
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
  if (pass0Briefs && pass0Briefs.length > 0) {
    let html = '<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">Business Metrics Used in Outreach</h3>'
    html += '<table width="100%" cellpadding="6" cellspacing="0" style="border: 1px solid #dadce0; font-size: 13px;">'
    html += '<tr style="background: #f8f9fa; font-weight: bold;"><td>Category</td><td>Metric</td><td>Used In</td></tr>'
    for (const brief of pass0Briefs) {
      const label = ROLE_LABELS[brief.role] || brief.role
      html += `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(brief.objectiveMatch)}</td><td>${escapeHtml(brief.suggestedTitle)}</td></tr>`
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
    const cleanObj = objective
      .replace(/^(?:Revenue Trajectory|Profitability|Balance Sheet|Financial Health|Growth Outlook|Reiterated[^:]*?)[:\s]+/i, '')
      .replace(/^(?:Acquisition of|Major|New|Strong)[^—–]+?\s[—–]\s*/i, '')
      .replace(/^(?:Raised|Lowered|Maintained|Updated|Revised)[^—–]+?\s[—–]\s*/i, '')
      .trim()
    const objText = cleanObj.length > 80
      ? (cleanObj.split(/[.;]/)[0]?.trim() || cleanObj.slice(0, 80))
      : cleanObj
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
    return renderTemplate(preMatch.category, preMatch.entry.objective)
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
  challengerDataPoint: string
  customOpener: string
  featureApplications: string[]
  signalBridge: string
  referenceLine?: string
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
  sourceUrls?: string[]
  campaignThreat?: string
  campaignSolution?: string
  objectiveProfile?: CustomerObjectiveProfile
  preMatchedMetrics?: import('./lib/persona-classifier.ts').PreMatchedMetric[]
  preMatchedPeerProofs?: import('./lib/persona-classifier.ts').PreMatchedPeerProof[]
  pass0Briefs?: import('./lib/persona-selector.ts').PersonaBrief[]
  signalQuality?: { disposition: string; signalCompleteness: number; missing: string[] }
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
  customOpener?: string,
): string {
  const firstName = recipientName.split(' ')[0]
  if (customOpener) return `${firstName}, ${customOpener.replace(/\s*\(Signal\s*\d+\)\s*/gi, ' ').trim()}`

  console.warn(`[template] FALLBACK: buildOpener using generic pattern for ${recipientName} — customOpener not provided`)
  const signal = signals[signalIndex]
  if (!signal) return `Hi ${firstName},`

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

  switch (openerVariant) {
    case 0:
      return `Hi ${firstName}, ${observation} tells me this is shaping how your teams operate going forward.`
    case 1:
      return `Hi ${firstName}, ${observation} is driving new priorities for leaders in your position.`
    case 2:
      return `Hi ${firstName}, with ${observation}, there is an opportunity worth examining.`
    default:
      return `Hi ${firstName}, ${observation} tells me this is shaping how your teams operate going forward.`
  }
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
}

export function buildSignalBridge(
  signal: Signal | undefined,
  featureKeys: string[],
  customBridge?: string,
): string {
  if (customBridge) return customBridge.replace(/\s*\(Signal\s*\d+\)\s*/gi, ' ').trim()
  console.warn(`[template] FALLBACK: buildSignalBridge using generic pattern — customBridge not provided`)
  if (!signal || featureKeys.length === 0) return ''

  const primaryKey = featureKeys[0]
  const product = primaryKey.includes('ansible') ? 'ansible'
    : primaryKey.includes('openshift') ? 'openshift'
    : (primaryKey.includes('rhel') || primaryKey.includes('enterprise-linux')) ? 'rhel'
    : null
  const signalType = signal.type === 'news' ? 'news' : 'default'

  if (product) return SIGNAL_BRIDGES[`${product}-${signalType}`]
  return `This aligns with how organizations are using Red Hat infrastructure to turn ${signalType === 'news' ? 'these shifts' : 'this kind of signal'} into operational advantage.`
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
): string {
  if (!subscriptions || subscriptions.length === 0) return ''

  const activeProducts = subscriptions
    .filter(s => s.status === 'Active')
    .map(s => resolveProductDisplayName(s.productDescription || s.product || s.sku || ''))
    .filter(p => p.length > 0)

  const unique = [...new Set(activeProducts)]
  if (unique.length === 0) return ''

  const linked = unique.map(linkProductName)
  if (linked.length === 1) return `Your teams already rely on ${linked[0]}.`
  const display = linked.slice(0, 3)
  return `Your teams already rely on ${display.slice(0, -1).join(', ')} and ${display[display.length - 1]}.`
}

/**
 * Block 4: Feature bullets — 3 bullets, each with name, URL, and capability description.
 * Feature name and URL resolved via resolveFeatureUrl(key) from feature-url-registry.ts.
 */
export function buildFeatureBullets(
  featureKeys: string[],
  tier: 'executive' | 'manager',
  featureApplications?: string[],
  priorText?: string,
): string {
  const bullets: Array<{ featureName: string; url: string; applicationSentence: string }> = []
  for (let i = 0; i < featureKeys.slice(0, 3).length; i++) {
    const key = featureKeys[i]
    const entry = resolveFeatureEntry(key)
    if (!entry) continue
    const hasCustom = featureApplications?.[i]
    if (!hasCustom) console.warn(`[template] FALLBACK: buildFeatureBullets using generic description for ${key}`)
    const applicationSentence = (hasCustom || getCapabilityDescription(key)).replace(/\s*\(Signal\s*\d+\)\s*/gi, ' ').trim()
    bullets.push({ featureName: entry.featureName, url: entry.url, applicationSentence })
  }

  if (bullets.length === 0) return ''

  return bullets.map(b =>
    `• [${b.featureName}](${b.url}) — ${b.applicationSentence}`
  ).join('\n')
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

function formatPeerProofLine(customer: string, outcome: string): string {
  if (VERB_PATTERN.test(outcome)) return `${customer} ${outcome}`
  return `${customer} → ${outcome}`
}

export function buildPeerPattern(
  peerProof: { playName: string; exampleIndex: number } | null,
  structuredPlays: StructuredPlay[],
  preMatchedProof?: { proof: { customer: string; outcome: string } },
): string {
  if (preMatchedProof) {
    return formatPeerProofLine(preMatchedProof.proof.customer, preMatchedProof.proof.outcome)
  }

  if (peerProof) {
    const target = peerProof.playName.toLowerCase()
    const play = structuredPlays.find(p => p.name === peerProof.playName)
      || structuredPlays.find(p => p.name.toLowerCase().includes(target) || target.includes(p.name.toLowerCase()))
    const example = play?.realWorldExamples?.[peerProof.exampleIndex]
    if (example) return formatPeerProofLine(example.customer, example.outcome)
    if (!play) console.warn(`[template] PEER PROOF MISS: play "${peerProof.playName}" not found in ${structuredPlays.map(p => p.name).join(', ')}`)
  }

  for (const play of structuredPlays) {
    if (play.realWorldExamples?.[0]) return formatPeerProofLine(play.realWorldExamples[0].customer, play.realWorldExamples[0].outcome)
    const metric = play.extractedMetrics?.[0]
    if (metric) return `Organizations in similar positions have seen ${metric.value} — ${metric.context}.`
  }

  return ''
}

/**
 * Block 6: Challenger frame — wraps the Gemini-selected data point.
 * Fixed framing structure, selected data fills in.
 */
const CHALLENGER_CLOSERS = [
  'That distinction creates measurable advantage for organizations that act on it.',
  'This creates a clear window for organizations that move first.',
  'Companies that recognize this early gain a structural cost advantage.',
  'The organizations that address this proactively will carry a permanent cost advantage.',
]

export function buildChallengerFrame(challengerDataPoint: string, emailIndex: number = 0): string {
  if (!challengerDataPoint) return ''
  const trimmed = challengerDataPoint.replace(/\s*\(Signal\s*\d+\)\s*/gi, ' ').trim()
  const closer = CHALLENGER_CLOSERS[emailIndex % CHALLENGER_CLOSERS.length]
  if (trimmed.endsWith('.')) return `${trimmed} ${closer}`
  return `${trimmed}. ${closer}`
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
): string {
  const firstName = recipientName.split(' ')[0]
  const { deliverable, verb } = CTA_OPTIONS[emailIndex % CTA_OPTIONS.length]

  const now = new Date()
  const daysOut = 7 + emailIndex * 2
  const date1 = new Date(now.getTime() + daysOut * 24 * 60 * 60 * 1000)
  const date2 = new Date(date1.getTime() + 7 * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

  return `${verb} ${fmt(date1)} work for ${deliverable}? If that week is tight, ${fmt(date2)} works just as well.`
}

/**
 * Block 8: Sign-off — AE name + title.
 */
export function buildSignOff(aeName: string, aeEmail?: string, aePhone?: string): string {
  let signOff = `${aeName}\nAccount Executive · Red Hat`
  if (aeEmail) signOff += `\n${aeEmail}`
  if (aePhone) signOff += ` | M: ${aePhone}`
  return signOff
}

const TRUSTED_URL_DOMAINS = ['redhat.com', 'developers.redhat.com']

const INTERNAL_URL_PATTERNS = [
  /docs\.google\.com/,
  /drive\.google\.com/,
  /slides\.google\.com/,
  /access\.redhat\.com/,
  /content\.redhat\.com/,
  /source\.redhat\.com/,
  /mojo\.redhat\.com/,
  /salesforce\.com/,
  /seismic\.com/,
]

export function isInternalUrl(url: string): boolean {
  return INTERNAL_URL_PATTERNS.some(p => p.test(url))
}

export function isHomepageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '')
    return path.length < 5 || path === '/en'
  } catch {
    return true
  }
}

function sanitizeReferenceLine(line: string, sourceUrls?: string[]): string {
  if (!line) return ''
  const sourceDomains = new Set<string>()
  for (const u of sourceUrls ?? []) {
    try {
      if (!isInternalUrl(u)) sourceDomains.add(new URL(u).hostname)
    } catch {}
  }
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
 * Assemble email from composable blocks, applying word budget and tier formatting.
 */
export function assembleEmail(
  blocks: {
    opener: string
    signalBridge: string
    relationshipLine: string
    featureBullets: string
    referenceLine: string
    peerPattern: string
    challengerFrame: string
    cta: string
    signOff: string
  },
  tier: 'executive' | 'manager',
  voiceTokens: ReturnType<typeof getVoiceTokens>,
): { body: string; signOff: string } {
  const bodyParts = [
    blocks.opener,
    blocks.signalBridge,
    blocks.relationshipLine,
    blocks.featureBullets,
    blocks.referenceLine,
    blocks.peerPattern,
    blocks.challengerFrame,
    blocks.cta,
  ].filter(b => b.length > 0)

  let body = bodyParts.join('\n\n')

  // Apply voice formality and assertion level
  body = applyFormality(body, voiceTokens.formality, voiceTokens.assertionLevel)

  const maxWords = tier === 'executive' ? voiceTokens.wordBudget.exec : voiceTokens.wordBudget.manager

  let wordCount = countWords(body)
  const trimThreshold = maxWords * 1.5
  if (wordCount > trimThreshold) {
    // Trim challenger frame first
    if (blocks.challengerFrame) {
      const trimmedParts = bodyParts.filter(b => b !== blocks.challengerFrame)
      body = trimmedParts.join('\n\n')
      body = applyFormality(body, voiceTokens.formality, voiceTokens.assertionLevel)
      wordCount = countWords(body)
    }
    // If still over, trim signal bridge
    if (wordCount > trimThreshold && blocks.signalBridge) {
      const trimmedParts = bodyParts.filter(b => b !== blocks.challengerFrame && b !== blocks.signalBridge)
      body = trimmedParts.join('\n\n')
      body = applyFormality(body, voiceTokens.formality, voiceTokens.assertionLevel)
    }
  }

  return { body, signOff: blocks.signOff }
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

function renderDashboardMetrics(rawSignals?: CampaignHTMLOptions['signals'], objectiveProfile?: CustomerObjectiveProfile): string {
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

function renderStructuredIntelSections(rawSignals?: CampaignHTMLOptions['signals']): string {
  const structured = extractStructuredIntel(rawSignals)
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

  if (structured.competitors.length > 0) {
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

export function generateCampaignFromStructured(
  selection: StructuredCampaignSelection,
  data: StructuredCampaignData,
): string {
  const voiceTokens = getVoiceTokens(data.voiceProfile)

  // Sanitize customer-facing fields from Gemini selection output
  selection.customerContext = sanitizeCreepyLines(selection.customerContext)
  selection.positioning = sanitizeCreepyLines(selection.positioning)
  for (const email of selection.emails) {
    email.customOpener = sanitizeCreepyLines(email.customOpener)
    email.signalBridge = sanitizeCreepyLines(email.signalBridge)
    email.challengerDataPoint = sanitizeCreepyLines(email.challengerDataPoint)
    email.featureApplications = email.featureApplications.map(fa => sanitizeCreepyLines(fa))
    if (email.referenceLine) email.referenceLine = sanitizeCreepyLines(email.referenceLine)
  }

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

  // Build per-email HTML
  const execEmailsHtml: string[] = []
  const managerEmailsHtml: string[] = []

  for (let i = 0; i < selection.emails.length; i++) {
    const email = selection.emails[i]

    // Find matching contact by exact recipientName
    const contact = data.resolvedExecs.find(e => e.name === email.recipientName)
    if (!contact) continue

    const openerVariant = i % 3
    const signal = data.signals[email.signalIndex]

    // Build all 8 blocks
    const opener = buildOpener(email.signalIndex, data.signals, openerVariant, email.recipientName, email.customOpener)
    const rawSignalBridge = buildSignalBridge(signal, email.featureKeys, email.signalBridge)
    const recipientExec = data.resolvedExecs.find(e => e.name === email.recipientName)
    const recipientTitle = recipientExec?.title || email.tier
    const preMatch = data.preMatchedMetrics?.find(pm => pm.recipientName === email.recipientName)
    const objectiveContext = sanitizeCreepyLines(renderObjectiveBlock(
      data.objectiveProfile,
      campaignTheme,
      recipientTitle,
      preMatch,
    ))
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
    const signalBridge = objectiveContext ? `${rawSignalBridge} ${objectiveContext}` : rawSignalBridge
    const relationshipLine = buildRelationshipLine(data.subscriptions)
    const featureBullets = buildFeatureBullets(email.featureKeys, email.tier, email.featureApplications, `${opener} ${signalBridge}`)
    const referenceLine = sanitizeReferenceLine(email.referenceLine || '', data.sourceUrls)
    const preMatchedProof = data.preMatchedPeerProofs?.find(p => p.recipientName === email.recipientName)
    const peerPattern = buildPeerPattern(email.peerProof, data.structuredPlays, preMatchedProof)
    const challengerFrame = buildChallengerFrame(email.challengerDataPoint, i)
    const cta = buildCTA(aeName, email.recipientName, data.customerName, i)
    const signOff = buildSignOff(aeName, data.aeEmail, data.aePhone)

    // Assemble with tier-appropriate formatting
    const assembled = assembleEmail(
      { opener, signalBridge, relationshipLine, featureBullets, referenceLine, peerPattern, challengerFrame, cta, signOff },
      email.tier,
      voiceTokens,
    )

    // Run quality checks on assembled email
    const qualityInput: EmailCheckInput = {
      body: assembled.body,
      subject: email.subject,
      tier: email.tier,
      wordBudget: voiceTokens.wordBudget,
    }
    qualityResults.push(runEmailQualityCheck(qualityInput))

    const emailHtml = renderStructuredEmailBox(
      email.recipientName,
      email.tier,
      email.subject,
      assembled.body,
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

${data.signalQuality && data.signalQuality.disposition !== 'PROCEED' ? `
<div style="background: #fce8e6; border-left: 4px solid #c5221f; padding: 12px 16px; margin: 0 0 16px 0;">
  <p style="font-size: 14px; font-weight: bold; color: #c5221f; margin: 0 0 4px 0;">Generated with Incomplete Data (${data.signalQuality.signalCompleteness}% signal coverage)</p>
  <p style="font-size: 13px; color: #5f6368; margin: 0;">Missing: ${data.signalQuality.missing.join(', ')}. Some sections may contain inferred rather than verified data.</p>
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
  <tr><td style="font-weight: bold; background: #f8f9fa;">Assembly</td><td>8-block deterministic template — zero LLM in email body</td></tr>
</table>

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: ${BRAND_RED}; margin: 16px 0 12px 0;">✅ Email Quality Checklist</h2>
<table width="100%" cellpadding="4" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 20px;">
${renderQualityChecklist(qualityResults, voiceTokens.wordBudget)}
</table>

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

${renderDashboardMetrics(data.rawSignals, data.objectiveProfile)}

${(data.fitRationale || selection.customerContext) ? renderFitRationale(data.customerName, (data.fitRationale || selection.customerContext) + (objectiveCorrelation ? '\n' + objectiveCorrelation : '')) : ''}

${renderMetricsTable(usedObjectives, data.pass0Briefs)}

${renderStructuredIntelSections(data.rawSignals)}

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
