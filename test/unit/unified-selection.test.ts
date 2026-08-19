import { describe, it, expect, beforeEach } from 'bun:test'
import type {
  UnifiedSelectionResult,
  UnifiedPersona,
  UnifiedSelectionInput,
  BuyingCommitteeRole,
} from '../../src/lib/persona-selector.ts'

const validPersona = (role: BuyingCommitteeRole, name: string, title: string): UnifiedPersona => ({
  role,
  suggestedTitle: title,
  why: `${role} is critical for this campaign`,
  objectiveMatch: 'Cost reduction aligns with goals',
  peerProofCandidates: [{ company: 'Acme Corp', outcome: '40% cost reduction', relevance: 'Similar industry' }],
  timingTrigger: 'Q3 budget cycle',
  valueProposition: 'Automate infrastructure to reduce costs',
  competitiveContext: null,
  relationshipPath: 'Through existing AE relationship',
  installedBase: 'RHEL deployed across 500 servers',
  suppressTriggers: [],
  confidence: { overall: 'HIGH' },
  recipientName: name,
  tier: 'executive',
  intent: 'nurture',
  subject: 'Operational complexity growing',
  signalIndex: 0,
  featureKeys: ['ansible-automation-platform', 'event-driven-ansible', 'automation-mesh'],
  peerProof: { playName: 'Source Material Customer Wins', exampleIndex: 0 },
})

const validResult: UnifiedSelectionResult = {
  campaignTheme: 'Infrastructure automation',
  campaignSummary: 'Campaign targeting automation for Acme Corp',
  customerContext: 'Recent RHEL renewal signals expansion opportunity',
  positioning: 'Red Hat automates at scale — competitor cannot match event-driven workflows',
  reasoning: 'Selected 3 roles based on campaign material focus',
  selectedRoles: ['executive-sponsor', 'technical-evaluator', 'champion'],
  personas: [
    validPersona('executive-sponsor', 'Jane Smith', 'CIO'),
    validPersona('technical-evaluator', 'Bob Jones', 'Sr. Platform Engineer'),
    { ...validPersona('champion', 'Alice Lee', 'Director of IT'), tier: 'manager' as const },
  ],
}

const minimalInput: UnifiedSelectionInput = {
  materialTitle: 'Test Campaign',
  materialContent: 'Red Hat Ansible Automation Platform helps organizations automate.',
  customerName: 'Acme Corp',
  featureKeys: ['ansible-automation-platform', 'event-driven-ansible', 'automation-mesh'],
  registrySignals: [],
  resolvedContacts: [
    { name: 'Jane Smith', title: 'CIO', role: 'executive-sponsor' },
    { name: 'Bob Jones', title: 'Sr. Platform Engineer', role: 'technical-evaluator' },
    { name: 'Alice Lee', title: 'Director of IT', role: 'champion' },
  ],
}

// ── UNIFIED_SELECTION_SCHEMA ────────────────────────────────────────────

describe('UNIFIED_SELECTION_SCHEMA', () => {
  let schema: any

  beforeEach(async () => {
    const mod = await import('../../src/lib/persona-selector.ts')
    schema = mod.UNIFIED_SELECTION_SCHEMA
  })

  it('has required top-level fields for both Pass 0 and Pass 1', () => {
    expect(schema.type).toBe('OBJECT')
    const propNames = Object.keys(schema.properties)
    expect(propNames).toContain('campaignTheme')
    expect(propNames).toContain('campaignSummary')
    expect(propNames).toContain('customerContext')
    expect(propNames).toContain('positioning')
    expect(propNames).toContain('reasoning')
    expect(propNames).toContain('selectedRoles')
    expect(propNames).toContain('personas')
  })

  it('persona items have all PersonaBrief AND email selection fields', () => {
    const personaProps = schema.properties.personas.items.properties
    const briefFields = [
      'role', 'suggestedTitle', 'why', 'objectiveMatch',
      'peerProofCandidates', 'timingTrigger', 'valueProposition',
      'competitiveContext', 'relationshipPath', 'installedBase',
      'suppressTriggers', 'confidence',
    ]
    const emailFields = ['recipientName', 'tier', 'intent', 'subject', 'signalIndex', 'featureKeys', 'peerProof']

    for (const field of [...briefFields, ...emailFields]) {
      expect(personaProps).toHaveProperty(field)
    }
  })

  it('requires all critical fields in persona items', () => {
    const required = schema.properties.personas.items.required
    expect(required).toContain('role')
    expect(required).toContain('recipientName')
    expect(required).toContain('featureKeys')
    expect(required).toContain('signalIndex')
  })
})

// ── buildUnifiedSelectionPrompt ─────────────────────────────────────────

describe('buildUnifiedSelectionPrompt', () => {
  let buildUnifiedSelectionPrompt: typeof import('../../src/lib/persona-selector.ts').buildUnifiedSelectionPrompt

  beforeEach(async () => {
    const mod = await import('../../src/lib/persona-selector.ts')
    buildUnifiedSelectionPrompt = mod.buildUnifiedSelectionPrompt
  })

  it('includes campaign topic, customer name, contacts, and feature keys', () => {
    const prompt = buildUnifiedSelectionPrompt(minimalInput)
    expect(prompt).toContain('Campaign Topic: Test Campaign')
    expect(prompt).toContain('Customer: Acme Corp')
    expect(prompt).toContain('Jane Smith')
    expect(prompt).toContain('Bob Jones')
    expect(prompt).toContain('Available Feature Keys')
    expect(prompt).toContain('ansible-automation-platform')
  })

  it('includes intelligence and account plan when provided', () => {
    const prompt = buildUnifiedSelectionPrompt({
      ...minimalInput,
      intelligenceText: '## Executive Summary\nCompany is growing fast.\n## Leadership\nCEO: John Doe',
      accountPlanText: '## Key Stakeholders\nCIO: Jane Smith\n## Initiatives\nCloud migration',
    })
    expect(prompt).toContain('Customer Intelligence')
    expect(prompt).toContain('Account Plan')
  })

  it('includes deterministic context and campaign directive', () => {
    const prompt = buildUnifiedSelectionPrompt({
      ...minimalInput,
      deterministicContext: 'Pipeline: $500K renewal',
      campaignDirective: 'Focus on SaaS tax',
    })
    expect(prompt).toContain('Deterministic')
    expect(prompt).toContain('Campaign Directive')
    expect(prompt).toContain('SaaS tax')
  })

  it('includes resolved contacts section', () => {
    const prompt = buildUnifiedSelectionPrompt(minimalInput)
    expect(prompt).toContain('RESOLVED CONTACTS')
    expect(prompt).toContain('Jane Smith, CIO (role: executive-sponsor)')
  })

  it('includes signals when provided', () => {
    const prompt = buildUnifiedSelectionPrompt({
      ...minimalInput,
      registrySignals: [
        { type: 'news', headline: 'Acme announces cloud strategy', detail: 'Details here' } as any,
      ],
    })
    expect(prompt).toContain('[0] [news] Acme announces cloud strategy')
  })
})

// ── validateUnifiedResult ───────────────────────────────────────────────

describe('validateUnifiedResult', () => {
  let validateUnifiedResult: typeof import('../../src/lib/persona-selector.ts').validateUnifiedResult

  beforeEach(async () => {
    const mod = await import('../../src/lib/persona-selector.ts')
    validateUnifiedResult = mod.validateUnifiedResult
  })

  it('accepts valid result with 3 personas', () => {
    const result = validateUnifiedResult(validResult)
    expect(result).not.toBeNull()
    expect(result!.personas).toHaveLength(3)
    expect(result!.campaignTheme).toBe('Infrastructure automation')
  })

  it('rejects result with fewer than 3 personas', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [validPersona('executive-sponsor', 'Jane', 'CIO')],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects invalid role enum value', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', 'Alice', 'Dir'), role: 'invalid-role' as BuyingCommitteeRole },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects missing recipientName', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', '', 'Dir'), recipientName: '' },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects wrong featureKeys count', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', 'Alice', 'Dir'), featureKeys: ['only-one'] },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects invalid signalIndex', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', 'Alice', 'Dir'), signalIndex: -1 },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects missing campaign-level fields', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      campaignSummary: '',
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects invalid tier', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', 'Alice', 'Dir'), tier: 'invalid' as any },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects invalid intent', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', 'Alice', 'Dir'), intent: 'unknown' as any },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects missing suggestedTitle', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', 'Alice', ''), suggestedTitle: '' },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })

  it('rejects missing subject', () => {
    const input: UnifiedSelectionResult = {
      ...validResult,
      personas: [
        validPersona('executive-sponsor', 'Jane', 'CIO'),
        validPersona('technical-evaluator', 'Bob', 'SE'),
        { ...validPersona('champion', 'Alice', 'Dir'), subject: '' },
      ],
    }
    expect(validateUnifiedResult(input)).toBeNull()
  })
})

// ── callGeminiForUnifiedSelection ───────────────────────────────────────

describe('callGeminiForUnifiedSelection', () => {
  it('returns null gracefully when Gemini is unavailable', async () => {
    const mod = await import('../../src/lib/persona-selector.ts')
    const result = await mod.callGeminiForUnifiedSelection(minimalInput)
    expect(result).toBeNull()
  })
})
