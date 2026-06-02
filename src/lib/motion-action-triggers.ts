/**
 * src/lib/motion-action-triggers.ts
 * Motion-Driven Action Triggers — GitHub Issue #546
 *
 * Shifts the morning brief from static summary to proactive action triggers.
 * Instead of "here is what happened," the brief says "act on these accounts
 * today because X changed."
 *
 * Triggers detected:
 * 1. Subscription expired within last 30 days → critical
 * 2. Subscription expiring within 30 days → high
 * 3. New support case on expired product → critical
 * 4. High-confidence motion with no campaigns generated → high
 * 5. Cloud spend change (future: compare current vs cached previous) → medium
 *
 * Dependencies:
 *   - feature-module-registry.ts — Signal type
 *   - motion-builder.ts — StrategicMotion type
 */

import type { Signal } from '../feature-module-registry.ts'
import type { StrategicMotion } from './motion-builder.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionTrigger {
  customerName: string
  customerSlug: string
  urgency: 'critical' | 'high' | 'medium'
  trigger: string
  suggestedAction: string
  motionTitle?: string
  phase?: string
}

// ── Constants ────────────────────────────────────────────────────────────────

/** How far back to look for expired subscriptions (days) */
const EXPIRED_LOOKBACK_DAYS = 30

/** How far ahead to look for expiring subscriptions (days) */
const EXPIRING_LOOKAHEAD_DAYS = 30

/** Urgency sort order: lower = higher priority */
const URGENCY_ORDER: Record<ActionTrigger['urgency'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysBetween(dateStr: string, now: Date): number {
  const target = new Date(dateStr)
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function daysAgo(dateStr: string, now: Date): number {
  return -daysBetween(dateStr, now)
}

// ── Trigger Detectors ────────────────────────────────────────────────────────

/**
 * Detect expired subscription triggers.
 * Urgency: critical — subscription expired within the last 30 days.
 */
function detectExpiredSubscriptions(
  customerSlug: string,
  customerName: string,
  signals: Signal[],
  now: Date,
): ActionTrigger[] {
  const triggers: ActionTrigger[] = []

  const subSignals = signals.filter(
    s => s.source === 'subscriptions' && s.type === 'subscription',
  )

  for (const sig of subSignals) {
    const m = sig.metadata ?? {}
    const urgency = String(m.urgency ?? '')
    const endDate = String(m.endDate ?? '')
    const product = String(m.product ?? 'Unknown')

    if ((urgency === 'expired' || urgency === 'expired-critical') && endDate) {
      const ago = daysAgo(endDate, now)
      if (ago > 0 && ago <= EXPIRED_LOOKBACK_DAYS) {
        triggers.push({
          customerName,
          customerSlug,
          urgency: 'critical',
          trigger: `${product} expired ${ago} days ago`,
          suggestedAction: `Renewal conversation needed this week. Check for active cases showing continued usage.`,
        })
      }
    }
  }

  return triggers
}

/**
 * Detect expiring-soon subscription triggers.
 * Urgency: high — subscription expiring within the next 30 days.
 */
function detectExpiringSoonSubscriptions(
  customerSlug: string,
  customerName: string,
  signals: Signal[],
  now: Date,
): ActionTrigger[] {
  const triggers: ActionTrigger[] = []

  const subSignals = signals.filter(
    s => s.source === 'subscriptions' && s.type === 'subscription',
  )

  for (const sig of subSignals) {
    const m = sig.metadata ?? {}
    const urgency = String(m.urgency ?? '')
    const endDate = String(m.endDate ?? '')
    const product = String(m.product ?? 'Unknown')

    if (urgency === 'expiring-soon' && endDate) {
      const daysUntil = daysBetween(endDate, now)
      if (daysUntil > 0 && daysUntil <= EXPIRING_LOOKAHEAD_DAYS) {
        triggers.push({
          customerName,
          customerSlug,
          urgency: 'high',
          trigger: `${product} expires in ${daysUntil} days`,
          suggestedAction: `Schedule renewal discussion before ${endDate}.`,
        })
      }
    }
  }

  return triggers
}

/**
 * Detect new support case on expired product.
 * Urgency: critical — customer is actively using a product without a license.
 */
function detectCaseOnExpiredProduct(
  customerSlug: string,
  customerName: string,
  signals: Signal[],
): ActionTrigger[] {
  const triggers: ActionTrigger[] = []

  // Find expired-critical subscriptions (already flagged by subscriptions module)
  const expiredCritical = signals.filter(
    s =>
      s.source === 'subscriptions' &&
      s.type === 'subscription' &&
      String(s.metadata?.urgency ?? '') === 'expired-critical',
  )

  if (expiredCritical.length === 0) return triggers

  // Find open cases
  const openCases = signals.filter(
    s =>
      s.source === 'cases' &&
      s.type === 'case' &&
      String(s.metadata?.status ?? '').toLowerCase() === 'open',
  )

  for (const sub of expiredCritical) {
    const subProduct = String(sub.metadata?.product ?? '').toLowerCase()
    const matchingCases = openCases.filter(c => {
      const caseProduct = String(c.metadata?.product ?? '').toLowerCase()
      return (
        (subProduct.includes('ansible') && caseProduct.includes('ansible')) ||
        (subProduct.includes('openshift') && caseProduct.includes('openshift')) ||
        (subProduct.includes('rhel') && caseProduct.includes('rhel')) ||
        caseProduct.includes(subProduct) ||
        subProduct.includes(caseProduct)
      )
    })

    for (const caseSignal of matchingCases) {
      triggers.push({
        customerName,
        customerSlug,
        urgency: 'critical',
        trigger: `New case filed on expired ${sub.metadata?.product} — customer still actively using without license`,
        suggestedAction: `Immediate renewal conversation. Case "${caseSignal.headline}" shows continued active usage.`,
      })
    }
  }

  return triggers
}

/**
 * Detect high-confidence motion with no action taken.
 * Urgency: high — motion exists with high confidence but no campaigns generated yet.
 */
function detectUnactedMotion(
  customerSlug: string,
  customerName: string,
  motion: StrategicMotion | null,
): ActionTrigger[] {
  if (!motion) return []
  if (motion.confidence !== 'high') return []

  // A motion is "unacted" if it has no campaigns generated.
  // Since campaigns are generated on-demand via the API, we check
  // if the motion exists but hasn't been acted on by looking at
  // whether it has phases but no campaign artifacts.
  // For now, the presence of a high-confidence motion is itself
  // an action trigger — the user should generate campaigns.
  return [
    {
      customerName,
      customerSlug,
      urgency: 'high',
      trigger: `High-confidence motion "${motion.title}" has no campaigns generated yet`,
      suggestedAction: `Generate campaigns for this motion to activate the account play.`,
      motionTitle: motion.title,
      phase: motion.phases[0]?.name,
    },
  ]
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect action triggers for a single customer.
 *
 * Returns triggers sorted by urgency (critical first, then high, then medium).
 * Each trigger includes what changed (trigger) and what to do about it (suggestedAction).
 *
 * @param customerSlug - Customer identifier
 * @param customerName - Human-readable customer name
 * @param motion - Strategic motion for this customer (null if none)
 * @param signals - All signals for this customer
 */
export function detectActionTriggers(
  customerSlug: string,
  customerName: string,
  motion: StrategicMotion | null,
  signals: Signal[],
): ActionTrigger[] {
  const now = new Date()

  const triggers: ActionTrigger[] = [
    ...detectExpiredSubscriptions(customerSlug, customerName, signals, now),
    ...detectExpiringSoonSubscriptions(customerSlug, customerName, signals, now),
    ...detectCaseOnExpiredProduct(customerSlug, customerName, signals),
    ...detectUnactedMotion(customerSlug, customerName, motion),
  ]

  // Sort by urgency: critical → high → medium
  triggers.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency])

  return triggers
}
