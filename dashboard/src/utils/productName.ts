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
 * Return all unique product names across all accounts, sorted by frequency desc.
 */
export function discoverAllProducts(accounts: AccountInfo[]): string[] {
  const freq = new Map<string, number>()
  for (const account of accounts) {
    if (!account.products) continue
    for (const p of account.products) {
      if (!p.productDescription) continue
      const name = stripProductName(p.productDescription)
      freq.set(name, (freq.get(name) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
}
