/**
 * HTML Template Generator for ContentCampaign
 * Matches the gold standard output from ContentCampaign skill
 *
 * Gold standard: ~/.claude/skills/ContentCampaign/output/a10-networks-campaign-final.html
 */

interface CampaignHTMLOptions {
  materialTitle: string
  materialUrl: string
  customerName: string
  aeName: string
  generatedDate: string
  focus?: string
  style?: string
  signals?: {
    productIntel?: any
    intelligence?: any
    customerDocs?: any
    dailyBrief?: any
    subscriptions?: any
    emails?: any
    cases?: any
  }
  markdown: string
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

  // Split markdown into sections by ## or # headers
  const sectionBlocks = markdown.split(/\n(?=#{1,2}\s)/)

  for (const block of sectionBlocks) {
    const headerMatch = block.match(/^#{1,2}\s+(.+)/)
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
    } else if (/—|–|-/.test(header) && !/campaign|customer|positioning|email templates/i.test(header)) {
      // This is an email template: "VP Infrastructure / Platform Engineering — C-level"
      const tierMatch = header.match(/^(.+?)\s*[—–-]\s*(.+)$/)
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
  // [text](url) -> <a href="url">text</a>
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color: #1a73e8;">$1</a>')
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

  // Employee patterns: "804 employees", "had 21,000 employees"
  const employeesMatch = companyText.match(/([\d,]+)\s*employees/i)

  // Product instances from subscriptions
  let productInstances = defaults.productInstances
  let productName = defaults.productName
  if (signals?.subscriptions) {
    const subs = Array.isArray(signals.subscriptions) ? signals.subscriptions : []
    if (subs.length > 0) {
      const totalQty = subs.reduce((sum: number, s: any) => sum + (Number(s.quantity) || 0), 0)
      if (totalQty > 0) {
        productInstances = String(totalQty)
        const firstProduct = subs[0]?.product || subs[0]?.sku || 'Product'
        productName = firstProduct.replace(/Red Hat\s*/i, '').split(' ').slice(0, 3).join(' ')
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
  guardrails: { never: string[]; safe: string[] }
} {
  const result = {
    initiatives: [] as Array<{ name: string; priority: string; detail: string }>,
    competitors: [] as Array<{ name: string; threat: string; advantage: string }>,
    guardrails: { never: [] as string[], safe: [] as string[] },
  }

  const intel = signals?.intelligence
  if (!intel) return result

  const companyText = typeof intel === 'string' ? intel : (intel.company || '')

  // Extract competitor mentions
  const competitorSection = companyText.match(/(?:competitive|competitor|competition)[^]*?(?=##|\z)/i)
  if (competitorSection) {
    const competitorNames = competitorSection[0].match(/\*\*([^*]+)\*\*/g)
    if (competitorNames) {
      for (const match of competitorNames.slice(0, 4)) {
        const name = match.replace(/\*\*/g, '').trim()
        if (name.length > 2 && name.length < 40) {
          result.competitors.push({ name, threat: '', advantage: '' })
        }
      }
    }
  }

  // Guardrails — always include standard ones
  result.guardrails.never = ['Pipeline opportunities', 'Support cases', 'Subscription counts', 'Internal data']
  result.guardrails.safe = ['Public earnings', 'Leadership changes', 'AI strategy', 'Competitor moves', 'Existing Red Hat relationship']

  return result
}

/**
 * Generate rich HTML output matching ContentCampaign skill format
 */
export function generateCampaignHTML(options: CampaignHTMLOptions): string {
  const parsed = parseCampaignMarkdown(options.markdown)
  const metrics = extractMetrics(options.signals)
  const structured = extractStructuredIntel(options.signals)

  // Build HTML
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #202124;">

<h1 style="font-size: 28px; color: #c41e3a; margin: 0 0 4px 0; border-bottom: 3px solid #c41e3a; padding-bottom: 12px;">Content Campaign: ${escapeHTML(options.materialTitle)}</h1>
<h2 style="font-size: 22px; color: #202124; margin: 8px 0 4px 0;">${escapeHTML(options.customerName)}</h2>
<p style="font-size: 14px; color: #5f6368; margin: 0 0 24px 0;">Generated ${options.generatedDate} · AE: ${escapeHTML(options.aeName)}${options.focus ? ` · Focus: ${escapeHTML(options.focus)}` : ''}${options.style ? ` · Style: ${escapeHTML(options.style)}` : ''}</p>

<table width="100%" cellpadding="10" cellspacing="0" style="background: #f8f9fa; margin-bottom: 24px;">
  <tr>
    <td style="font-size: 14px; color: #5f6368;"><strong style="color: #202124;">Source:</strong> <a href="${escapeHTML(options.materialUrl)}" style="color: #1a73e8;">${escapeHTML(options.materialTitle)}</a></td>
  </tr>
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

${structured.competitors.length > 0 ? `
<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚔️ Competitive Position</h3>
<table width="100%" cellpadding="8" cellspacing="0" style="border: 1px solid #dadce0; margin-bottom: 20px; font-size: 14px;">
  <tr style="background: #f8f9fa;">
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Competitor</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Threat</td>
    <td style="font-weight: bold; border-bottom: 1px solid #dadce0;">Advantage</td>
  </tr>
  ${structured.competitors.map(c => `<tr>
    <td style="border-bottom: 1px solid #e8eaed; font-weight: bold;">${escapeHTML(c.name)}</td>
    <td style="border-bottom: 1px solid #e8eaed;">${escapeHTML(c.threat)}</td>
    <td style="border-bottom: 1px solid #e8eaed;">${escapeHTML(c.advantage)}</td>
  </tr>`).join('\n')}
</table>` : ''}

<h3 style="font-size: 16px; color: #202124; margin: 24px 0 12px 0;">⚠️ Outreach Guardrails</h3>
<p style="font-size: 14px; margin: 4px 0;"><span style="background: #fce8e6; color: #c5221f; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">NEVER</span> ${structured.guardrails.never.map(g => escapeHTML(g)).join(', ')}</p>
<p style="font-size: 14px; margin: 4px 0;"><span style="background: #e6f4ea; color: #137333; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">SAFE</span> ${structured.guardrails.safe.map(g => escapeHTML(g)).join(', ')}</p>

<hr style="border: none; border-top: 1px solid #dadce0; margin: 32px 0;">

<!-- ═══════════════════════════════════════════════ -->
<!-- POSITIONING SUMMARY                            -->
<!-- ═══════════════════════════════════════════════ -->

<h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #c41e3a; margin: 0 0 20px 0;">Positioning Summary</h2>

${parsed.positioning.map(p => `<div style="border-left: 4px solid #c41e3a; padding: 16px 20px; margin-bottom: 20px; background: #fef7f7;">
  <p style="font-size: 15px; color: #3c4043; margin: 0;">${convertMarkdownLinks(convertMarkdownBold(escapeHTML(p)))}</p>
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
