/**
 * SalesHub Product Enrichment — Unit Tests (GitHub Issue #819)
 *
 * Tests the Gemini-powered enrichment functions for content kits,
 * messaging guides, and battlecards. Mocks callGemini to avoid
 * real API calls.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

// Mock callGemini before importing the module under test
const mockCallGemini = mock(() => Promise.resolve({
  text: '{}',
  cached: false,
  inputTokens: 100,
  outputTokens: 200,
  model: 'gemini-2.0-flash',
}))

// We'll use dynamic import after setting up mocks
import {
  enrichContentKit,
  enrichMessagingGuide,
  enrichBattlecard,
  enrichProductDocuments,
} from '../../src/lib/saleshub-product-enrichment.ts'

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

      // The function parses JSON from callGemini's text response
      const result = await enrichContentKit({
        name: 'AWS Content Kit',
        content: 'This is sample content with https://aws.amazon.com/marketplace/pp/redhat link',
        cloudProvider: 'aws',
      }, () => Promise.resolve({
        text: JSON.stringify(mockResponse),
        cached: false,
        inputTokens: 100,
        outputTokens: 200,
        model: 'gemini-2.0-flash',
      }))

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
      }, () => Promise.resolve({
        text: JSON.stringify(mockResponse),
        cached: false,
        inputTokens: 50,
        outputTokens: 50,
        model: 'gemini-2.0-flash',
      }))

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
      }, () => Promise.resolve({
        text: JSON.stringify(mockResponse),
        cached: false,
        inputTokens: 100,
        outputTokens: 200,
        model: 'gemini-2.0-flash',
      }))

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
      }, () => Promise.resolve({
        text: JSON.stringify(mockResponse),
        cached: false,
        inputTokens: 100,
        outputTokens: 150,
        model: 'gemini-2.0-flash',
      }))

      expect(result).toBeTruthy()
      expect(result!.summary).toContain('battlecard')
      expect(result!.keyPoints).toHaveLength(3)
      expect(result!.links).toHaveLength(1)
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
