import { describe, test, expect, beforeAll } from 'bun:test'
import type { Customer } from '../../src/types.ts'

/**
 * Regression tests for GitHub issue #95:
 * Calendar events should match on significant words from customer name,
 * not just full name or aliases.
 *
 * Example: "Continental call" should match "Continental Broadband"
 *
 * Strategy: We'll test against the refactored matching function once extracted.
 * For now, this test documents the expected behavior.
 */

// We'll import this once the function is extracted
let matchesCustomerCalendarEvent: (
  eventTitle: string,
  eventDescription: string,
  attendeeEmails: string[],
  customer: Customer
) => boolean

describe('Calendar partial name matching (issue #95)', () => {
  beforeAll(async () => {
    // Dynamic import after the function is extracted
    const mod = await import('../../src/customer.ts')
    matchesCustomerCalendarEvent = mod.matchesCustomerCalendarEvent
  })

  test('full name match — existing behavior', () => {
    const customer: Customer = {
      name: 'Continental Broadband',
      domain: 'continental.net',
      aliases: [],
      accountNumber: '123',
    }

    const result = matchesCustomerCalendarEvent(
      'Continental Broadband quarterly review',
      '',
      [],
      customer
    )
    expect(result).toBe(true)
  })

  test('partial name match — NEW — significant word from customer name', () => {
    const customer: Customer = {
      name: 'Continental Broadband',
      domain: 'continental.net',
      aliases: [],
      accountNumber: '123',
    }

    const result = matchesCustomerCalendarEvent(
      'Continental call',
      '',
      [],
      customer
    )
    expect(result).toBe(true) // This WILL FAIL initially
  })

  test('alias match — existing behavior still works', () => {
    const customer: Customer = {
      name: 'Continental Broadband',
      domain: 'continental.net',
      aliases: ['CBB'],
      accountNumber: '123',
    }

    const result = matchesCustomerCalendarEvent(
      'CBB internal sync',
      '',
      [],
      customer
    )
    expect(result).toBe(true)
  })

  test('suffix-only match — does NOT match (prevents false positives)', () => {
    const customer: Customer = {
      name: 'Acme Corporation',
      domain: 'acme.com',
      aliases: [],
      accountNumber: '456',
    }

    const result = matchesCustomerCalendarEvent(
      'Corporation tax planning',
      '',
      [],
      customer
    )
    expect(result).toBe(false)
  })

  test('short word — does NOT match (prevents false positives)', () => {
    const customer: Customer = {
      name: 'Al Corp',
      domain: 'alcorp.com',
      aliases: [],
      accountNumber: '789',
    }

    const result = matchesCustomerCalendarEvent(
      'Al Smith personal meeting',
      '',
      [],
      customer
    )
    expect(result).toBe(false)
  })

  test('domain match — existing behavior still works', () => {
    const customer: Customer = {
      name: 'Continental Broadband',
      domain: 'continental.net',
      aliases: [],
      accountNumber: '123',
    }

    const result = matchesCustomerCalendarEvent(
      'Random meeting title',
      '',
      ['john@continental.net'],
      customer
    )
    expect(result).toBe(true)
  })

  test('description match with partial word', () => {
    const customer: Customer = {
      name: 'Continental Broadband',
      domain: 'continental.net',
      aliases: [],
      accountNumber: '123',
    }

    const result = matchesCustomerCalendarEvent(
      'Weekly sync',
      'Discussion about Continental outage',
      [],
      customer
    )
    expect(result).toBe(true)
  })

  test('multi-word customer name — matches any significant word', () => {
    const customer: Customer = {
      name: 'Big Ten Network Services',
      domain: 'btn.com',
      aliases: [],
      accountNumber: '999',
    }

    const result = matchesCustomerCalendarEvent(
      'Big Ten planning call',
      '',
      [],
      customer
    )
    expect(result).toBe(true)
  })

  test('common suffix excluded — "Services" alone does NOT match', () => {
    const customer: Customer = {
      name: 'Acme Services Inc',
      domain: 'acme.com',
      aliases: [],
      accountNumber: '111',
    }

    const result = matchesCustomerCalendarEvent(
      'IT Services review',
      '',
      [],
      customer
    )
    expect(result).toBe(false)
  })

  test('case insensitivity preserved', () => {
    const customer: Customer = {
      name: 'Continental Broadband',
      domain: 'continental.net',
      aliases: [],
      accountNumber: '123',
    }

    const result = matchesCustomerCalendarEvent(
      'CONTINENTAL DISCUSSION',
      '',
      [],
      customer
    )
    expect(result).toBe(true)
  })
})
