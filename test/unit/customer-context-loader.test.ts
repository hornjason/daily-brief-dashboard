/**
 * Unit tests for customer-context-loader.ts
 * GitHub Issues #475, #486 — Customer-specific filtering for portfolio modules
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

// Set CACHE_DIR before importing the module
const TEST_CACHE_DIR = resolve(import.meta.dir, '../../test-cache-ccl')
process.env.CACHE_DIR = TEST_CACHE_DIR

import {
  loadCustomerContext,
  matchesTechStack,
  matchesSubscriptionProducts,
} from '../../src/lib/customer-context-loader.ts'

beforeAll(() => {
  // Create test cache structure
  mkdirSync(resolve(TEST_CACHE_DIR, 'tech-stack'), { recursive: true })

  // Tech-stack cache for test customer
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'tech-stack', 'acme-corp.json'),
    JSON.stringify({
      technologies: [
        { name: 'VMware', category: 'Virtualization', confidence: 'HIGH' },
        { name: 'Kubernetes', category: 'Container Orchestration', confidence: 'MEDIUM' },
        { name: 'Docker', category: 'Containers', confidence: 'HIGH' },
        { name: 'AWS', category: 'Cloud', confidence: 'HIGH' },
      ],
    })
  )

  // Subscription sheets cache for test customer
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'acme-corp-sheets.json'),
    JSON.stringify({
      rows: [
        { productDescription: 'Red Hat Enterprise Linux Server' },
        { productDescription: 'Red Hat OpenShift Container Platform' },
        { productDescription: 'Red Hat Ansible Automation Platform' },
      ],
    })
  )

  // Customer with no tech stack (just sheets)
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'partial-customer-sheets.json'),
    JSON.stringify({
      rows: [
        { productDescription: 'Red Hat Enterprise Linux' },
      ],
    })
  )
})

afterAll(() => {
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
  }
})

describe('loadCustomerContext', () => {
  test('loads tech stack and subscription products', () => {
    const ctx = loadCustomerContext('acme-corp')
    expect(ctx.techs).toContain('vmware')
    expect(ctx.techs).toContain('kubernetes')
    expect(ctx.techs).toContain('docker')
    expect(ctx.techs).toContain('aws')
    expect(ctx.techs.length).toBe(4)

    expect(ctx.products).toContain('red hat enterprise linux server')
    expect(ctx.products).toContain('red hat openshift container platform')
    expect(ctx.products).toContain('red hat ansible automation platform')
    expect(ctx.products.length).toBe(3)
  })

  test('returns empty arrays for unknown customer', () => {
    const ctx = loadCustomerContext('nonexistent-customer')
    expect(ctx.techs).toEqual([])
    expect(ctx.products).toEqual([])
  })

  test('handles partial context (no tech stack)', () => {
    const ctx = loadCustomerContext('partial-customer')
    expect(ctx.techs).toEqual([])
    expect(ctx.products.length).toBe(1)
    expect(ctx.products).toContain('red hat enterprise linux')
  })
})

describe('matchesTechStack', () => {
  test('matches platform against customer techs (case-insensitive)', () => {
    const techs = ['vmware', 'kubernetes', 'docker']
    expect(matchesTechStack(['VMware'], techs)).toBe(true)
    expect(matchesTechStack(['vmware'], techs)).toBe(true)
  })

  test('matches by substring - tech contains target', () => {
    const techs = ['vmware vsphere', 'kubernetes']
    expect(matchesTechStack(['vmware'], techs)).toBe(true)
  })

  test('matches by substring - target contains tech', () => {
    const techs = ['docker']
    expect(matchesTechStack(['Docker Enterprise Edition'], techs)).toBe(true)
  })

  test('returns false when no match', () => {
    const techs = ['vmware', 'kubernetes']
    expect(matchesTechStack(['Citrix'], techs)).toBe(false)
  })

  test('returns false with empty techs', () => {
    expect(matchesTechStack(['VMware'], [])).toBe(false)
  })

  test('returns false with empty targets', () => {
    expect(matchesTechStack([], ['vmware'])).toBe(false)
  })

  test('matches categories against techs', () => {
    const techs = ['vmware', 'kubernetes', 'aws']
    expect(matchesTechStack(['Cloud', 'Virtualization', 'Container Management'], techs)).toBe(false)
    expect(matchesTechStack(['VMware', 'Cloud'], techs)).toBe(true) // VMware matches
  })
})

describe('matchesSubscriptionProducts', () => {
  test('matches product field against subscription descriptions', () => {
    const products = ['red hat enterprise linux server', 'red hat openshift container platform']
    expect(matchesSubscriptionProducts(['RHEL'], products)).toBe(false) // RHEL is not a substring
    expect(matchesSubscriptionProducts(['enterprise linux'], products)).toBe(true)
    expect(matchesSubscriptionProducts(['openshift'], products)).toBe(true)
  })

  test('matches tdp field against subscriptions', () => {
    const products = ['red hat ansible automation platform']
    expect(matchesSubscriptionProducts(['Ansible'], products)).toBe(true)
  })

  test('returns false when no match', () => {
    const products = ['red hat enterprise linux']
    expect(matchesSubscriptionProducts(['Satellite'], products)).toBe(false)
  })

  test('returns false with empty products', () => {
    expect(matchesSubscriptionProducts(['RHEL'], [])).toBe(false)
  })

  test('returns false with empty targets', () => {
    expect(matchesSubscriptionProducts([], ['red hat enterprise linux'])).toBe(false)
  })
})
