/**
 * Post-generation validator for campaign HTML output.
 * Pattern-based quality checks — no hardcoded strings.
 * Runs after generateCampaignFromStructured() returns.
 */

export interface ValidationResult {
  pass: boolean
  failures: Array<{ check: string; severity: 'blocker' | 'warning'; detail: string }>
}

interface EmailBody {
  recipient: string
  tier: 'executive' | 'manager'
  opener: string
  body: string
  rawHtml: string
}

function extractEmailBodies(html: string): EmailBody[] {
  const emails: EmailBody[] = []
  // Email containers: <div> blocks with red header containing recipient name + tier
  const emailRegex = /<div style="border: 2px solid #dadce0;[^"]*">[\s\S]*?<span[^>]*>📧\s+([^—]+)\s*—\s*([^<]+)<\/span>[\s\S]*?<div style="padding: 20px;">([\s\S]*?)<div style="margin-top: 20px; padding-top: 14px/g
  let match
  while ((match = emailRegex.exec(html)) !== null) {
    const recipient = match[1].trim()
    const tierLabel = match[2].trim().toLowerCase()
    const bodyHtml = match[3]
    const bodyText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

    // Opener is the first <p> content in the body
    const openerMatch = bodyHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const opener = openerMatch
      ? openerMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : ''

    const tier: 'executive' | 'manager' = tierLabel.includes('executive') ||
      tierLabel.includes('ceo') || tierLabel.includes('cfo') || tierLabel.includes('cto') ||
      tierLabel.includes('cio') || tierLabel.includes('vp') || tierLabel.includes('chief') ||
      tierLabel.includes('president')
      ? 'executive'
      : 'manager'

    emails.push({ recipient, tier, opener, body: bodyText, rawHtml: bodyHtml })
  }
  return emails
}

export function validateCampaignOutput(html: string): ValidationResult {
  const failures: ValidationResult['failures'] = []
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  const emailBodies = extractEmailBodies(html)

  // 1. Opener completeness
  for (const email of emailBodies) {
    if (!email.opener) {
      failures.push({ check: 'opener-present', severity: 'blocker', detail: `${email.recipient}: no opener found` })
      continue
    }
    if (/\.\.\.\s*$/.test(email.opener)) {
      failures.push({ check: 'opener-fragment', severity: 'blocker', detail: `${email.recipient}: opener is a fragment: "${email.opener.slice(0, 60)}..."` })
    }
    if (/^[A-Z][a-z]+,\s+[a-z]+(s|es|ed|ing)\b/.test(email.opener)) {
      failures.push({ check: 'opener-no-subject', severity: 'warning', detail: `${email.recipient}: opener may lack subject` })
    }
  }

  // 2. No duplicate openers
  const openerTexts = emailBodies.map(e => e.opener?.slice(0, 50)).filter(Boolean)
  const uniqueOpeners = new Set(openerTexts)
  if (uniqueOpeners.size < openerTexts.length) {
    failures.push({ check: 'opener-duplicate', severity: 'blocker', detail: `${openerTexts.length - uniqueOpeners.size} duplicate openers` })
  }

  // 3. Markdown label leak: **Label:** pattern in email body
  for (const email of emailBodies) {
    const labelMatch = email.body.match(/\*\*[A-Z][^*]+?:?\*\*:?/)
    if (labelMatch) {
      failures.push({ check: 'markdown-label-leak', severity: 'blocker', detail: `${email.recipient}: label "${labelMatch[0]}" in email body` })
    }
  }

  // 4. Coaching language: imperative instructions addressed to AE
  const coachingPatterns = /\b(show how|highlight|demonstrate|emphasize|position|leverage)\b.*?\b(Ansible|Red Hat|OpenShift|RHEL)\b/i
  for (const email of emailBodies) {
    const coachMatch = email.body.match(coachingPatterns)
    if (coachMatch) {
      failures.push({ check: 'coaching-language', severity: 'blocker', detail: `${email.recipient}: coaching text: "${coachMatch[0].slice(0, 60)}"` })
    }
  }

  // 5. Internal terminology
  const internalTerms = /\b(rawRelevance|signalIndex|signal source|module registry|templateAll|Company intelligence)\b/i
  for (const email of emailBodies) {
    const termMatch = email.body.match(internalTerms)
    if (termMatch) {
      failures.push({ check: 'internal-terminology', severity: 'blocker', detail: `${email.recipient}: internal term: "${termMatch[0]}"` })
    }
  }

  // 6. Product staging labels
  for (const email of emailBodies) {
    const stageMatch = email.body.match(/\((?:concept|beta|preview|internal)\)/i)
    if (stageMatch) {
      failures.push({ check: 'staging-label', severity: 'warning', detail: `${email.recipient}: staging label: "${stageMatch[0]}"` })
    }
  }

  // 7. Word count: exec <=180, manager <=240
  for (const email of emailBodies) {
    const words = email.body.split(/\s+/).filter(w => w.length > 0).length
    const limit = email.tier === 'executive' ? 180 : 240
    if (words > limit) {
      failures.push({ check: 'word-count', severity: 'warning', detail: `${email.recipient}: ${words} words (limit ${limit})` })
    }
  }

  // 8. Source URLs present: at least 1 external source link per email
  for (const email of emailBodies) {
    const hasExternalUrl = /<a[^>]*href="https?:\/\/(?!.*redhat\.com)[^"]+"/i.test(email.rawHtml)
    if (!hasExternalUrl) {
      failures.push({ check: 'source-url-missing', severity: 'warning', detail: `${email.recipient}: no external source URL in email` })
    }
  }

  // 9. Feature bullets: each email should have >=2 product links
  for (const email of emailBodies) {
    const rhLinks = (email.rawHtml.match(/href="[^"]*redhat\.com[^"]*"/g) || []).length
    if (rhLinks < 2) {
      failures.push({ check: 'feature-links', severity: 'warning', detail: `${email.recipient}: only ${rhLinks} Red Hat product links` })
    }
  }

  // 10. Sign-off completeness
  for (const email of emailBodies) {
    if (!email.body.includes('@redhat.com')) {
      failures.push({ check: 'signoff-email', severity: 'warning', detail: `${email.recipient}: no AE email in sign-off` })
    }
  }

  // 11. Section completeness
  const requiredSections = ['Target Contacts', 'Generation Config', 'Quality Checklist', 'Intelligence Dashboard', 'Executive Outreach', 'Manager Outreach']
  for (const section of requiredSections) {
    if (!text.includes(section)) {
      failures.push({ check: 'section-missing', severity: 'blocker', detail: `Missing section: ${section}` })
    }
  }

  // 12. DENY patterns (internal data leaks)
  const denyPatterns = [
    { pattern: /\$\d[\d,.]*[kKmMbB]?\s+(?:pipeline|deal)/i, label: 'pipeline dollar amounts' },
    { pattern: /pipeline\s+(?:opportunit|value)/i, label: 'pipeline value language' },
    { pattern: /support\s+(?:case|ticket)/i, label: 'support case references' },
    { pattern: /\d+\s+(?:RHEL\s+)?subscriptions?\b/i, label: 'subscription counts' },
    { pattern: /NN-\d+/i, label: 'internal prefix' },
  ]
  for (const { pattern, label } of denyPatterns) {
    const denyMatch = text.match(pattern)
    if (denyMatch) {
      failures.push({ check: 'deny-pattern', severity: 'blocker', detail: `${label}: "${denyMatch[0]}"` })
    }
  }

  return { pass: failures.filter(f => f.severity === 'blocker').length === 0, failures }
}
