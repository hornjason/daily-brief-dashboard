import { describe, it, expect } from 'bun:test'
import { isValidCustomerWin, isValidAsset } from '../../src/lib/saleshub-filters'

describe('isValidCustomerWin', () => {
  it('rejects template text: "Real customer stories..."', () => {
    expect(isValidCustomerWin(
      'Real customer stories and proven outcomes you can reference to build trust and momentum.'
    )).toBe(false)
  })

  it('rejects "0 item(s) selected"', () => {
    expect(isValidCustomerWin('0 item(s) selected')).toBe(false)
  })

  it('rejects "Displaying slide 1 of 1"', () => {
    expect(isValidCustomerWin('Displaying slide 1 of 1')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidCustomerWin('')).toBe(false)
  })

  it('rejects whitespace-only string', () => {
    expect(isValidCustomerWin('   ')).toBe(false)
  })

  it('accepts real customer win: HMRC', () => {
    expect(isValidCustomerWin(
      "His Majesty's Revenue and Customs (HMRC) move to the cloud with Red Hat Enterprise Linux"
    )).toBe(true)
  })

  it('accepts real customer win: Telstra', () => {
    expect(isValidCustomerWin(
      'Telstra opts for RHEL over CentOS Linux for its cloud journey'
    )).toBe(true)
  })

  it('accepts real customer win: AI value', () => {
    expect(isValidCustomerWin(
      'Unlock AI value in IT operations with Red Hat Ansible Automation Platform'
    )).toBe(true)
  })

  it('accepts real customer win: GTM Power Hour', () => {
    expect(isValidCustomerWin(
      'GTM Power Hour (Red Hat AI starts at 32:25)'
    )).toBe(true)
  })

  it('accepts real customer win: Red Hat AI Customer References', () => {
    expect(isValidCustomerWin('Red Hat AI Customer References')).toBe(true)
  })

  it('accepts case studies reference', () => {
    expect(isValidCustomerWin(
      'Select case studies from interactive customer references dashboard'
    )).toBe(true)
  })
})

describe('isValidAsset', () => {
  it('rejects empty URL', () => {
    expect(isValidAsset({ name: 'Customer pitch', url: '' })).toBe(false)
  })

  it('rejects javascript:void(0) URL', () => {
    expect(isValidAsset({
      name: 'What to show → differentiate with product demos',
      url: 'javascript:void(0)'
    })).toBe(false)
  })

  it('rejects section header with arrow', () => {
    expect(isValidAsset({
      name: 'What to show → differentiate with product demos',
      url: 'https://example.com'
    })).toBe(false)
  })

  it('rejects "What to show" prefix even without arrow', () => {
    expect(isValidAsset({
      name: 'What to show customers',
      url: 'https://example.com'
    })).toBe(false)
  })

  it('rejects "0 item(s) selected"', () => {
    expect(isValidAsset({ name: '0 item(s) selected', url: 'https://example.com' })).toBe(false)
  })

  it('rejects "Displaying slide 1 of 1" name', () => {
    expect(isValidAsset({ name: 'Displaying slide 1 of 1', url: 'https://example.com' })).toBe(false)
  })

  it('rejects null asset', () => {
    expect(isValidAsset(null as any)).toBe(false)
  })

  it('accepts valid Google Slides asset', () => {
    expect(isValidAsset({
      name: 'AIOps - CY\'26 Customer Pitch Video',
      url: 'https://docs.google.com/presentation/d/abc123'
    })).toBe(true)
  })

  it('accepts valid Seismic asset with real URL', () => {
    expect(isValidAsset({
      name: 'Red Hat AI Customer Pitch',
      url: 'https://redhat.seismic.com/Link/Content/abc'
    })).toBe(true)
  })

  it('accepts valid external link', () => {
    expect(isValidAsset({
      name: 'Product Demo Environment',
      url: 'https://demo.redhat.com/catalog'
    })).toBe(true)
  })
})
