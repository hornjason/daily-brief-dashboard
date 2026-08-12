/**
 * HTML Template Generator for ContentCampaign
 * Matches the gold standard output from ContentCampaign skill
 *
 * Gold standard: test/fixtures/campaign-gold-standard.html
 * Convergence test: test/unit/campaign-gold-standard.test.ts
 */

import type { AccountTeamMember } from './types.ts'
import { escapeHtml, applyInlineFormatting } from './lib/markdown-to-html.ts'

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
      html += `<p style="font-size: 15px; padding: 4px 0 4px 24px; margin: 4px 0; position: relative;"><span style="position: absolute; left: 8px; color: #c41e3a; font-size: 18px;">•</span>${bulletText}</p>\n`
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

function extractMetrics(signals?: CampaignHTMLOptions['signals']): {
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

  const intel = signals?.intelligence
  if (!intel) return defaults

  const companyText = typeof intel === 'string' ? intel : (intel.company || '')

  const revenueMatch = companyText.match(/\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
    || companyText.match(/revenue[^$]*\$(\d[\d,.]*\s*(?:billion|million|[BMK])?)/i)

  const employeesMatch = companyText.match(/([\d,]+)\s*employees/i)
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
        productName = desc.replace(/Red Hat\s*/i, '').replace(/,\s.*$/, '').split(' ').slice(0, 4).join(' ')
      }
    }
  }

  return {
    revenue: revenueMatch?.[1] ? `$${revenueMatch[1]}` : defaults.revenue,
    employees: employeesMatch?.[1] ?? defaults.employees,
    productInstances,
    productName,
  }
}

function extractStructuredIntel(signals?: CampaignHTMLOptions['signals']): {
  initiatives: Array<{ name: string; priority: string; detail: string }>
  competitors: Array<{ name: string; threat: string; advantage: string }>
  guardrails: { never: string[]; careful: string[]; safe: string[] }
  differentiation?: string
} {
  const result = {
    initiatives: [] as Array<{ name: string; priority: string; detail: string }>,
    competitors: [] as Array<{ name: string; threat: string; advantage: string }>,
    guardrails: { never: [] as string[], careful: [] as string[], safe: [] as string[] },
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
      const bulletRegex = /[*\-]\s+(?:\*\*)?([^*\n]+?)(?:\*\*)?$/gm
      while ((match = bulletRegex.exec(section)) !== null) {
        const name = match[1].trim()
        if (name.length > 1 && name.length < 50 && !name.match(/^(switching|integrated|specialized|established|market)/i)) {
          result.competitors.push({ name, threat: '', advantage: '' })
        }
        if (result.competitors.length >= 5) break
      }
      if (differentiation) {
        result.differentiation = differentiation
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
    if (objectivesSection) {
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

    const risksSection = planText.match(/Account Plan Risks[\s\S]*?(?=\n## |$)/i)
    if (risksSection) {
      const riskItems = risksSection[0].match(/\*\*([^*]+)\*\*:?\s*([^*\n]+)/g)
      if (riskItems) {
        for (const item of riskItems.slice(0, 5)) {
          const clean = item.replace(/\*\*/g, '').split(':')[0].trim()
          if (clean.length > 3 && clean.length < 60) {
            result.guardrails.careful.push(clean)
          }
        }
      }
    }
  }

  result.guardrails.never = ['Pipeline opportunities', 'RHEL Private Offer', 'Support cases', 'Subscription counts', 'Layoff numbers']
  if (result.guardrails.careful.length === 0) {
    result.guardrails.careful = ['Leadership changes — frame around strategy, not departures']
  }
  result.guardrails.safe = ['Public earnings', 'CTO/CIO appointments', 'AI strategy', 'Competitor moves', 'Existing Red Hat relationship']

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

  return `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 16px 0 12px 0;">👥 Target Contacts</h2>
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
  ${materials.map(m => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${m.url ? `<a href="${escapeHtml(m.url)}" style="color: #1a73e8;">${escapeHtml(m.resource)}</a>` : escapeHtml(m.resource)}</td>
    <td style="border-bottom: 1px solid #e8eaed; font-size: 13px; color: #5f6368;">${escapeHtml(m.keyTakeaway)}</td>
  </tr>`).join('\n')}
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
  <p style="margin: 4px 0;"><strong>Current:</strong> ${escapeHtml(footprint.current)}</p>
  <p style="margin: 4px 0;"><strong>Expansion:</strong> ${escapeHtml(footprint.expansion)}</p>
</div>`
}

function renderBVTalkingPoints(points: BVTalkingPoint[]): string {
  return `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 16px 0 12px 0;">💬 BV Talking Points</h2>
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
  <div style="background: #c41e3a; padding: 12px 20px;">
    <span style="color: white; font-size: 16px; font-weight: bold;">📧  ${escapeHtml(email.persona)}</span>
  </div>
  <div style="padding: 8px 20px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">
    <p style="font-size: 14px; color: #5f6368; margin: 0;">Subject: <strong style="color: #202124;">${escapeHtml(email.subject)}</strong></p>
  </div>
  <div style="padding: 20px;">
    ${convertMarkdownBullets(email.body)}
    <div style="margin-top: 20px; padding-top: 14px; border-top: 3px solid #c41e3a;">
      <p style="font-size: 16px; font-weight: bold; margin: 0;">${escapeHtml(aeName)}</p>
      <p style="font-size: 14px; color: #5f6368; margin: 2px 0 0 0;">Account Executive · <span style="color: #c41e3a; font-weight: bold;">Red Hat</span></p>
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

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #202124;">

<h1 style="font-size: 28px; color: #c41e3a; margin: 0 0 4px 0; border-bottom: 3px solid #c41e3a; padding-bottom: 12px;">Content Campaign: ${escapeHtml(options.materialTitle)}</h1>
<p style="font-size: 22px; font-weight: bold; color: #202124; margin: 8px 0 4px 0;">${escapeHtml(options.customerName)}</p>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 24px 0;">Generated ${options.generatedDate} · ${
  options.accountTeam && options.accountTeam.length > 0
    ? options.accountTeam.map(m => `${m.role.toUpperCase()}: ${escapeHtml(m.name)}`).join(' · ')
    : `AE: ${escapeHtml(options.aeName)}`
}${options.focus ? ` · Focus: ${escapeHtml(options.focus)}` : ''}${options.style ? ` · Style: ${escapeHtml(options.style)}` : ''}</p>

<table width="100%" cellpadding="10" cellspacing="0" style="background: #f8f9fa; margin-bottom: 24px;">
  <tr>
    <td style="font-size: 14px; color: #5f6368;"><strong style="color: #202124;">Source:</strong> <a href="${escapeHtml(options.materialUrl)}" style="color: #1a73e8;">${escapeHtml(options.materialTitle)}</a></td>
  </tr>
</table>

${renderContactsSection(contacts)}

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 16px 0 12px 0;">🎯 Generation Config</h2>
<table width="100%" cellpadding="6" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 16px; border: 1px solid #e8eaed;">
  <tr><td style="font-weight: bold; width: 120px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Model</td><td style="border-bottom: 1px solid #e8eaed;">Gemini 2.5 Pro (Vertex AI)</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">AE Voice</td><td style="border-bottom: 1px solid #e8eaed;">${escapeHtml(options.aeName)}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Account Team</td><td style="border-bottom: 1px solid #e8eaed;">${
    options.accountTeam && options.accountTeam.length > 0
      ? options.accountTeam.map(m => `${escapeHtml(m.name)} (${m.role.toUpperCase()})`).join(', ')
      : escapeHtml(options.aeName) + ' (AE)'
  }</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Email Tiers</td><td style="border-bottom: 1px solid #e8eaed;">3 Executive (≤90 words) + 3 Manager (200-250 words)</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Target Personas</td><td style="border-bottom: 1px solid #e8eaed;">${parsed.emailTemplates.length > 0 ? parsed.emailTemplates.map(e => `${escapeHtml(e.persona)} (${escapeHtml(e.tier)})`).join(' · ') : '6 personas (3 exec + 3 mgr)'}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Signals Used</td><td style="border-bottom: 1px solid #e8eaed;">${options.signalsLoaded?.join(', ') || 'Intelligence brief, customer docs, subscriptions, cases, account plan'}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa;">Council Rules</td><td>11 council-validated email design rules (see checklist below)</td></tr>
</table>

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 16px 0 12px 0;">✅ Email Quality Checklist</h2>
<table width="100%" cellpadding="4" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 20px;">
  <tr><td style="padding: 2px 0;">☐ Word limits: Executive ≤90 words | Manager 200-250 words</td></tr>
  <tr><td style="padding: 2px 0;">☐ Technical observations only — no firmographic facts</td></tr>
  <tr><td style="padding: 2px 0;">☐ Statements only — no questions anywhere</td></tr>
  <tr><td style="padding: 2px 0;">☐ Per-bullet links to Red Hat product pages</td></tr>
  <tr><td style="padding: 2px 0;">☐ Named peer company with concrete metric</td></tr>
  <tr><td style="padding: 2px 0;">☐ Forward-worthy: exec forwards down, manager forwards up</td></tr>
  <tr><td style="padding: 2px 0;">☐ Competitor-swap test: product name swap shouldn't work</td></tr>
  <tr><td style="padding: 2px 0;">☐ Creepy line check: no internal data the recipient wouldn't expect</td></tr>
  <tr><td style="padding: 2px 0;">☐ Subject = observation about their world (no product names)</td></tr>
  <tr><td style="padding: 2px 0;">☐ No filler phrases</td></tr>
  <tr><td style="padding: 2px 0;">☐ Relationship context: ONE sentence about existing Red Hat products</td></tr>
</table>

<hr style="border: none; border-top: 1px solid #dadce0; margin: 24px 0;">

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 0 0 16px 0;">📊 Customer Intelligence Dashboard</h2>

<table width="100%" cellpadding="0" cellspacing="8" style="margin-bottom: 20px;">
  <tr>
    <td width="33%" style="background: #fef7f7; padding: 14px; text-align: center; border-radius: 6px;">
      <div style="font-size: 24px; font-weight: bold; color: #c41e3a;">${metrics.revenue}</div>
      <div style="font-size: 12px; color: #5f6368;">Annual Revenue</div>
    </td>
    <td width="33%" style="background: #fef7f7; padding: 14px; text-align: center; border-radius: 6px;">
      <div style="font-size: 24px; font-weight: bold; color: #c41e3a;">${metrics.employees}</div>
      <div style="font-size: 12px; color: #5f6368;">Employees</div>
    </td>
    <td width="33%" style="background: #fef7f7; padding: 14px; text-align: center; border-radius: 6px;">
      <div style="font-size: 24px; font-weight: bold; color: #c41e3a;">${metrics.productInstances}</div>
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

<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚠️ Outreach Guardrails</h3>
<p style="font-size: 14px; margin: 4px 0;"><span style="background: #fce8e6; color: #c5221f; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">NEVER</span> ${structured.guardrails.never.map(g => escapeHtml(g)).join(', ')}</p>
${structured.guardrails.careful.length > 0 ? `<p style="font-size: 14px; margin: 4px 0;"><span style="background: #fef7e0; color: #b45309; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">CAREFUL</span> ${structured.guardrails.careful.map(g => escapeHtml(g)).join(', ')}</p>` : ''}
<p style="font-size: 14px; margin: 4px 0;"><span style="background: #e6f4ea; color: #137333; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">SAFE</span> ${structured.guardrails.safe.map(g => escapeHtml(g)).join(', ')}</p>

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

${parsed.positioning.length > 0 ? `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 0 0 20px 0;">Positioning Matches</h2>

${parsed.positioning.map((p, i) => `<div style="border-left: 4px solid #c41e3a; padding: 16px 20px; margin-bottom: 20px; background: #fef7f7;">
  <p style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #c41e3a; font-weight: bold; margin: 0 0 8px 0;">MATCH #${i + 1}</p>
  <p style="font-size: 15px; color: #3c4043; margin: 0; line-height: 1.6;">${applyInlineFormatting(escapeHtml(p))}</p>
</div>`).join('\n')}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">` : ''}

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 0 0 8px 0;">Email Templates by Role</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">Copy each email body and paste into Gmail compose. Rich formatting transfers automatically.</p>

${primaryEmails.map(email => renderEmailBox(email, options.aeName)).join('\n')}

${managerEmails.length > 0 ? `<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 24px 0 8px 0;">📧 Manager Outreach</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">200-250 words · technical depth. Designed to be forwarded up with "we should look at this."</p>

${managerEmails.map(email => renderEmailBox(email, options.aeName)).join('\n')}` : ''}

${options.bvTalkingPoints && options.bvTalkingPoints.length > 0 ? renderBVTalkingPoints(options.bvTalkingPoints) : ''}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 24px 0;">
<p style="text-align: center; font-size: 13px; color: #80868b;">Generated by ContentCampaign · Source: DailyBriefDashboard Intelligence · ${options.generatedDate}</p>
</body></html>`

  return html
}
