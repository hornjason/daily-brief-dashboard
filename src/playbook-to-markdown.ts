/**
 * Playbook to Markdown — GitHub Issue #314
 *
 * Converts PlaybookState to markdown for Google Docs API rendering.
 * Replaces the HTML generation path (generatePlaybookHTML) with structured
 * markdown that feeds into markdownToDocsRequests -> docs.documents.batchUpdate.
 */

import type { PlaybookState } from './playbook-types.ts'

export function playbookToMarkdown(playbook: PlaybookState): string {
  const lines: string[] = []

  const generatedDate = new Date(playbook.generatedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  lines.push(`# Customer Engagement Playbook: ${playbook.customerName}`)
  lines.push('')
  lines.push(`**Generated:** ${generatedDate}`)
  lines.push('')

  // 1. Strategic Position
  lines.push('## Strategic Position')
  lines.push('')
  lines.push(playbook.sections.strategicPosition.content)
  lines.push('')

  // 2. SWOT Analysis
  lines.push('## SWOT Analysis')
  lines.push('')
  lines.push(playbook.sections.swotAnalysis?.content ?? '*No SWOT analysis*')
  lines.push('')

  // 3. Key Relationships
  lines.push('## Key Relationships')
  lines.push('')
  lines.push(playbook.sections.keyRelationships.content)
  lines.push('')

  // 4. Current Priorities
  lines.push('## Current Priorities')
  lines.push('')
  lines.push(playbook.sections.currentPriorities.content)
  lines.push('')

  // 5. MEDDPICC Qualification
  lines.push('## MEDDPICC Qualification')
  lines.push('')
  if (playbook.sections.meddpicc?.entries?.length) {
    lines.push(`**Qualification Score: ${playbook.sections.meddpicc.qualificationScore}%** (${playbook.sections.meddpicc.entries.filter(e => e.status === 'confirmed').length}/8 confirmed)`)
    lines.push('')
    for (const entry of playbook.sections.meddpicc.entries) {
      const status = entry.status.toUpperCase()
      lines.push(`### ${entry.displayName} (${status})`)
      lines.push('')
      lines.push(entry.evidence)
      lines.push('')
    }
  } else {
    lines.push('*No MEDDPICC data*')
    lines.push('')
  }

  // 6. Product Alignment
  lines.push('## Product Alignment')
  lines.push('')
  if (playbook.sections.productAlignment.products.length === 0) {
    lines.push('*No product alignment data*')
    lines.push('')
  } else {
    for (const product of playbook.sections.productAlignment.products) {
      lines.push(`### ${product.displayName} (${product.confidence})`)
      lines.push('')
      lines.push(product.useCase)
      lines.push('')
      if (product.proofPoints) {
        lines.push('**Proof Points:**')
        const points = product.proofPoints.split('|').map(p => p.trim()).filter(Boolean)
        for (const point of points) {
          lines.push(`- ${point}`)
        }
        lines.push('')
      }
      if (product.whatsNew) {
        lines.push(`**What's New:** ${product.whatsNew}`)
        lines.push('')
      }
      if (product.lifecycle) {
        lines.push(`**Lifecycle:** ${product.lifecycle}`)
        lines.push('')
      }
      if (product.featureTalkingPoints) {
        lines.push(`**Feature Talking Points:** ${product.featureTalkingPoints}`)
        lines.push('')
      }
    }
  }

  // 7. Solution Plays
  lines.push('## Solution Plays')
  lines.push('')
  const plays = playbook.deterministic?.solutionPlays ?? []
  if (plays.length === 0) {
    lines.push('*No solution plays identified*')
    lines.push('')
  } else {
    for (const play of plays) {
      lines.push(`### ${play.playName} (${play.confidence})`)
      lines.push('')
      lines.push(`**TDP:** ${play.tdp} | **Triggers:** ${play.triggerTechnologies.join(', ')}`)
      lines.push('')
      if (play.talkTrack) {
        lines.push(`*${play.talkTrack}*`)
        lines.push('')
      }
      if (play.customerWins?.length) {
        lines.push('**Customer Wins:**')
        for (const win of play.customerWins.slice(0, 3)) {
          lines.push(`- ${win}`)
        }
        lines.push('')
      }
      if (play.linkedAssets?.length) {
        lines.push('**Assets:**')
        for (const asset of play.linkedAssets.slice(0, 3)) {
          lines.push(`- ${asset.name}`)
        }
        lines.push('')
      }
    }
  }

  // 8. Open Action Items
  lines.push('## Open Action Items')
  lines.push('')
  if (playbook.sections.openActionItems.items.length === 0) {
    lines.push('*No action items*')
    lines.push('')
  } else {
    for (const item of playbook.sections.openActionItems.items) {
      const status = item.status.toUpperCase()
      const icon = item.status === 'completed' ? '[x]' : '[ ]'
      lines.push(`- ${icon} **${status}** ${item.text} (Owner: ${item.owner})`)
    }
    lines.push('')
  }

  // 9. Engagement History
  lines.push('## Engagement History')
  lines.push('')
  if (playbook.sections.engagementHistory.entries.length === 0) {
    lines.push('*No engagement history*')
    lines.push('')
  } else {
    for (const entry of playbook.sections.engagementHistory.entries.slice(0, 10)) {
      const attendeeList = entry.attendees.length ? ` (${entry.attendees.join(', ')})` : ''
      lines.push(`- **${entry.date}** ${entry.type.toUpperCase()}: ${entry.summary}${attendeeList}`)
    }
    lines.push('')
  }

  // 10. Expansion Opportunities
  lines.push('## Expansion Opportunities')
  lines.push('')
  lines.push(playbook.sections.expansionOpportunities.content || '*No expansion opportunities*')
  lines.push('')

  // 11. Renewals and Risk
  lines.push('## Renewals and Risk')
  lines.push('')
  lines.push(playbook.sections.renewalsAndRisk.content || '*No renewals or risk data*')
  lines.push('')

  // Deterministic data appendix
  if (playbook.deterministic.subscriptions.length > 0) {
    lines.push('## Subscriptions')
    lines.push('')
    lines.push('| SKU | Product | Qty | Status | End Date |')
    lines.push('|---|---|---|---|---|')
    for (const sub of playbook.deterministic.subscriptions) {
      lines.push(`| ${sub.sku} | ${sub.productDescription} | ${sub.quantity} | ${sub.status} | ${sub.endDate ?? 'N/A'} |`)
    }
    lines.push('')
  }

  if (playbook.deterministic.cases.length > 0) {
    lines.push('## Support Cases')
    lines.push('')
    lines.push('| Case # | Summary | Status | Severity | Days Open |')
    lines.push('|---|---|---|---|---|')
    for (const c of playbook.deterministic.cases) {
      lines.push(`| ${c.caseNumber} | ${c.summary} | ${c.status} | ${c.severity} | ${c.daysOpen} |`)
    }
    lines.push('')
  }

  lines.push(`---`)
  lines.push('')
  lines.push(`*Generated by PAI Intelligence — ${generatedDate}*`)

  return lines.join('\n')
}
