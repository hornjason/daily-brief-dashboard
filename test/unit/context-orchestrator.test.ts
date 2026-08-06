import { describe, it, expect } from 'bun:test'
import type {
  ConsumerContextRequest,
  ConsumerContext,
  ProvenanceEntry,
} from '../../src/lib/context-orchestrator'
import { buildConsumerContext } from '../../src/lib/context-orchestrator'

describe('context-orchestrator', () => {
  describe('type exports', () => {
    it('ConsumerContextRequest has required shape', () => {
      const request: ConsumerContextRequest = {
        customer: { name: 'Test Corp' } as any,
        consumerType: 'dashboard',
      }
      expect(request.consumerType).toBe('dashboard')
      expect(request.customer.name).toBe('Test Corp')
    })

    it('ConsumerContextRequest accepts all consumer types', () => {
      const types: ConsumerContextRequest['consumerType'][] = [
        'meeting-prep',
        'campaign',
        'playbook',
        'account-plan',
        'dashboard',
        'value-positioning',
        'expansion-opps',
      ]
      expect(types).toHaveLength(7)
    })

    it('ConsumerContext interface has layer structure', () => {
      const ctx: Partial<ConsumerContext> = {
        signalContext: '',
        signals: [],
        accountTeam: [],
        teamContext: '',
        provenance: [],
        productSlugs: [],
        slug: 'test-corp',
      }
      expect(ctx.slug).toBe('test-corp')
      expect(ctx.provenance).toEqual([])
    })

    it('ProvenanceEntry tracks source loading', () => {
      const entry: ProvenanceEntry = {
        source: 'signal-loader',
        loaded: true,
        tokenEstimate: 500,
      }
      expect(entry.source).toBe('signal-loader')
      expect(entry.loaded).toBe(true)
      expect(entry.tokenEstimate).toBe(500)
    })
  })

  describe('buildConsumerContext', () => {
    it('is exported as an async function', () => {
      expect(typeof buildConsumerContext).toBe('function')
    })
  })
})
