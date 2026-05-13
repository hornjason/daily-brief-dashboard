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
 * Parse Gemini markdown output into structured sections
 */
function parseCampaignMarkdown(markdown: string): ParsedCampaign {
  const sections: ParsedCampaign = {
    summary: '',
    customerContext: '',
    positioning: [],
    valuePropsList: [],
    emailTemplates: [],
  }

  // Extract Campaign Summary
  const summaryMatch = markdown.match(/##?\s*Campaign Summary\s*\n+(.*?)(?=\n##|\z)/is)
  if (summaryMatch) {
    sections.summary = summaryMatch[1].trim()
  }

  // Extract Customer Context
  const contextMatch = markdown.match(/##?\s*Customer Context\s*\n+(.*?)(?=\n##|\z)/is)
  if (contextMatch) {
    sections.customerContext = contextMatch[1].trim()
  }

  // Extract Positioning (may have multiple paragraphs or subsections)
  const positioningMatch = markdown.match(/##?\s*Positioning\s*\n+(.*?)(?=\n##|\z)/is)
  if (positioningMatch) {
    const posText = positioningMatch[1].trim()
    // Split by double newlines or numbered items
    const items = posText.split(/\n\n+/).filter(p => p.trim().length > 0)
    sections.positioning = items
  }

  // Extract Email Templates
  // Pattern: ## {Persona} — {Tier}
  const emailRegex = /##\s+([^\n]+?)\s+—\s+([^\n]+)\s*\n+\*\*Subject:\*\*\s*([^\n]+)\s*\n+\*\*Body:\*\*\s*\n+([\s\S]+?)(?=\n##\s+[^\n]+\s+—|\z)/gi
  let emailMatch
  while ((emailMatch = emailRegex.exec(markdown)) !== null) {
    // Capture body but remove trailing signature lines if present
    let bodyText = emailMatch[4].trim()
    // Remove common signature patterns at the end
    bodyText = bodyText.replace(/\n*Best regards,[\s\S]*Account Executive.*$/i, '')
    bodyText = bodyText.replace(/\n*Sincerely,[\s\S]*Account Executive.*$/i, '')

    sections.emailTemplates.push({
      persona: emailMatch[1].trim(),
      tier: emailMatch[2].trim(),
      subject: emailMatch[3].trim(),
      body: bodyText.trim(),
    })
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
 * Extract metrics from signals (if available)
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

  if (!signals?.intelligence?.company) return defaults

  const intel = signals.intelligence.company

  // Try to extract from structured intelligence text
  const revenueMatch = intel.match(/revenue[:\s]+\$?([\d.]+[MBK]?)/i)
  const employeesMatch = intel.match(/employees?[:\s]+([\d,]+)/i)

  return {
    revenue: revenueMatch?.[1] ? `$${revenueMatch[1]}` : defaults.revenue,
    employees: employeesMatch?.[1] ?? defaults.employees,
    productInstances: defaults.productInstances,
    productName: defaults.productName,
  }
}

/**
 * Generate rich HTML output matching ContentCampaign skill format
 */
export function generateCampaignHTML(options: CampaignHTMLOptions): string {
  const parsed = parseCampaignMarkdown(options.markdown)
  const metrics = extractMetrics(options.signals)

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
