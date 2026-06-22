/**
 * SalesHub Product Enrichment — Unit Tests (GitHub Issue #819, #867, #868)
 *
 * Tests the Gemini-powered enrichment functions for content kits,
 * messaging guides, battlecards, case studies, and competitive reviews.
 * Also tests the shared extractWithGemini ceremony and new validators.
 * Mocks callGemini to avoid real API calls.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

import {
  enrichContentKit,
  enrichMessagingGuide,
  enrichBattlecard,
  enrichCaseStudy,
  enrichCompetitiveReview,
  enrichProductDocuments,
  extractWithGemini,
  stripMarkdownFences,
  type ExtractionConfig,
  type GeminiCaller,
} from '../../src/lib/saleshub-product-enrichment.ts'

import {
  caseStudyValidator,
  competitiveReviewValidator,
} from '../../src/quality-validators/product-enrichment-validator.ts'

// ── Helper: mock Gemini response ───────────────────────────────────────────

function mockGeminiResponse(data: any): GeminiCaller {
  return () => Promise.resolve({
    text: JSON.stringify(data),
    cached: false,
    inputTokens: 100,
    outputTokens: 200,
    model: 'gemini-2.0-flash',
  })
}

describe('saleshub-product-enrichment', () => {
  describe('enrichContentKit', () => {
    test('extracts actionable steps with URLs preserved', async () => {
      const mockResponse = {
        actionableSteps: [
          { step: 'Deploy on AWS marketplace', url: 'https://aws.amazon.com/marketplace/pp/redhat' },
          { step: 'Schedule workshop with customer' },
        ],
        calculatorUrl: 'https://redhat.com/calculator/ocp',
        contactName: 'Jane Smith',
        workshops: [{ name: 'Cloud Migration Workshop', url: 'https://redhat.com/workshops/cloud' }],
        demos: [{ name: 'OCP Demo', url: 'https://demo.redhat.com/ocp' }],
        battlecards: [{ name: 'vs VMware', url: 'https://redhat.com/bc/vmware', competitor: 'VMware' }],
        internalMaterials: [{ name: 'Pricing Guide', url: 'https://internal.redhat.com/pricing' }],
        salesPlayAlignment: ['Cloud Migration', 'App Modernization'],
      }

      const result = await enrichContentKit({
        name: 'AWS Content Kit',
        content: 'This is sample content with https://aws.amazon.com/marketplace/pp/redhat link',
        cloudProvider: 'aws',
      }, mockGeminiResponse(mockResponse))

      expect(result).toBeTruthy()
      expect(result!.actionableSteps).toHaveLength(2)
      expect(result!.actionableSteps[0].url).toBe('https://aws.amazon.com/marketplace/pp/redhat')
      expect(result!.calculatorUrl).toBe('https://redhat.com/calculator/ocp')
      expect(result!.contactName).toBe('Jane Smith')
      expect(result!.workshops).toHaveLength(1)
      expect(result!.demos).toHaveLength(1)
      expect(result!.battlecards).toHaveLength(1)
      expect(result!.salesPlayAlignment).toEqual(['Cloud Migration', 'App Modernization'])
    })

    test('returns null fields when content has no matching data', async () => {
      const mockResponse = {
        actionableSteps: [],
        calculatorUrl: null,
        contactName: null,
        workshops: [],
        demos: [],
        battlecards: [],
        internalMaterials: [],
        salesPlayAlignment: [],
      }

      const result = await enrichContentKit({
        name: 'Empty Content Kit',
        content: 'No useful content here',
        cloudProvider: 'azure',
      }, mockGeminiResponse(mockResponse))

      expect(result).toBeTruthy()
      expect(result!.actionableSteps).toEqual([])
      expect(result!.calculatorUrl).toBeNull()
      expect(result!.contactName).toBeNull()
      expect(result!.workshops).toEqual([])
      expect(result!.demos).toEqual([])
    })

    test('returns null on Gemini failure', async () => {
      const result = await enrichContentKit({
        name: 'Bad Content Kit',
        content: 'content',
        cloudProvider: 'aws',
      }, () => Promise.reject(new Error('Gemini API error')))

      expect(result).toBeNull()
    })

    test('returns null on invalid JSON response', async () => {
      const result = await enrichContentKit({
        name: 'Bad JSON Kit',
        content: 'content',
        cloudProvider: 'aws',
      }, () => Promise.resolve({
        text: 'not valid json at all',
        cached: false,
        inputTokens: 50,
        outputTokens: 50,
        model: 'gemini-2.0-flash',
      }))

      expect(result).toBeNull()
    })
  })

  describe('enrichMessagingGuide', () => {
    test('extracts summary, key points, talk tracks, and links', async () => {
      const mockResponse = {
        summary: 'OpenShift Virtualization messaging guide for enterprise migration',
        keyPoints: ['Cost savings vs VMware', 'Hybrid cloud flexibility', 'Kubernetes-native VMs'],
        talkTracks: ['Start with the VMware renewal conversation', 'Focus on TCO reduction'],
        links: [
          { name: 'TCO Calculator', url: 'https://redhat.com/tco' },
          { name: 'Migration Guide', url: 'https://redhat.com/migrate' },
        ],
      }

      const result = await enrichMessagingGuide({
        name: 'OCP-V Messaging Guide',
        content: 'Messaging guide content here',
      }, mockGeminiResponse(mockResponse))

      expect(result).toBeTruthy()
      expect(result!.summary).toContain('messaging guide')
      expect(result!.keyPoints).toHaveLength(3)
      expect(result!.talkTracks).toHaveLength(2)
      expect(result!.links).toHaveLength(2)
      expect(result!.links[0].url).toBe('https://redhat.com/tco')
    })
  })

  describe('enrichBattlecard', () => {
    test('extracts competitive angles and links', async () => {
      const mockResponse = {
        summary: 'VMware competitive battlecard',
        keyPoints: ['Lower TCO', 'No per-socket licensing', 'Kubernetes-native'],
        links: [
          { name: 'Competitive Matrix', url: 'https://redhat.com/compete/vmware' },
        ],
      }

      const result = await enrichBattlecard({
        name: 'VMware Battlecard',
        content: 'Competitive analysis content',
      }, mockGeminiResponse(mockResponse))

      expect(result).toBeTruthy()
      expect(result!.summary).toContain('battlecard')
      expect(result!.keyPoints).toHaveLength(3)
      expect(result!.links).toHaveLength(1)
    })
  })

  describe('enrichCaseStudy', () => {
    test('extracts customer success data', async () => {
      const mockResponse = {
        customerName: 'Acme Corp',
        industry: 'Manufacturing',
        challenge: 'Legacy infrastructure slowing digital transformation',
        solution: 'Deployed Red Hat OpenShift for container orchestration',
        results: ['50% faster deployments', '30% reduction in infrastructure costs'],
        productsUsed: ['OpenShift', 'RHEL'],
        keyPoints: ['Container adoption accelerated', 'Hybrid cloud enabled'],
        links: [{ name: 'Full Case Study', url: 'https://redhat.com/case/acme' }],
      }

      const result = await enrichCaseStudy({
        name: 'Acme Corp Case Study',
        content: 'Case study content here',
      }, mockGeminiResponse(mockResponse))

      expect(result).toBeTruthy()
      expect(result!.customerName).toBe('Acme Corp')
      expect(result!.industry).toBe('Manufacturing')
      expect(result!.challenge).toContain('Legacy')
      expect(result!.solution).toContain('OpenShift')
      expect(result!.results).toHaveLength(2)
      expect(result!.productsUsed).toContain('OpenShift')
    })

    test('returns null on Gemini failure', async () => {
      const result = await enrichCaseStudy({
        name: 'Bad Case Study',
        content: 'content',
      }, () => Promise.reject(new Error('Gemini API error')))

      expect(result).toBeNull()
    })
  })

  describe('enrichCompetitiveReview', () => {
    test('extracts competitive positioning', async () => {
      const mockResponse = {
        competitor: 'VMware',
        keyDifferentiators: ['No per-socket licensing', 'Kubernetes-native'],
        competitorWeaknesses: ['High licensing costs', 'Vendor lock-in'],
        talkTracks: ['Lead with TCO comparison'],
        keyPoints: ['Focus on open source advantage'],
        links: [{ name: 'Comparison Guide', url: 'https://redhat.com/compare/vmware' }],
      }

      const result = await enrichCompetitiveReview({
        name: 'VMware Competitive Review',
        content: 'Competitive review content here',
      }, mockGeminiResponse(mockResponse))

      expect(result).toBeTruthy()
      expect(result!.competitor).toBe('VMware')
      expect(result!.keyDifferentiators).toHaveLength(2)
      expect(result!.competitorWeaknesses).toHaveLength(2)
      expect(result!.talkTracks).toHaveLength(1)
    })

    test('returns null on Gemini failure', async () => {
      const result = await enrichCompetitiveReview({
        name: 'Bad Review',
        content: 'content',
      }, () => Promise.reject(new Error('Gemini API error')))

      expect(result).toBeNull()
    })
  })

  describe('enrichProductDocuments', () => {
    test('routes documents to correct enrichment functions', async () => {
      const geminiResponses: Record<string, string> = {
        'content-kit': JSON.stringify({
          actionableSteps: [{ step: 'Step 1' }],
          calculatorUrl: null,
          contactName: null,
          workshops: [],
          demos: [],
          battlecards: [],
          internalMaterials: [],
          salesPlayAlignment: [],
        }),
        'messaging-guide': JSON.stringify({
          summary: 'Guide summary',
          keyPoints: ['Point 1'],
          links: [],
        }),
        'battlecard': JSON.stringify({
          summary: 'Battlecard summary',
          keyPoints: ['Competitive angle'],
          links: [],
        }),
      }

      let callCount = 0
      const mockGemini = (type: string) => () => {
        callCount++
        return Promise.resolve({
          text: geminiResponses[type] ?? '{}',
          cached: false,
          inputTokens: 50,
          outputTokens: 100,
          model: 'gemini-2.0-flash',
        })
      }

      const result = await enrichProductDocuments('red-hat-openshift', [
        { name: 'AWS Kit', content: 'aws content', type: 'content-kit', cloudProvider: 'aws' },
        { name: 'Messaging Guide', content: 'messaging content', type: 'messaging-guide' },
        { name: 'VMware BC', content: 'battlecard content', type: 'battlecard' },
      ], mockGemini)

      expect(result.productSlug).toBe('red-hat-openshift')
      expect(result.contentKits).toHaveLength(1)
      expect(result.messagingGuides).toHaveLength(1)
      expect(result.battlecards).toHaveLength(1)
    })

    test('handles empty document list', async () => {
      const result = await enrichProductDocuments('test-product', [], () => () =>
        Promise.resolve({
          text: '{}',
          cached: false,
          inputTokens: 0,
          outputTokens: 0,
          model: 'gemini-2.0-flash',
        })
      )

      expect(result.productSlug).toBe('test-product')
      expect(result.contentKits).toEqual([])
      expect(result.messagingGuides).toEqual([])
      expect(result.battlecards).toEqual([])
    })
  })
})

// ── extractWithGemini tests (#867) ─────────────────────────────────────────

describe('extractWithGemini', () => {
  test('calls gemini with system prompt, user prompt, and opts', async () => {
    let capturedSystem = ''
    let capturedUser = ''
    let capturedOpts: any = null

    const config: ExtractionConfig<{ value: string }> = {
      systemPrompt: 'Test system prompt',
      userPromptFn: (name, content) => `Extract from "${name}": ${content}`,
      callType: 'test-extraction',
      parseResult: (raw) => ({ value: raw.v ?? 'default' }),
    }

    const mockGemini: GeminiCaller = (system, user, opts) => {
      capturedSystem = system
      capturedUser = user
      capturedOpts = opts
      return Promise.resolve({
        text: JSON.stringify({ v: 'hello' }),
        cached: false,
        inputTokens: 10,
        outputTokens: 20,
        model: 'gemini-2.0-flash',
      })
    }

    const result = await extractWithGemini(config, 'TestDoc', 'test content', mockGemini)

    expect(result).toEqual({ value: 'hello' })
    expect(capturedSystem).toBe('Test system prompt')
    expect(capturedUser).toContain('Extract from "TestDoc"')
    expect(capturedOpts.callType).toBe('test-extraction')
    expect(capturedOpts.deltaKey).toBe('saleshub-enrich-test-extraction-TestDoc')
  })

  test('returns null on Gemini failure', async () => {
    const config: ExtractionConfig<{ v: string }> = {
      systemPrompt: 'sys',
      userPromptFn: (_n, c) => c,
      callType: 'test',
      parseResult: (raw) => ({ v: raw.v }),
    }

    const result = await extractWithGemini(
      config, 'doc', 'content',
      () => Promise.reject(new Error('boom')),
    )

    expect(result).toBeNull()
  })

  test('returns null on invalid JSON response', async () => {
    const config: ExtractionConfig<{ v: string }> = {
      systemPrompt: 'sys',
      userPromptFn: (_n, c) => c,
      callType: 'test',
      parseResult: (raw) => ({ v: raw.v }),
    }

    const result = await extractWithGemini(
      config, 'doc', 'content',
      () => Promise.resolve({ text: 'not json', cached: false, inputTokens: 0, outputTokens: 0, model: 'x' }),
    )

    expect(result).toBeNull()
  })

  test('passes fallbacks to parseResult', async () => {
    const config: ExtractionConfig<{ name: string; fallbackVal: string }> = {
      systemPrompt: 'sys',
      userPromptFn: (_n, c) => c,
      callType: 'test',
      parseResult: (raw, _docName, fallbacks) => ({
        name: raw.name ?? '',
        fallbackVal: fallbacks?.myFallback ?? 'none',
      }),
    }

    const result = await extractWithGemini(
      config, 'doc', 'content',
      mockGeminiResponse({ name: 'test' }),
      { myFallback: 'provided' },
    )

    expect(result).toEqual({ name: 'test', fallbackVal: 'provided' })
  })
})

// ── stripMarkdownFences tests (#867) ───────────────────────────────────────

describe('stripMarkdownFences', () => {
  test('strips ```json wrapper', () => {
    const input = '```json\n{"key": "value"}\n```'
    expect(stripMarkdownFences(input)).toBe('{"key": "value"}')
  })

  test('strips bare ``` wrapper', () => {
    const input = '```\n{"key": "value"}\n```'
    expect(stripMarkdownFences(input)).toBe('{"key": "value"}')
  })

  test('passes through bare JSON unchanged', () => {
    const input = '{"key": "value"}'
    expect(stripMarkdownFences(input)).toBe('{"key": "value"}')
  })

  test('handles ```json with extra whitespace', () => {
    const input = '```json  \n  {"key": "value"}  \n  ```'
    expect(stripMarkdownFences(input)).toBe('{"key": "value"}')
  })

  test('handles empty string', () => {
    expect(stripMarkdownFences('')).toBe('')
  })
})

// ── deltaKey caching tests ─────────────────────────────────────────────────

describe('deltaKey caching', () => {
  test('enrichContentKit passes deltaKey to gemini caller', async () => {
    let receivedOpts: any = null
    await enrichContentKit({
      name: 'AWS Content Kit',
      content: 'sample content',
      cloudProvider: 'aws',
    }, (_system, _user, opts) => {
      receivedOpts = opts
      return Promise.resolve({
        text: JSON.stringify({ actionableSteps: [], calculatorUrl: null, contactName: null, workshops: [], demos: [], battlecards: [], internalMaterials: [], salesPlayAlignment: [] }),
        cached: false, inputTokens: 50, outputTokens: 50, model: 'gemini-2.0-flash',
      })
    })
    expect(receivedOpts).toBeTruthy()
    expect(receivedOpts.deltaKey).toBe('saleshub-enrich-content-kit-extraction-AWS Content Kit')
  })

  test('enrichMessagingGuide passes deltaKey to gemini caller', async () => {
    let receivedOpts: any = null
    await enrichMessagingGuide({
      name: 'OCP-V Guide',
      content: 'messaging content',
    }, (_system, _user, opts) => {
      receivedOpts = opts
      return Promise.resolve({
        text: JSON.stringify({ summary: 'test', keyPoints: ['p1'], talkTracks: [], links: [] }),
        cached: false, inputTokens: 50, outputTokens: 50, model: 'gemini-2.0-flash',
      })
    })
    expect(receivedOpts).toBeTruthy()
    expect(receivedOpts.deltaKey).toBe('saleshub-enrich-messaging-guide-extraction-OCP-V Guide')
  })

  test('enrichBattlecard passes deltaKey to gemini caller', async () => {
    let receivedOpts: any = null
    await enrichBattlecard({
      name: 'VMware BC',
      content: 'battlecard content',
    }, (_system, _user, opts) => {
      receivedOpts = opts
      return Promise.resolve({
        text: JSON.stringify({ summary: 'test', keyPoints: ['angle'], links: [] }),
        cached: false, inputTokens: 50, outputTokens: 50, model: 'gemini-2.0-flash',
      })
    })
    expect(receivedOpts).toBeTruthy()
    expect(receivedOpts.deltaKey).toBe('saleshub-enrich-battlecard-extraction-VMware BC')
  })

  test('enrichProductDocuments passes deltaKey through geminiFactory', async () => {
    const receivedKeys: string[] = []
    const mockGemini = (_type: string) => (_system: string, _user: string, opts: any) => {
      if (opts?.deltaKey) receivedKeys.push(opts.deltaKey)
      return Promise.resolve({
        text: JSON.stringify({ actionableSteps: [{ step: 'Step 1' }], calculatorUrl: null, contactName: null, workshops: [], demos: [], battlecards: [], internalMaterials: [], salesPlayAlignment: [] }),
        cached: false, inputTokens: 50, outputTokens: 100, model: 'gemini-2.0-flash',
      })
    }
    await enrichProductDocuments('test-product', [
      { name: 'Doc A', content: 'content a', type: 'content-kit', cloudProvider: 'aws' },
      { name: 'Doc B', content: 'content b', type: 'messaging-guide' },
    ], mockGemini)
    expect(receivedKeys).toContain('saleshub-enrich-content-kit-extraction-Doc A')
    expect(receivedKeys).toContain('saleshub-enrich-messaging-guide-extraction-Doc B')
  })
})

// ── Validator tests (#868) ─────────────────────────────────────────────────

describe('caseStudyValidator', () => {
  test('passes valid case study', () => {
    const input = JSON.stringify({
      customerName: 'Acme Corp',
      challenge: 'Legacy infrastructure problems',
      solution: 'Deployed OpenShift',
      results: ['50% faster deployments'],
    })
    const scorecard = caseStudyValidator.validate(input)
    expect(scorecard.passed).toBe(true)
    expect(scorecard.checks.every(c => c.passed)).toBe(true)
  })

  test('fails missing customerName', () => {
    const input = JSON.stringify({
      customerName: '',
      challenge: 'Some challenge',
      solution: 'Some solution',
      results: ['A result'],
    })
    const scorecard = caseStudyValidator.validate(input)
    const customerCheck = scorecard.checks.find(c => c.name === 'has-customer-name')
    expect(customerCheck?.passed).toBe(false)
  })

  test('fails empty results array', () => {
    const input = JSON.stringify({
      customerName: 'Acme',
      challenge: 'Challenge text',
      solution: 'Solution text',
      results: [],
    })
    const scorecard = caseStudyValidator.validate(input)
    const resultsCheck = scorecard.checks.find(c => c.name === 'has-results')
    expect(resultsCheck?.passed).toBe(false)
  })

  test('fails invalid JSON', () => {
    const scorecard = caseStudyValidator.validate('not json')
    expect(scorecard.passed).toBe(false)
    expect(scorecard.checks[0].name).toBe('valid-json')
    expect(scorecard.checks[0].passed).toBe(false)
  })

  test('fails missing challenge', () => {
    const input = JSON.stringify({
      customerName: 'Acme',
      challenge: '',
      solution: 'Deployed OCP',
      results: ['Improved speed'],
    })
    const scorecard = caseStudyValidator.validate(input)
    const check = scorecard.checks.find(c => c.name === 'has-challenge')
    expect(check?.passed).toBe(false)
  })

  test('fails missing solution', () => {
    const input = JSON.stringify({
      customerName: 'Acme',
      challenge: 'Legacy infra',
      solution: '',
      results: ['Improved speed'],
    })
    const scorecard = caseStudyValidator.validate(input)
    const check = scorecard.checks.find(c => c.name === 'has-solution')
    expect(check?.passed).toBe(false)
  })
})

describe('competitiveReviewValidator', () => {
  test('passes valid competitive review', () => {
    const input = JSON.stringify({
      competitor: 'VMware',
      keyDifferentiators: ['No per-socket licensing'],
    })
    const scorecard = competitiveReviewValidator.validate(input)
    expect(scorecard.passed).toBe(true)
    expect(scorecard.checks.every(c => c.passed)).toBe(true)
  })

  test('fails missing competitor', () => {
    const input = JSON.stringify({
      competitor: '',
      keyDifferentiators: ['Lower cost'],
    })
    const scorecard = competitiveReviewValidator.validate(input)
    const check = scorecard.checks.find(c => c.name === 'has-competitor')
    expect(check?.passed).toBe(false)
  })

  test('fails empty keyDifferentiators', () => {
    const input = JSON.stringify({
      competitor: 'VMware',
      keyDifferentiators: [],
    })
    const scorecard = competitiveReviewValidator.validate(input)
    const check = scorecard.checks.find(c => c.name === 'has-differentiators')
    expect(check?.passed).toBe(false)
  })

  test('fails invalid JSON', () => {
    const scorecard = competitiveReviewValidator.validate('not json')
    expect(scorecard.passed).toBe(false)
    expect(scorecard.checks[0].name).toBe('valid-json')
    expect(scorecard.checks[0].passed).toBe(false)
  })
})
