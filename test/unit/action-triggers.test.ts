/**
 * test/unit/action-triggers.test.ts
 * TDD tests for motion-driven action triggers — GitHub Issue #546
 *
 * Validates that detectActionTriggers() correctly identifies:
 * 1. Expired subscriptions (critical urgency)
 * 2. Expiring-soon subscriptions (high urgency)
 * 3. High-confidence motions with no campaigns generated (high urgency)
 * 4. Quiet customers with no triggers (empty result)
 * 5. Triggers sorted by urgency (critical first)
 */

import { describe, it, expect } from 'bun:test'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { StrategicMotion } from '../../src/lib/motion-builder.ts'
import { detectActionTriggers, type ActionTrigger } from '../../src/lib/motion-action-triggers.ts'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> & { source: string; type: Signal['type'] }): Signal {
  return {
    headline: 'Test signal',
    detail: 'Test detail',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeMotion(overrides: Partial<StrategicMotion> = {}): StrategicMotion {
  return {
    id: 'motion:test-customer',
    customerSlug: 'test-customer',
    customerName: 'Test Customer',
    title: 'Test Motion',
    phases: [],
    confidence: 'medium',
    generatedAt: new Date().toISOString(),
    status: 'active',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('detectActionTriggers', () => {
  it('detects expired subscription trigger', () => {
    const twentyOneDaysAgo = new Date()
    twentyOneDaysAgo.setDate(twentyOneDaysAgo.getDate() - 21)

    const signals: Signal[] = [
      makeSignal({
        source: 'subscriptions',
        type: 'subscription',
        headline: 'Ansible Automation Platform — 5 subscriptions',
        detail: `Earliest renewal: ${twentyOneDaysAgo.toISOString().split('T')[0]}`,
        metadata: {
          customerSlug: 'acme-corp',
          product: 'Ansible Automation Platform',
          quantity: 5,
          endDate: twentyOneDaysAgo.toISOString().split('T')[0],
          urgency: 'expired',
        },
      }),
    ]

    const triggers = detectActionTriggers('acme-corp', 'Acme Corp', null, signals)

    expect(triggers.length).toBeGreaterThanOrEqual(1)
    const expiredTrigger = triggers.find(t => t.urgency === 'critical')
    expect(expiredTrigger).toBeDefined()
    expect(expiredTrigger!.trigger).toContain('expired')
    expect(expiredTrigger!.customerSlug).toBe('acme-corp')
    expect(expiredTrigger!.customerName).toBe('Acme Corp')
    expect(expiredTrigger!.suggestedAction).toBeTruthy()
  })

  it('detects expiring-soon subscription trigger', () => {
    const twentyEightDaysFromNow = new Date()
    twentyEightDaysFromNow.setDate(twentyEightDaysFromNow.getDate() + 28)

    const signals: Signal[] = [
      makeSignal({
        source: 'subscriptions',
        type: 'subscription',
        headline: 'RHEL — 10 subscriptions',
        detail: `Earliest renewal: ${twentyEightDaysFromNow.toISOString().split('T')[0]}`,
        metadata: {
          customerSlug: 'acme-corp',
          product: 'RHEL',
          quantity: 10,
          endDate: twentyEightDaysFromNow.toISOString().split('T')[0],
          urgency: 'expiring-soon',
        },
      }),
    ]

    const triggers = detectActionTriggers('acme-corp', 'Acme Corp', null, signals)

    expect(triggers.length).toBeGreaterThanOrEqual(1)
    const expiringTrigger = triggers.find(t => t.urgency === 'high')
    expect(expiringTrigger).toBeDefined()
    expect(expiringTrigger!.trigger).toContain('expir')
    expect(expiringTrigger!.suggestedAction).toBeTruthy()
  })

  it('detects new case on expired product trigger', () => {
    const tenDaysAgo = new Date()
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10)

    const signals: Signal[] = [
      makeSignal({
        source: 'subscriptions',
        type: 'subscription',
        headline: 'Ansible Automation Platform — 3 subscriptions',
        metadata: {
          customerSlug: 'acme-corp',
          product: 'Ansible Automation Platform',
          quantity: 3,
          endDate: tenDaysAgo.toISOString().split('T')[0],
          urgency: 'expired-critical',
        },
      }),
      makeSignal({
        source: 'cases',
        type: 'case',
        headline: 'Ansible playbook execution failure',
        metadata: {
          customerSlug: 'acme-corp',
          product: 'Ansible Automation Platform',
          severity: '2',
          status: 'open',
        },
      }),
    ]

    const triggers = detectActionTriggers('acme-corp', 'Acme Corp', null, signals)

    const criticalTrigger = triggers.find(
      t => t.urgency === 'critical' && t.trigger.toLowerCase().includes('case'),
    )
    expect(criticalTrigger).toBeDefined()
    expect(criticalTrigger!.suggestedAction).toBeTruthy()
  })

  it('detects high-confidence motion with no campaigns', () => {
    const motion = makeMotion({
      confidence: 'high',
      customerSlug: 'crowdstrike',
      customerName: 'CrowdStrike',
      title: 'Cloud-Native Platform for CrowdStrike',
      phases: [
        {
          id: 'phase-1',
          name: 'Expand: Container Mgmt',
          category: 'expand',
          urgency: 'high',
          tactics: [],
          targetPersonas: [],
          evidence: [],
        },
      ],
    })

    const triggers = detectActionTriggers(
      'crowdstrike',
      'CrowdStrike',
      motion,
      [], // no signals needed for this trigger
    )

    const motionTrigger = triggers.find(t => t.motionTitle)
    expect(motionTrigger).toBeDefined()
    expect(motionTrigger!.urgency).toBe('high')
    expect(motionTrigger!.trigger).toContain('motion')
    expect(motionTrigger!.suggestedAction).toBeTruthy()
  })

  it('returns empty for customer with no triggers', () => {
    const signals: Signal[] = [
      makeSignal({
        source: 'subscriptions',
        type: 'subscription',
        headline: 'RHEL — 10 subscriptions',
        metadata: {
          customerSlug: 'quiet-customer',
          product: 'RHEL',
          quantity: 10,
          endDate: '2027-12-31',
          urgency: 'active',
        },
      }),
    ]

    const triggers = detectActionTriggers('quiet-customer', 'Quiet Customer', null, signals)
    expect(triggers).toEqual([])
  })

  it('triggers sorted by urgency (critical first)', () => {
    const expiredDate = new Date()
    expiredDate.setDate(expiredDate.getDate() - 15)

    const expiringDate = new Date()
    expiringDate.setDate(expiringDate.getDate() + 20)

    const signals: Signal[] = [
      // expiring-soon → high
      makeSignal({
        source: 'subscriptions',
        type: 'subscription',
        headline: 'RHEL — 10 subscriptions',
        metadata: {
          customerSlug: 'acme-corp',
          product: 'RHEL',
          quantity: 10,
          endDate: expiringDate.toISOString().split('T')[0],
          urgency: 'expiring-soon',
        },
      }),
      // expired → critical
      makeSignal({
        source: 'subscriptions',
        type: 'subscription',
        headline: 'Ansible — 5 subscriptions',
        metadata: {
          customerSlug: 'acme-corp',
          product: 'Ansible Automation Platform',
          quantity: 5,
          endDate: expiredDate.toISOString().split('T')[0],
          urgency: 'expired',
        },
      }),
    ]

    // Also add a high-confidence motion for a medium trigger
    const motion = makeMotion({
      confidence: 'high',
      customerSlug: 'acme-corp',
      customerName: 'Acme Corp',
    })

    const triggers = detectActionTriggers('acme-corp', 'Acme Corp', motion, signals)

    expect(triggers.length).toBeGreaterThanOrEqual(2)

    // Verify ordering: critical before high before medium
    for (let i = 0; i < triggers.length - 1; i++) {
      const urgencyOrder = { critical: 0, high: 1, medium: 2 }
      expect(urgencyOrder[triggers[i].urgency]).toBeLessThanOrEqual(
        urgencyOrder[triggers[i + 1].urgency],
      )
    }
  })
})
