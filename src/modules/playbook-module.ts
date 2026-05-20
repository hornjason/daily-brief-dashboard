// src/modules/playbook-module.ts
// GitHub Issue #299 — Playbook feature module registration
// ADR-026 Section 5 — Register as feature module and contribute signals

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { readPlaybook } from '../playbook-generator.ts'
import type { ActionItem, EngagementEntry } from '../playbook-types.ts'

/**
 * Convert an open action item to a signal.
 */
function actionItemToSignal(item: ActionItem, customerSlug: string): Signal {
  return {
    source: 'playbook',
    type: 'account-plan',
    headline: item.text,
    detail: `Owner: ${item.owner}`,
    rawRelevance: 0.7,
    timestamp: item.createdAt,
    metadata: {
      customerSlug,
      owner: item.owner,
    },
  }
}

/**
 * Convert an engagement entry to a signal.
 * Only include entries from the last 30 days.
 */
function engagementEntryToSignal(entry: EngagementEntry, customerSlug: string): Signal | null {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  const entryDate = new Date(entry.date).getTime()

  if (entryDate < thirtyDaysAgo) {
    return null
  }

  return {
    source: 'playbook',
    type: 'meeting',
    headline: entry.summary,
    detail: `Attendees: ${entry.attendees.join(', ')}`,
    rawRelevance: 0.6,
    timestamp: entry.date,
    metadata: {
      customerSlug,
      attendees: entry.attendees,
    },
  }
}

FeatureModuleRegistry.register({
  name: 'playbook',

  scope: 'customer',

  accountTab: {
    label: 'Playbook',
    icon: 'BookOpen',
    order: 5,
  },

  cachePaths: (slug: string) => [
    `data/cache/playbooks/${slug}.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/Playbook/`,
  ],

  refreshInterval: null, // on-demand only

  async fetch(_customerName: string): Promise<void> {
    // No-op — playbook generation is on-demand via API
    return Promise.resolve()
  },

  async cleanup(customerName: string): Promise<void> {
    const { toSlug } = await import('../cache-layer')
    const { unlinkSync, existsSync } = await import('fs')
    const { resolve } = await import('path')

    const slug = toSlug(customerName)
    const playbooksDir = resolve(process.env.CACHE_DIR ?? 'data/cache', 'playbooks')
    const playbookFile = resolve(playbooksDir, `${slug}.json`)

    if (existsSync(playbookFile)) {
      try {
        unlinkSync(playbookFile)
        console.log(`[playbook-module] Deleted ${slug}.json`)
      } catch (e: any) {
        console.warn(`[playbook-module] Failed to delete ${slug}.json:`, e.message)
      }
    }
  },

  async syncNow(_customerName: string): Promise<void> {
    // No-op — playbook is updated via ingest-notes or generate endpoints
    return Promise.resolve()
  },

  /**
   * Contribute playbook signals to the universal stack.
   * - Open action items → action-item signals
   * - Recent engagement entries (last 30 days) → meeting signals
   */
  async signals(customerSlug: string): Promise<Signal[]> {
    const playbook = readPlaybook(customerSlug)

    if (!playbook) {
      return []
    }

    const signals: Signal[] = []

    // Open action items
    for (const item of playbook.sections.openActionItems.items) {
      if (item.status === 'open') {
        signals.push(actionItemToSignal(item, customerSlug))
      }
    }

    // Recent engagement entries
    for (const entry of playbook.sections.engagementHistory.entries) {
      const signal = engagementEntryToSignal(entry, customerSlug)
      if (signal) {
        signals.push(signal)
      }
    }

    // MEDDPICC qualification gaps
    const meddpicc = playbook.sections.meddpicc
    if (meddpicc?.entries?.length) {
      const unknowns = meddpicc.entries.filter(e => e.status === 'unknown')
      if (unknowns.length > 0) {
        signals.push({
          source: 'playbook',
          type: 'qualification-gap',
          headline: `MEDDPICC: ${unknowns.length} qualification gap${unknowns.length > 1 ? 's' : ''}`,
          detail: `Unknown fields: ${unknowns.map(e => e.displayName).join(', ')}. Needs discovery conversations.`,
          rawRelevance: unknowns.length >= 5 ? 0.8 : unknowns.length >= 3 ? 0.6 : 0.4,
          timestamp: meddpicc.updatedAt,
          metadata: { customerSlug },
        })
      }
    }

    return signals
  },
})
