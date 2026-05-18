/**
 * HTML Template Generator for ContentCampaign
 * Matches the gold standard output from ContentCampaign skill
 *
 * Gold standard: ~/.claude/skills/ContentCampaign/output/a10-networks-campaign-final.html
 */

import type { AccountTeamMember } from './types.ts'

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
}

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

/**
 * Parse Gemini markdown output into structured sections.
 * Handles multiple Gemini output formats:
 * - # or ## for section headers
 * - **Subject:** or Subject: for email subject lines
 * - Body may follow Subject directly (no **Body:** label)
 */
function parseCampaignMarkdown(markdown: string): ParsedCampaign {
  const sections: ParsedCampaign = {
    summary: '',
    customerContext: '',
    positioning: [],
    valuePropsList: [],
    emailTemplates: [],
  }

  // Split markdown into sections by #, ##, or ### headers
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
      // Parent header — emails are inside as ### sub-headers, handled by the split
      continue
    } else if (/—|–/.test(header) && !/campaign|customer|positioning|email templates/i.test(header)) {
      // This is an email template: "Account Executive — Executive Tier"
      const tierMatch = header.match(/^(.+?)\s*[—–]\s*(.+)$/)
      if (!tierMatch) continue

      const persona = tierMatch[1].trim()
      const tier = tierMatch[2].trim()

      // Extract subject line — handles both **Subject:** and Subject: formats
      const subjectMatch = content.match(/\*?\*?Subject:?\*?\*?\s*(.+)/i)
      const subject = subjectMatch ? subjectMatch[1].trim() : ''

      // Body is everything after the subject line
      let body = content
      if (subjectMatch) {
        const subjectIdx = content.indexOf(subjectMatch[0])
        body = content.slice(subjectIdx + subjectMatch[0].length).trim()
      }

      // Remove **Body:** label if present
      body = body.replace(/^\*?\*?Body:?\*?\*?\s*/i, '').trim()

      // Remove signature patterns
      body = body.replace(/\n*(?:Best regards|Sincerely|Thanks|Regards),?[\s\S]*$/i, '')

      // Remove trailing link placeholders
      body = body.replace(/\n*(?:Link|Peer reference):?\s*\[?[^\]]*\]?\s*$/i, '')

      if (persona && (subject || body)) {
        sections.emailTemplates.push({ persona, tier, subject, body: body.trim() })
      }
    }
  }

  return sections
}

/**
 * Escape HTML special characters
 */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Convert markdown-style links to HTML links
 */
function convertMarkdownLinks(text: string): string {
  // Standard markdown: [text](url) -> <a href="url">text</a>
  let result = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color: #1a73e8;">$1</a>')
  // Gemini alternate format: [url] text -> <a href="url">text</a>
  result = result.replace(/\[(https?:\/\/[^\]]+)\]\s*([^[\n]+)/g, '<a href="$1" style="color: #1a73e8;">$2</a>')
  // Bare URLs: https://... -> clickable link
  result = result.replace(/(?<!")(https?:\/\/[^\s<>"]+)/g, '<a href="$1" style="color: #1a73e8;">Link</a>')
  return result
}

/**
 * Convert markdown bold to HTML strong
 */
function convertMarkdownBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

/**
 * Convert markdown bullets to HTML
 */
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
      const bulletText = convertMarkdownLinks(convertMarkdownBold(bulletMatch[1]))
      html += `<p style="font-size: 15px; padding: 4px 0 4px 24px; margin: 4px 0; position: relative;"><span style="position: absolute; left: 8px; color: #c41e3a; font-size: 18px;">•</span>${bulletText}</p>\n`
    } else {
      if (inBulletList && line.trim() === '') {
        inBulletList = false
      }
      if (line.trim().length > 0) {
        const formattedLine = convertMarkdownLinks(convertMarkdownBold(line))
        html += `<p style="font-size: 15px; margin: 0 0 10px 0;">${formattedLine}</p>\n`
      }
    }
  }

  return html
}

/**
 * Extract metrics from signals (if available).
 * Intelligence cache has: { company: "long text...", industry: "..." }
 * The company text contains revenue, employee count, etc. in prose form.
 */
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

  // Intelligence is the full cache object with { company: string, industry: string }
  const intel = signals?.intelligence
  if (!intel) return defaults

  // The company field is a long markdown string containing all company data
  const companyText = typeof intel === 'string' ? intel : (intel.company || '')

  // Revenue patterns: "$255.4 million", "$9.55B", "revenue of $255.4 million"
  const revenueMatch = companyText.match(/\$(\d[\d,.]*\s*(?:billion|million|[BMK]))/i)
    || companyText.match(/revenue[^$]*\$(\d[\d,.]*\s*(?:billion|million|[BMK])?)/i)

  // Employee patterns: "804 employees", "had 21,000 employees", "employ approximately 3,000 individuals"
  const employeesMatch = companyText.match(/([\d,]+)\s*employees/i)
    || companyText.match(/employ\w*\s+(?:approximately\s+)?([\d,]+)\s*(?:individuals|people|workers|staff)/i)

  // Product instances from subscriptions — handle both .data[] and .rows[] formats
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

/**
 * Extract structured intelligence sections for the HTML template.
 * Parses the company intelligence text for initiatives, competitors, and guardrails.
 */
function extractStructuredIntel(signals?: CampaignHTMLOptions['signals']): {
  initiatives: Array<{ name: string; priority: string; detail: string }>
  competitors: Array<{ name: string; threat: string; advantage: string }>
  guardrails: { never: string[]; careful: string[]; safe: string[] }
} {
  const result = {
    initiatives: [] as Array<{ name: string; priority: string; detail: string }>,
    competitors: [] as Array<{ name: string; threat: string; advantage: string }>,
    guardrails: { never: [] as string[], careful: [] as string[], safe: [] as string[] },
  }

  const intel = signals?.intelligence
  const companyText = typeof intel === 'string' ? intel : (intel?.company || '')

  // ── Extract competitors from ## Competitive Landscape section ──
  const competitorSection = companyText.match(/## Competitive Landscape[\s\S]*?(?=\n## |$)/i)
  if (competitorSection) {
    const section = competitorSection[0]

    // Extract differentiation paragraph for the advantage column
    const diffMatch = section.match(/differentiates?\s+(?:itself\s+)?(?:through|by|with)\s+([\s\S]*?)(?=\n\n|Switching costs)/i)
    const differentiation = diffMatch?.[1]?.trim().split('.')[0] || ''

    // Format 1: Numbered - 1. **F5, Inc.:** description
    const numberedRegex = /\d+\.\s+\*\*([^*:]+?)(?::?\*\*):?\s*([\s\S]*?)(?=\n\s*\d+\.\s+\*\*|\n##|$)/gs
    let match
    while ((match = numberedRegex.exec(section)) !== null) {
      const name = match[1].trim().replace(/[,.]$/, '')
      const fullDesc = match[2].trim()
      // First sentence = threat, look for differentiation/advantage in the rest
      const sentences = fullDesc.split(/\.\s+/)
      const threat = sentences[0]?.trim() || ''
      const advMatch = fullDesc.match(/differenti\w+\s+(?:with|by|through|often\s+lies?\s+in)\s+([^.]+)/i)
        || fullDesc.match(/(?:advantage|strength|known for)\s+(?:is|lies in|with)\s+([^.]+)/i)
      const advantage = advMatch?.[1]?.trim() || (sentences.length > 1 ? sentences[1]?.trim() : '')
      if (name.length > 1 && name.length < 50 && !name.includes('Competitive')) {
        result.competitors.push({ name, threat, advantage })
      }
    }

    // Format 2: Bullet list - * CompanyName or - CompanyName
    // For bullet lists, competitors have no individual threat/advantage data
    // Store differentiation separately, don't duplicate per row
    if (result.competitors.length === 0) {
      const bulletRegex = /[*\-]\s+(?:\*\*)?([^*\n]+?)(?:\*\*)?$/gm
      while ((match = bulletRegex.exec(section)) !== null) {
        const name = match[1].trim()
        if (name.length > 1 && name.length < 50 && !name.match(/^(switching|integrated|specialized|established|market)/i)) {
          result.competitors.push({ name, threat: '', advantage: '' })
        }
        if (result.competitors.length >= 5) break
      }
      // Store differentiation as a separate field for display above the table
      if (differentiation) {
        (result as any).differentiation = differentiation
      }
    }
  }

  // ── Extract strategic initiatives from account plan ──
  const planText = signals?.accountPlan || ''
  if (planText) {
    // Look for strategic objectives in the account plan
    const objectivesSection = planText.match(/Strategic Objectives:[\s\S]*?(?=\n\s*\*\*Mapping|$)/i)
      || planText.match(/Why Red Hat[\s\S]*?Strategic Objectives:[\s\S]*?(?=\n\s*\*\*Mapping|$)/i)
    if (objectivesSection) {
      const objectiveRegex = /\*\*([^*]+)\*\*:?\s*([^*\n]+)/g
      let objMatch
      while ((objMatch = objectiveRegex.exec(objectivesSection[0])) !== null) {
        const name = objMatch[1].trim()
        const detail = objMatch[2].trim()
        if (name.length > 5 && name.length < 80 && !name.includes('Mapping') && !name.includes('Account')) {
          result.initiatives.push({ name, priority: 'HIGH', detail })
        }
      }
    }

    // Look for risks to build guardrails
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

  // Standard guardrails (always present)
  result.guardrails.never = ['Pipeline opportunities', 'RHEL Private Offer', 'Support cases', 'Subscription counts', 'Layoff numbers']
  if (result.guardrails.careful.length === 0) {
    result.guardrails.careful = ['Leadership changes — frame around strategy, not departures']
  }
  result.guardrails.safe = ['Public earnings', 'CTO/CIO appointments', 'AI strategy', 'Competitor moves', 'Existing Red Hat relationship']

  return result
}

/**
 * Generate rich HTML output matching ContentCampaign skill format
 */
/**
 * Extract known contacts from intelligence data
 */
function extractContacts(signals?: CampaignHTMLOptions['signals']): Array<{ name: string; title: string; email?: string }> {
  const contacts: Array<{ name: string; title: string; email?: string }> = []
  const intel = signals?.intelligence
  const companyText = typeof intel === 'string' ? intel : (intel?.company || '')

  // Parse leadership section for named executives
  const leadershipSection = companyText.match(/## Leadership[\s\S]*?(?=\n## |$)/i)
  if (leadershipSection) {
    // Match patterns like "Scott Thomson, Vice President, Information Technology"
    // or "* Scott Thomson, VP of IT"
    const contactRegex = /(?:\*\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+),\s*((?:VP|Vice President|SVP|Senior Vice President|President|CEO|CFO|CTO|CIO|COO|CMO|Director|Head of|Chief)[^.\n]*)/gi
    let match
    while ((match = contactRegex.exec(leadershipSection[0])) !== null) {
      const name = match[1].trim()
      const title = match[2].trim()
      if (name.length > 3 && !contacts.some(c => c.name === name)) {
        contacts.push({ name, title })
      }
    }
  }

  // Also check account plan for team members or stakeholders
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

export function generateCampaignHTML(options: CampaignHTMLOptions): string {
  const parsed = parseCampaignMarkdown(options.markdown)
  const metrics = extractMetrics(options.signals)
  const structured = extractStructuredIntel(options.signals)
  const contacts = extractContacts(options.signals)

  // Build HTML
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #202124;">

<h1 style="font-size: 28px; color: #c41e3a; margin: 0 0 4px 0; border-bottom: 3px solid #c41e3a; padding-bottom: 12px;">Content Campaign: ${escapeHTML(options.materialTitle)}</h1>
<h2 style="font-size: 22px; color: #202124; margin: 8px 0 4px 0;">${escapeHTML(options.customerName)}</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 24px 0;">Generated ${options.generatedDate} · ${
  options.accountTeam && options.accountTeam.length > 0
    ? options.accountTeam.map(m => `${m.role.toUpperCase()}: ${escapeHTML(m.name)}`).join(' · ')
    : `AE: ${escapeHTML(options.aeName)}`
}${options.focus ? ` · Focus: ${escapeHTML(options.focus)}` : ''}${options.style ? ` · Style: ${escapeHTML(options.style)}` : ''}</p>

<table width="100%" cellpadding="10" cellspacing="0" style="background: #f8f9fa; margin-bottom: 24px;">
  <tr>
    <td style="font-size: 14px; color: #5f6368;"><strong style="color: #202124;">Source:</strong> <a href="${escapeHTML(options.materialUrl)}" style="color: #1a73e8;">${escapeHTML(options.materialTitle)}</a></td>
  </tr>
</table>

${contacts.length > 0 ? `
<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 16px 0 12px 0;">👥 Target Contacts</h2>
<table width="100%" cellpadding="6" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Name</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Title</td>
  </tr>
  ${contacts.map(c => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHTML(c.name)}</td>
    <td style="border-bottom: 1px solid #e8eaed;">${escapeHTML(c.title)}</td>
  </tr>`).join('\n')}
</table>` : ''}

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 16px 0 12px 0;">🎯 Generation Config</h2>
<table width="100%" cellpadding="6" cellspacing="0" style="font-size: 13px; color: #5f6368; margin-bottom: 16px; border: 1px solid #e8eaed;">
  <tr><td style="font-weight: bold; width: 120px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Model</td><td style="border-bottom: 1px solid #e8eaed;">Gemini 2.5 Pro (Vertex AI)</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">AE Voice</td><td style="border-bottom: 1px solid #e8eaed;">${escapeHTML(options.aeName)}</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Account Team</td><td style="border-bottom: 1px solid #e8eaed;">${
    options.accountTeam && options.accountTeam.length > 0
      ? options.accountTeam.map(m => `${escapeHTML(m.name)} (${m.role.toUpperCase()})`).join(', ')
      : escapeHTML(options.aeName) + ' (AE)'
  }</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Email Tiers</td><td style="border-bottom: 1px solid #e8eaed;">3 Executive (≤90 words) + 3 Manager (200-250 words)</td></tr>
  <tr><td style="font-weight: bold; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">Target Personas</td><td style="border-bottom: 1px solid #e8eaed;">${parsed.emailTemplates.length > 0 ? parsed.emailTemplates.map(e => `${escapeHTML(e.persona)} (${escapeHTML(e.tier)})`).join(' · ') : '6 personas (3 exec + 3 mgr)'}</td></tr>
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

<!-- ═══════════════════════════════════════════════ -->
<!-- CUSTOMER INTELLIGENCE DASHBOARD                -->
<!-- ═══════════════════════════════════════════════ -->

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 0 0 16px 0;">📊 Customer Intelligence Dashboard</h2>

<!-- Key Metrics Row -->
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

${parsed.customerContext ? `<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">📋 Customer Context</h3>
<p style="font-size: 15px; color: #5f6368; margin: 0 0 20px 0;">${escapeHTML(parsed.customerContext)}</p>` : ''}

${structured.initiatives.length > 0 ? `
<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">🎯 Strategic Initiatives</h3>
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Initiative</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0; width: 80px; text-align: center;">Priority</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Detail</td>
  </tr>
  ${structured.initiatives.map(i => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHTML(i.name)}</td>
    <td style="border-bottom: 1px solid #e8eaed; text-align: center;"><span style="background: ${i.priority === 'HIGH' ? '#c5221f' : '#f9ab00'}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${escapeHTML(i.priority)}</span></td>
    <td style="border-bottom: 1px solid #e8eaed; font-size: 13px; color: #5f6368;">${escapeHTML(i.detail)}</td>
  </tr>`).join('\n')}
</table>` : ''}

${structured.competitors.length > 0 ? `
<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚔️ Competitive Position</h3>
${(structured as any).differentiation ? `<p style="font-size: 14px; color: #5f6368; margin: 0 0 12px 0;"><strong>Differentiation:</strong> ${escapeHTML((structured as any).differentiation)}</p>` : ''}
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Competitor</td>
    ${structured.competitors.some(c => c.threat) ? `<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Threat</td>` : ''}
    ${structured.competitors.some(c => c.advantage) ? `<td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Advantage</td>` : ''}
  </tr>
  ${structured.competitors.map(c => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHTML(c.name)}</td>
    ${structured.competitors.some(cc => cc.threat) ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHTML(c.threat)}</td>` : ''}
    ${structured.competitors.some(cc => cc.advantage) ? `<td style="border-bottom: 1px solid #e8eaed;">${escapeHTML(c.advantage)}</td>` : ''}
  </tr>`).join('\n')}
</table>` : ''}

<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚠️ Outreach Guardrails</h3>
<p style="font-size: 14px; margin: 4px 0;"><span style="background: #fce8e6; color: #c5221f; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">NEVER</span> ${structured.guardrails.never.map(g => escapeHTML(g)).join(', ')}</p>
${structured.guardrails.careful.length > 0 ? `<p style="font-size: 14px; margin: 4px 0;"><span style="background: #fef7e0; color: #b45309; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">CAREFUL</span> ${structured.guardrails.careful.map(g => escapeHTML(g)).join(', ')}</p>` : ''}
<p style="font-size: 14px; margin: 4px 0;"><span style="background: #e6f4ea; color: #137333; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">SAFE</span> ${structured.guardrails.safe.map(g => escapeHTML(g)).join(', ')}</p>

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

<!-- ═══════════════════════════════════════════════ -->
<!-- POSITIONING SUMMARY                            -->
<!-- ═══════════════════════════════════════════════ -->

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 0 0 20px 0;">Positioning Matches</h2>

${parsed.positioning.map((p, i) => `<div style="border-left: 4px solid #c41e3a; padding: 16px 20px; margin-bottom: 20px; background: #fef7f7;">
  <p style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #c41e3a; font-weight: bold; margin: 0 0 8px 0;">MATCH #${i + 1}</p>
  <p style="font-size: 15px; color: #3c4043; margin: 0; line-height: 1.6;">${convertMarkdownLinks(convertMarkdownBold(escapeHTML(p)))}</p>
</div>`).join('\n')}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 0 0 8px 0;">Email Templates by Role</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 20px 0;">Copy each email body and paste into Gmail compose. Rich formatting transfers automatically.</p>

${parsed.emailTemplates.map(email => `<div style="border: 2px solid #dadce0; margin-bottom: 24px;">
  <div style="background: #c41e3a; padding: 12px 20px;">
    <span style="color: white; font-size: 16px; font-weight: bold;">📧  ${escapeHTML(email.persona)}</span>
  </div>
  <div style="padding: 8px 20px; background: #f8f9fa; border-bottom: 1px solid #e8eaed;">
    <p style="font-size: 14px; color: #5f6368; margin: 0;">Subject: <strong style="color: #202124;">${escapeHTML(email.subject)}</strong></p>
  </div>
  <div style="padding: 20px;">
    ${convertMarkdownBullets(email.body)}
    <div style="margin-top: 20px; padding-top: 14px; border-top: 3px solid #c41e3a;">
      <p style="font-size: 16px; font-weight: bold; margin: 0;">${escapeHTML(options.aeName)}</p>
      <p style="font-size: 14px; color: #5f6368; margin: 2px 0 0 0;">Account Executive · <span style="color: #c41e3a; font-weight: bold;">Red Hat</span></p>
    </div>
  </div>
</div>`).join('\n')}

<hr style="border: none; border-top: 1px solid #dadce0; margin: 24px 0;">
<p style="text-align: center; font-size: 13px; color: #80868b;">Generated by ContentCampaign · Source: DailyBriefDashboard Intelligence · ${options.generatedDate}</p>
</body></html>`

  return html
}
