import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { Pass0Result, PersonaBrief, BuyingCommitteeRole, Pass0PromptInput } from '../../src/lib/persona-selector.ts'

const validBrief = (role: BuyingCommitteeRole, title: string): PersonaBrief => ({
  role,
  suggestedTitle: title,
  why: `${role} is critical for this campaign`,
  objectiveMatch: 'Cost reduction aligns with financial goals',
  peerProofCandidates: [{ company: 'Acme Corp', outcome: '40% cost reduction', relevance: 'Similar industry' }],
  timingTrigger: 'Q3 budget cycle',
  valueProposition: 'Automate infrastructure to reduce costs',
  featureKeys: ['ansible-automation-platform', 'event-driven-ansible', 'automation-mesh'],
  competitiveContext: null,
  relationshipPath: 'Through existing AE relationship',
  installedBase: 'RHEL deployed across 500 servers',
  suppressTriggers: [],
  confidence: { overall: 'HIGH' },
})

const validPass0Result: Pass0Result = {
  selectedRoles: ['executive-sponsor', 'technical-evaluator', 'champion'] as BuyingCommitteeRole[],
  briefs: [
    validBrief('executive-sponsor', 'CIO'),
    validBrief('technical-evaluator', 'Sr. Platform Engineer'),
    validBrief('champion', 'Director of IT'),
  ],
  reasoning: 'Selected 3 roles based on campaign material focus',
  campaignTheme: 'Infrastructure automation',
}

const minimalInput: Pass0PromptInput = {
  materialTitle: 'Test Campaign',
  materialContent: 'Red Hat Ansible Automation Platform helps organizations automate.',
  customerName: 'Acme Corp',
  featureKeys: ['ansible-automation-platform', 'event-driven-ansible'],
}

// ── validatePass0Result ──────────────────────────────────────────────────

describe('validatePass0Result', () => {
  let validatePass0Result: typeof import('../../src/lib/persona-selector.ts').validatePass0Result

  beforeEach(async () => {
    const mod = await import('../../src/lib/persona-selector.ts')
    validatePass0Result = mod.validatePass0Result
  })

  it('accepts valid result with 3 personas', () => {
    const result = validatePass0Result(validPass0Result)
    expect(result).not.toBeNull()
    expect(result!.briefs).toHaveLength(3)
  })

  it('accepts valid result with 4 personas', () => {
    const input: Pass0Result = {
      ...validPass0Result,
      selectedRoles: ['executive-sponsor', 'technical-evaluator', 'champion', 'practitioner'],
      briefs: [
        ...validPass0Result.briefs,
        validBrief('practitioner', 'DevOps Engineer'),
      ],
    }
    const result = validatePass0Result(input)
    expect(result).not.toBeNull()
    expect(result!.briefs).toHaveLength(4)
  })

  it('accepts valid result with 5 personas', () => {
    const input: Pass0Result = {
      ...validPass0Result,
      selectedRoles: ['executive-sponsor', 'technical-evaluator', 'champion', 'practitioner', 'financial-gatekeeper'],
      briefs: [
        ...validPass0Result.briefs,
        validBrief('practitioner', 'DevOps Engineer'),
        validBrief('financial-gatekeeper', 'CFO'),
      ],
    }
    const result = validatePass0Result(input)
    expect(result).not.toBeNull()
  })

  it('rejects result with 0 personas', () => {
    const input: Pass0Result = { ...validPass0Result, briefs: [], selectedRoles: [] }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects result with 1 persona', () => {
    const input: Pass0Result = {
      ...validPass0Result,
      briefs: [validBrief('executive-sponsor', 'CIO')],
      selectedRoles: ['executive-sponsor'],
    }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects result with 2 personas', () => {
    const input: Pass0Result = {
      ...validPass0Result,
      briefs: [validBrief('executive-sponsor', 'CIO'), validBrief('champion', 'Director')],
      selectedRoles: ['executive-sponsor', 'champion'],
    }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects result with 6+ personas', () => {
    const roles: BuyingCommitteeRole[] = ['executive-sponsor', 'technical-evaluator', 'champion', 'practitioner', 'financial-gatekeeper']
    const briefs = roles.map(r => validBrief(r, 'Title'))
    briefs.push(validBrief('executive-sponsor', 'Extra'))
    const input: Pass0Result = { ...validPass0Result, briefs, selectedRoles: [...roles, 'executive-sponsor'] }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects duplicate roles', () => {
    const input: Pass0Result = {
      ...validPass0Result,
      selectedRoles: ['executive-sponsor', 'executive-sponsor', 'champion'],
      briefs: [
        validBrief('executive-sponsor', 'CIO'),
        validBrief('executive-sponsor', 'CEO'),
        validBrief('champion', 'Director'),
      ],
    }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects invalid role enum values', () => {
    const input: Pass0Result = {
      ...validPass0Result,
      selectedRoles: ['executive-sponsor', 'technical-evaluator', 'invalid-role' as BuyingCommitteeRole],
      briefs: [
        validBrief('executive-sponsor', 'CIO'),
        validBrief('technical-evaluator', 'SE'),
        { ...validBrief('champion', 'X'), role: 'invalid-role' as BuyingCommitteeRole },
      ],
    }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects missing required field: role', () => {
    const badBrief = { ...validBrief('executive-sponsor', 'CIO'), role: '' as BuyingCommitteeRole }
    const input: Pass0Result = {
      ...validPass0Result,
      briefs: [badBrief, validBrief('technical-evaluator', 'SE'), validBrief('champion', 'Dir')],
    }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects missing required field: why', () => {
    const badBrief = { ...validBrief('executive-sponsor', 'CIO'), why: '' }
    const input: Pass0Result = {
      ...validPass0Result,
      briefs: [badBrief, validBrief('technical-evaluator', 'SE'), validBrief('champion', 'Dir')],
    }
    expect(validatePass0Result(input)).toBeNull()
  })

  it('rejects missing required field: suggestedTitle', () => {
    const badBrief = { ...validBrief('executive-sponsor', ''), suggestedTitle: '' }
    const input: Pass0Result = {
      ...validPass0Result,
      briefs: [badBrief, validBrief('technical-evaluator', 'SE'), validBrief('champion', 'Dir')],
    }
    expect(validatePass0Result(input)).toBeNull()
  })
})

// ── buildPass0Prompt ─────────────────────────────────────────────────────

describe('buildPass0Prompt', () => {
  let buildPass0Prompt: typeof import('../../src/lib/persona-selector.ts').buildPass0Prompt

  beforeEach(async () => {
    const mod = await import('../../src/lib/persona-selector.ts')
    buildPass0Prompt = mod.buildPass0Prompt
  })

  it('returns string with expected sections', () => {
    const prompt = buildPass0Prompt(minimalInput)
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('Campaign Topic')
    expect(prompt).toContain('Test Campaign')
    expect(prompt).toContain('Acme Corp')
    expect(prompt).toContain('Available Feature Keys')
  })

  it('includes intelligence section when provided', () => {
    const prompt = buildPass0Prompt({
      ...minimalInput,
      intelligenceText: '## Executive Summary\nCompany is growing fast.\n## Leadership\nCEO: John Doe',
    })
    expect(prompt).toContain('Customer Intelligence')
    expect(prompt).toContain('Executive Summary')
  })

  it('includes account plan section when provided', () => {
    const prompt = buildPass0Prompt({
      ...minimalInput,
      accountPlanText: '## Key Stakeholders\nCIO: Jane Smith\n## Initiatives\nCloud migration',
    })
    expect(prompt).toContain('Account Plan')
    expect(prompt).toContain('Key Stakeholders')
  })

  it('includes campaign directive when provided', () => {
    const prompt = buildPass0Prompt({
      ...minimalInput,
      campaignDirective: 'Focus on SaaS tax legislation',
    })
    expect(prompt).toContain('Campaign Directive')
    expect(prompt).toContain('SaaS tax legislation')
  })

  it('output is under 20K chars with realistic inputs', () => {
    const prompt = buildPass0Prompt({
      ...minimalInput,
      materialContent: 'A'.repeat(3000),
      intelligenceText: 'B'.repeat(3000),
      accountPlanText: 'C'.repeat(3000),
      campaignDirective: 'Test directive',
      featureKeys: Array.from({ length: 30 }, (_, i) => `feature-${i}`),
    })
    expect(prompt.length).toBeLessThan(20000)
  })
})

// ── PASS0_PERSONA_SELECTION_SCHEMA ───────────────────────────────────────

describe('PASS0_PERSONA_SELECTION_SCHEMA', () => {
  let schema: any

  beforeEach(async () => {
    const mod = await import('../../src/lib/persona-selector.ts')
    schema = mod.PASS0_PERSONA_SELECTION_SCHEMA
  })

  it('has required top-level fields', () => {
    expect(schema.type).toBe('OBJECT')
    const propNames = Object.keys(schema.properties)
    expect(propNames).toContain('selectedRoles')
    expect(propNames).toContain('briefs')
    expect(propNames).toContain('reasoning')
    expect(propNames).toContain('campaignTheme')
  })

  it('briefs items have all PersonaBrief fields', () => {
    const briefProps = schema.properties.briefs.items.properties
    const required = [
      'role', 'suggestedTitle', 'why', 'objectiveMatch',
      'peerProofCandidates', 'timingTrigger', 'valueProposition',
      'featureKeys', 'competitiveContext', 'relationshipPath',
      'installedBase', 'suppressTriggers', 'confidence',
    ]
    for (const field of required) {
      expect(briefProps).toHaveProperty(field)
    }
  })
})

// ── selectPersonas (integration with mock) ────────────────────────────────

describe('selectPersonas', () => {
  it('returns null gracefully when callGemini throws', async () => {
    // Dynamic import to get the module, then test with real callGemini failing
    // The function should catch errors and return null
    const mod = await import('../../src/lib/persona-selector.ts')
    // With no Gemini credentials available in test, this should return null gracefully
    const result = await mod.selectPersonas(minimalInput)
    expect(result).toBeNull()
  })
})
