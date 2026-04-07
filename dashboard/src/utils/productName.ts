import type { AccountInfo } from '../types'

/**
 * Strip "Red Hat " prefix + everything after first comma (packaging qualifiers).
 * "Red Hat Ansible Automation Platform, Standard (100 Managed Nodes)" -> "Ansible Automation Platform"
 * "Red Hat Enterprise Linux Extended Life Cycle Support (Physical or Virtual Nodes)" -> "Enterprise Linux Extended Life Cycle Support"
 */
export function stripProductName(raw: string): string {
  let name = raw.trim()
  // Remove "Red Hat " prefix (case-insensitive)
  if (name.toLowerCase().startsWith('red hat ')) {
    name = name.slice(8)
  }
  // Strip everything after first comma
  const commaIdx = name.indexOf(',')
  if (commaIdx > 0) {
    name = name.slice(0, commaIdx).trim()
  }
  return name
}

/**
 * Collect all unique stripped product names from an account's subscription rows.
 */
export function extractProductNames(account: AccountInfo): string[] {
  if (!account.products || account.products.length === 0) return []
  const seen = new Set<string>()
  for (const p of account.products) {
    if (p.productDescription) {
      seen.add(stripProductName(p.productDescription))
    }
  }
  return [...seen].sort()
}

/**
 * Normalize a raw (already-stripped) product name to a short display chip label.
 * First match wins, case-insensitive.
 */
export function normalizeProductName(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('beta')) return 'Beta'
  if (lower.includes('free')) return 'Free'
  if (lower.includes('trial')) return 'Trial'
  if (lower.includes('ansible')) return 'AAP'
  if (lower.includes('storage')) return 'Storage'
  if (lower.includes('openshift')) return 'OCP'
  if (lower.includes('enterprise linux')) return 'RHEL'
  if (lower.includes('satellite')) return 'RHEL'
  if (/\bruntimes\b/.test(lower) || /\bintegration\b/.test(lower)) return 'Middleware'
  if (lower.includes('partner')) return 'Partner Subscriptions'
  if (lower.includes('developer subscription')) return 'Developer Subscriptions'
  return raw
}

/**
 * Return all unique normalized product labels across all accounts, sorted alphabetically.
 */
export function discoverAllProducts(accounts: AccountInfo[]): string[] {
  const labels = new Set<string>()
  for (const account of accounts) {
    if (!account.products) continue
    for (const p of account.products) {
      if (!p.productDescription) continue
      labels.add(normalizeProductName(stripProductName(p.productDescription)))
    }
  }
  return [...labels].sort()
}

/**
 * Return raw product names that map to a given normalized label.
 * Useful for tooltip transparency (LOG-03).
 */
export function getProductGroupMembers(label: string, allRawProducts: string[]): string[] {
  return allRawProducts.filter(raw => normalizeProductName(stripProductName(raw)) === label)
}
