// src/email-template.ts — HTML email template for daily brief delivery (BKL-E03)
// Dark theme, table-based layout, inline CSS only (Gmail compatibility)
// Ported from MorningBrief Python email_templates_v3.py

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BriefMeeting {
  time: string            // "9:00 AM"
  customer: string        // "DROPBOX"
  title: string           // "Red Hat / Dropbox Platform Review"
  calLink?: string        // Google Calendar event URL
  joinUrl?: string        // Video conference join link
  prepBullets?: string[]  // Intel bullets for meeting prep
}

export interface BriefEmail {
  sender: string          // "Hemanth Kumar"
  customer: string        // "A10 Networks"
  subject: string         // "Re: AI Discussion prep"
  snippet: string         // "Wanted to send over our current stack..."
  urgency: 'high' | 'medium' | 'low'
  gmailLink?: string
}

export interface BriefCase {
  caseNumber: string      // "#03799102"
  title: string           // "Ansible Tower API timeout"
  customer: string        // "A10 Networks"
  status: string          // "OPEN", "ESCALATED", "WAITING"
  age: string             // "21d"
  priority: string        // "P1", "P2", "P3"
  caseLink?: string
}

export interface BriefPipelineDeal {
  dealName: string        // "OpenShift Platform Expansion"
  customer: string        // "Dropbox"
  stage: string           // "Negotiate"
  value: string           // "$180,000"
  changeType: 'new' | 'moved' | 'stalled' | 'steady'
  sfLink?: string
}

export interface BriefCustomerSummary {
  customerName: string
  briefText: string       // The generated AI brief text
  healthScore?: number
}

export interface BriefEmailData {
  dateDisplay: string     // "Friday, March 28, 2026"
  meetings: BriefMeeting[]
  emails: BriefEmail[]
  cases: BriefCase[]
  pipeline: BriefPipelineDeal[]
  customerBriefs: BriefCustomerSummary[]
  sections: {
    meetings: boolean
    emails: boolean
    cases: boolean
    pipeline: boolean
    brief: boolean
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = "'Courier New',Courier,monospace"

const URGENCY_COLORS: Record<string, { dot: string; bg: string; color: string; label: string }> = {
  high:   { dot: '#f59e0b', bg: '#422006', color: '#f59e0b', label: 'HIGH' },
  medium: { dot: '#3b82f6', bg: '#172554', color: '#60a5fa', label: 'MED' },
  low:    { dot: '#333333', bg: '#1a1a1a', color: '#555555', label: 'LOW' },
}

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  escalated: { bg: '#3b0764', color: '#c084fc' },
  open:      { bg: '#172554', color: '#60a5fa' },
  waiting:   { bg: '#1a1a1a', color: '#888888' },
  'needs-sa': { bg: '#422006', color: '#f59e0b' },
  resolved:  { bg: '#052e16', color: '#10b981' },
}

const PRIORITY_COLORS: Record<string, { bg: string; color: string }> = {
  P1: { bg: '#422006', color: '#f59e0b' },
  P2: { bg: '#172554', color: '#60a5fa' },
  P3: { bg: '#1a1a1a', color: '#888888' },
  P4: { bg: '#1a1a1a', color: '#555555' },
}

const CHANGE_STYLES: Record<string, { indicator: string; indicatorColor: string; badgeBg: string; badgeColor: string; label: string; valueColor: string }> = {
  new:     { indicator: '&#9733;', indicatorColor: '#10b981', badgeBg: '#052e16', badgeColor: '#10b981', label: 'NEW',     valueColor: '#10b981' },
  moved:   { indicator: '&#9650;', indicatorColor: '#3b82f6', badgeBg: '#172554', badgeColor: '#60a5fa', label: 'MOVED',   valueColor: '#60a5fa' },
  stalled: { indicator: '&#9679;', indicatorColor: '#f59e0b', badgeBg: '#422006', badgeColor: '#f59e0b', label: 'STALLED', valueColor: '#f59e0b' },
  steady:  { indicator: '&#8212;', indicatorColor: '#444444', badgeBg: '#1a1a1a', badgeColor: '#555555', label: 'STEADY',  valueColor: '#888888' },
}

// ── Section Renderers ─────────────────────────────────────────────────────────

function renderMeetingRow(m: BriefMeeting): string {
  const calLink = m.calLink ?? '#'
  const joinButton = m.joinUrl
    ? `<a href="${esc(m.joinUrl)}" target="_blank" style="display:inline-block;background:#3b82f6;color:#ffffff;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:11px;font-weight:bold;font-family:${FONT};letter-spacing:0.5px">JOIN</a>`
    : ''

  let prepHtml: string
  if (m.prepBullets && m.prepBullets.length > 0) {
    const bullets = m.prepBullets.map(b =>
      `<tr><td style="padding:0 8px 5px 0;vertical-align:top;width:8px;color:#3b82f6;font-size:7px;line-height:22px">&#9654;</td><td style="padding:0 0 5px 0;color:#a0a0a0;font-size:14px;line-height:22px;font-family:${FONT}">${esc(b)}</td></tr>`
    ).join('')
    prepHtml = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${bullets}</table>`
  } else {
    prepHtml = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:6px 12px;border-radius:4px;background:#161616;border:1px solid #1e1e1e"><span style="color:#444;font-size:12px;font-style:italic;font-family:${FONT}">No intel available for this meeting</span></td></tr></table>`
  }

  return `<tr><td style="padding:0 28px 12px 28px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#111111;border-radius:8px;border:1px solid #1e1e1e;border-collapse:separate">
  <tr><td colspan="2" style="padding:0"><div style="height:3px;background:#3b82f6;border-radius:8px 8px 0 0;font-size:1px;line-height:1px">&nbsp;</div></td></tr>
  <tr><td colspan="2" style="padding:16px 16px 0 16px"><a href="${esc(calLink)}" target="_blank" style="text-decoration:none;color:#2dd4bf"><div style="font-size:21px;font-weight:800;color:#2dd4bf;font-family:${FONT};letter-spacing:0.2px;line-height:1.2">${esc(m.customer)}</div></a></td></tr>
  <tr><td style="padding:8px 16px 0 16px;vertical-align:middle"><span style="display:inline-block;background:#172554;color:#60a5fa;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:bold;font-family:${MONO};letter-spacing:0.5px">${esc(m.time)}</span></td><td style="padding:8px 16px 0 0;text-align:right;vertical-align:middle;width:80px">${joinButton}</td></tr>
  <tr><td colspan="2" style="padding:6px 16px 0 16px"><div style="color:#666;font-size:14px;font-family:${FONT}">${esc(m.title)}</div></td></tr>
  <tr><td colspan="2" style="padding:12px 16px 16px 16px">${prepHtml}</td></tr>
</table>
</td></tr>`
}

function renderEmailRow(e: BriefEmail, isLast: boolean): string {
  const u = URGENCY_COLORS[e.urgency] ?? URGENCY_COLORS.low
  const borderBottom = isLast ? '' : 'border-bottom:1px solid #1a1a1a;'
  const link = e.gmailLink ?? '#'
  return `<tr><td style="padding:14px 16px;${borderBottom}">
<a href="${esc(link)}" target="_blank" style="text-decoration:none;color:inherit;display:block">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td style="padding:0;vertical-align:top;width:10px"><div style="width:8px;height:8px;border-radius:50%;background:${u.dot};margin-top:4px"></div></td>
  <td style="padding:0 0 0 10px;vertical-align:top">
    <div><span style="color:#e0e0e0;font-size:14px;font-weight:600;font-family:${FONT}">${esc(e.sender)}</span><span style="color:#555;font-size:12px;font-family:${FONT};padding-left:6px">${esc(e.customer)}</span></div>
    <div style="color:#b0b0b0;font-size:14px;font-family:${FONT};margin-top:2px">${esc(e.subject)}</div>
    <div style="color:#666;font-size:13px;font-family:${FONT};margin-top:3px">${esc(e.snippet)}</div>
  </td>
  <td style="padding:0;text-align:right;vertical-align:top;white-space:nowrap;width:60px">
    <span style="display:inline-block;background:${u.bg};color:${u.color};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;font-family:${FONT};letter-spacing:0.5px;text-transform:uppercase">${u.label}</span>
  </td>
</tr></table>
</a></td></tr>`
}

function renderCaseRow(c: BriefCase, isLast: boolean): string {
  const statusKey = c.status.toLowerCase().replace(/\s+/g, '-')
  const s = STATUS_COLORS[statusKey] ?? STATUS_COLORS.open
  const p = PRIORITY_COLORS[c.priority] ?? PRIORITY_COLORS.P3
  const borderBottom = isLast ? '' : 'border-bottom:1px solid #1a1a1a;'
  const link = c.caseLink ?? `https://access.redhat.com/support/cases/#/case/${esc(c.caseNumber.replace('#', ''))}`
  const ageColor = parseInt(c.age) > 14 ? '#f59e0b' : '#b0b0b0'

  return `<tr><td style="padding:12px 16px;${borderBottom}" colspan="5">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td style="padding:0;width:30%;vertical-align:top"><a href="${esc(link)}" target="_blank" style="text-decoration:none;color:inherit"><div style="color:#a0a0a0;font-size:11px;font-family:${MONO}">${esc(c.caseNumber)}</div><div style="color:#d4d4d4;font-size:14px;font-family:${FONT};margin-top:2px">${esc(c.title)}</div></a></td>
  <td style="padding:0;width:22%;vertical-align:top"><span style="color:#b0b0b0;font-size:13px;font-family:${FONT}">${esc(c.customer)}</span></td>
  <td style="padding:0;width:22%;vertical-align:top"><span style="display:inline-block;background:${s.bg};color:${s.color};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;font-family:${FONT};letter-spacing:0.3px">${esc(c.status.toUpperCase())}</span></td>
  <td style="padding:0;width:13%;vertical-align:top;text-align:center"><span style="color:${ageColor};font-size:12px;font-weight:600;font-family:${FONT}">${esc(c.age)}</span></td>
  <td style="padding:0;width:13%;vertical-align:top;text-align:right"><span style="display:inline-block;background:${p.bg};color:${p.color};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;font-family:${MONO}">${esc(c.priority)}</span></td>
</tr></table></td></tr>`
}

function renderPipelineRow(d: BriefPipelineDeal, isLast: boolean): string {
  const cs = CHANGE_STYLES[d.changeType] ?? CHANGE_STYLES.steady
  const borderBottom = isLast ? '' : 'border-bottom:1px solid #1a1a1a;'
  const link = d.sfLink ?? '#'

  return `<tr><td style="padding:14px 16px;${borderBottom}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td style="padding:0;vertical-align:top;width:24px"><span style="color:${cs.indicatorColor};font-size:14px;line-height:18px">${cs.indicator}</span></td>
  <td style="padding:0;vertical-align:top">
    <div><a href="${esc(link)}" target="_blank" style="text-decoration:none;color:#e0e0e0;font-size:14px;font-weight:600;font-family:${FONT}">${esc(d.dealName)}</a><span style="color:#555;font-size:12px;font-family:${FONT};padding-left:6px">${esc(d.customer)}</span></div>
    <div style="margin-top:4px"><span style="display:inline-block;background:${cs.badgeBg};color:${cs.badgeColor};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;font-family:${FONT};letter-spacing:0.3px;text-transform:uppercase">${cs.label}</span><span style="color:#666;font-size:12px;font-family:${FONT};padding-left:8px">${esc(d.stage)}</span></div>
  </td>
  <td style="padding:0;text-align:right;vertical-align:top;white-space:nowrap"><span style="color:${cs.valueColor};font-size:14px;font-weight:700;font-family:${MONO}">${esc(d.value)}</span></td>
</tr></table></td></tr>`
}

function renderCustomerBrief(b: BriefCustomerSummary): string {
  const healthColor = b.healthScore != null
    ? (b.healthScore >= 70 ? '#10b981' : b.healthScore >= 40 ? '#f59e0b' : '#ef4444')
    : '#555'
  const healthBadge = b.healthScore != null
    ? `<span style="display:inline-block;background:#161616;color:${healthColor};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;font-family:${MONO};margin-left:8px">${b.healthScore}</span>`
    : ''

  // Convert brief text paragraphs to HTML
  const briefHtml = b.briefText
    .split('\n')
    .filter(l => l.trim())
    .map(l => `<div style="color:#b0b0b0;font-size:13px;line-height:20px;font-family:${FONT};margin-bottom:6px">${esc(l.trim())}</div>`)
    .join('')

  return `<tr><td style="padding:0 28px 12px 28px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#111111;border-radius:8px;border:1px solid #1e1e1e;border-collapse:separate">
  <tr><td style="padding:14px 16px 8px 16px">
    <span style="font-size:16px;font-weight:700;color:#2dd4bf;font-family:${FONT}">${esc(b.customerName)}</span>${healthBadge}
  </td></tr>
  <tr><td style="padding:0 16px 14px 16px">${briefHtml || `<div style="color:#444;font-size:13px;font-style:italic;font-family:${FONT}">No brief data available</div>`}</td></tr>
</table>
</td></tr>`
}

function renderEmptyState(message: string): string {
  return `<tr><td style="padding:0 28px 4px 28px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#111111;border-radius:8px;border:1px solid #1e1e1e;border-collapse:separate">
  <tr><td style="padding:20px 16px;text-align:center"><span style="color:#444;font-size:13px;font-style:italic;font-family:${FONT}">${esc(message)}</span></td></tr>
</table></td></tr>`
}

function sectionHeader(diamond: string, color: string, label: string, summary: string): string {
  return `<tr><td style="padding:8px 28px 12px 28px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td style="padding:0;vertical-align:middle;white-space:nowrap">
    <span style="font-size:12px;color:${color};font-family:${MONO};font-weight:bold">${diamond}</span>
    <span style="font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:${color};font-weight:600;font-family:${FONT};padding-left:6px">${esc(label)}</span>
    <span style="font-size:12px;color:#555;font-family:${FONT};padding-left:8px">&mdash; ${esc(summary)}</span>
  </td>
  <td style="padding:0;vertical-align:middle;width:100%"><div style="height:1px;background:#1e1e1e;margin-left:16px">&nbsp;</div></td>
</tr></table></td></tr>`
}

// ── Main Renderer ─────────────────────────────────────────────────────────────

export function renderBriefHtml(data: BriefEmailData): string {
  const { dateDisplay, meetings, emails, cases, pipeline, customerBriefs, sections } = data
  const genTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })

  const meetingCount = meetings.length
  const emailCount = emails.length
  const caseCount = cases.length
  const pipelineTotal = pipeline.reduce((sum, d) => {
    const num = parseFloat(d.value.replace(/[$,]/g, ''))
    return sum + (isNaN(num) ? 0 : num)
  }, 0)
  const pipelineDisplay = pipelineTotal >= 1000 ? `$${Math.round(pipelineTotal / 1000)}K` : `$${Math.round(pipelineTotal)}`

  const preheader = `${meetingCount} meetings | ${emailCount} emails | ${caseCount} cases | ${pipelineDisplay} pipeline`

  // Build sections
  let body = ''

  // Meetings
  if (sections.meetings) {
    body += sectionHeader('&#9670;', '#3b82f6', "TODAY'S MEETINGS", String(meetingCount))
    if (meetings.length > 0) {
      body += meetings.map(m => renderMeetingRow(m)).join('')
    } else {
      body += renderEmptyState('No customer meetings scheduled today')
    }
    body += `<tr><td style="padding:8px 0 0 0;font-size:1px;line-height:1px">&nbsp;</td></tr>`
  }

  // Emails
  if (sections.emails) {
    const needReply = emails.filter(e => e.urgency === 'high').length
    const emailSummary = `${emailCount} emails${needReply > 0 ? `, ${needReply} need reply` : ''}`
    body += sectionHeader('&#9670;', '#6366f1', 'EMAIL ACTION ITEMS', emailSummary)
    if (emails.length > 0) {
      body += `<tr><td style="padding:0 28px 4px 28px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#111111;border-radius:8px;border:1px solid #1e1e1e;border-collapse:separate">`
      body += emails.map((e, i) => renderEmailRow(e, i === emails.length - 1)).join('')
      body += `</table></td></tr>`
    } else {
      body += renderEmptyState('No customer emails requiring attention')
    }
    body += `<tr><td style="padding:12px 0 0 0;font-size:1px;line-height:1px">&nbsp;</td></tr>`
  }

  // Cases
  if (sections.cases) {
    body += sectionHeader('&#9670;', '#10b981', 'OPEN SUPPORT CASES', `${caseCount} open cases`)
    if (cases.length > 0) {
      body += `<tr><td style="padding:0 28px 4px 28px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#111111;border-radius:8px;border:1px solid #1e1e1e;border-collapse:separate">`
      // Column headers
      body += `<tr><td style="padding:10px 16px;border-bottom:1px solid #1e1e1e" colspan="5"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>`
      body += `<td style="padding:0;width:30%;color:#444;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-family:${FONT};font-weight:600">Case</td>`
      body += `<td style="padding:0;width:22%;color:#444;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-family:${FONT};font-weight:600">Customer</td>`
      body += `<td style="padding:0;width:22%;color:#444;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-family:${FONT};font-weight:600">Status</td>`
      body += `<td style="padding:0;width:13%;color:#444;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-family:${FONT};font-weight:600;text-align:center">Age</td>`
      body += `<td style="padding:0;width:13%;color:#444;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-family:${FONT};font-weight:600;text-align:right">Pri</td>`
      body += `</tr></table></td></tr>`
      body += cases.map((c, i) => renderCaseRow(c, i === cases.length - 1)).join('')
      body += `</table></td></tr>`
    } else {
      body += renderEmptyState('No open support cases')
    }
    body += `<tr><td style="padding:12px 0 0 0;font-size:1px;line-height:1px">&nbsp;</td></tr>`
  }

  // Pipeline
  if (sections.pipeline) {
    const pipeSummary = `${pipeline.length} deals${pipelineTotal > 0 ? ` \u00b7 ${pipelineDisplay} total` : ''}`
    body += sectionHeader('&#9670;', '#f59e0b', 'PIPELINE MOVEMENT', pipeSummary)
    if (pipeline.length > 0) {
      body += `<tr><td style="padding:0 28px 4px 28px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#111111;border-radius:8px;border:1px solid #1e1e1e;border-collapse:separate">`
      body += pipeline.map((d, i) => renderPipelineRow(d, i === pipeline.length - 1)).join('')
      body += `</table></td></tr>`
    } else {
      body += renderEmptyState('No pipeline movement to report')
    }
    body += `<tr><td style="padding:12px 0 0 0;font-size:1px;line-height:1px">&nbsp;</td></tr>`
  }

  // Customer Briefs
  if (sections.brief && customerBriefs.length > 0) {
    body += sectionHeader('&#9670;', '#2dd4bf', 'CUSTOMER BRIEFS', `${customerBriefs.length} accounts`)
    body += customerBriefs.map(b => renderCustomerBrief(b)).join('')
    body += `<tr><td style="padding:12px 0 0 0;font-size:1px;line-height:1px">&nbsp;</td></tr>`
  }

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark only">
  <meta name="supported-color-schemes" content="dark only">
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style>body,table,td{font-family:Segoe UI,Helvetica,Arial,sans-serif !important;}</style>
  <![endif]-->
  <title>Morning Brief &mdash; ${esc(dateDisplay)}</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;color:#d4d4d4;font-family:${FONT};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">

<div style="display:none;font-size:1px;color:#0a0a0a;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">
  ${esc(preheader)}
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#0a0a0a">
  <tr><td align="center" style="padding:0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="max-width:680px;width:100%;background-color:#0d0d0d;border-left:1px solid #1a1a1a;border-right:1px solid #1a1a1a">

      <!-- HEADER -->
      <tr><td style="padding:32px 28px 0 28px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="padding:0"><div style="height:2px;background:#3b82f6;opacity:0.6;font-size:1px;line-height:1px">&nbsp;</div></td></tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px">
          <tr>
            <td style="vertical-align:bottom;padding:0">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:3px;color:#3b82f6;font-family:${MONO};font-weight:bold;margin-bottom:6px">INTELLIGENCE BRIEF</div>
              <h1 style="margin:0;padding:0;font-size:26px;font-weight:700;color:#f0f0f0;font-family:${FONT};letter-spacing:-0.5px">Morning Brief</h1>
              <div style="color:#555;font-size:14px;margin-top:6px;font-family:${FONT}">${esc(dateDisplay)}</div>
            </td>
            <td style="vertical-align:bottom;text-align:right;padding:0">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-left:auto"><tr>
                <td style="padding:0 6px;text-align:center">
                  <div style="font-size:22px;font-weight:bold;color:#f0f0f0;font-family:${MONO};line-height:1">${meetingCount}</div>
                  <div style="font-size:8px;text-transform:uppercase;letter-spacing:1.5px;color:#555;margin-top:3px;font-family:${FONT}">MEETINGS</div>
                </td>
                <td style="padding:0 6px;text-align:center;border-left:1px solid #222">
                  <div style="font-size:22px;font-weight:bold;color:#f0f0f0;font-family:${MONO};line-height:1">${emailCount}</div>
                  <div style="font-size:8px;text-transform:uppercase;letter-spacing:1.5px;color:#555;margin-top:3px;font-family:${FONT}">EMAILS</div>
                </td>
                <td style="padding:0 6px;text-align:center;border-left:1px solid #222">
                  <div style="font-size:22px;font-weight:bold;color:#f0f0f0;font-family:${MONO};line-height:1">${caseCount}</div>
                  <div style="font-size:8px;text-transform:uppercase;letter-spacing:1.5px;color:#555;margin-top:3px;font-family:${FONT}">CASES</div>
                </td>
                <td style="padding:0 6px;text-align:center;border-left:1px solid #222">
                  <div style="font-size:22px;font-weight:bold;color:#10b981;font-family:${MONO};line-height:1">${esc(pipelineDisplay)}</div>
                  <div style="font-size:8px;text-transform:uppercase;letter-spacing:1.5px;color:#555;margin-top:3px;font-family:${FONT}">PIPELINE</div>
                </td>
              </tr></table>
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:16px 0 0 0;font-size:1px;line-height:1px">&nbsp;</td></tr>

      ${body}

      <!-- FOOTER -->
      <tr><td style="padding:24px 28px 32px 28px">
        <div style="height:1px;background:#1e1e1e;margin-bottom:16px;font-size:1px;line-height:1px">&nbsp;</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="padding:0;vertical-align:middle"><span style="color:#333;font-size:11px;font-family:${MONO}">DailyBriefDashboard</span></td>
          <td style="padding:0;vertical-align:middle;text-align:right"><span style="color:#333;font-size:11px;font-family:${FONT}">Generated ${esc(genTime)} &middot; PAI Intelligence Pipeline</span></td>
        </tr></table>
      </td></tr>

    </table>
  </td></tr>
</table>

</body>
</html>`
}
