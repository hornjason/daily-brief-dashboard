/**
 * src/lib/material-index.ts — Material resolution (#575)
 * Deep module: resolve(signalKey) → MaterialLink[]
 * Maps product names, TDP names, technology keywords to SalesHub material URLs.
 */

import { getTdpByName, getAssetsByPlay } from './saleshub-knowledge-loader.ts'

export interface MaterialLink {
  title: string
  url: string
  type: 'cheatsheet' | 'deck' | 'lab' | 'demo' | 'doc' | 'service'
}

const KEYWORD_TO_TDP: Record<string, string> = {
  'ansible': 'Automation',
  'automation': 'Automation',
  'aap': 'Automation',
  'openshift': 'Container Mgmt',
  'container': 'Container Mgmt',
  'kubernetes': 'Container Mgmt',
  'ocp': 'Container Mgmt',
  'rhel': 'Server/Cloud OS',
  'enterprise linux': 'Server/Cloud OS',
  'server': 'Server/Cloud OS',
  'satellite': 'Management',
  'management': 'Management',
  'virtualization': 'Virtualization',
  'virt': 'Virtualization',
  'ai': 'AI',
  'rhoai': 'AI',
  'openshift ai': 'AI',
}

function inferTdp(key: string): string | null {
  const lower = key.toLowerCase()
  for (const [keyword, tdp] of Object.entries(KEYWORD_TO_TDP)) {
    if (lower.includes(keyword)) return tdp
  }
  return null
}

function resolveSaleshubUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('https://') || url.startsWith('http://')) return url
  if (url.startsWith('/apps/')) return `https://saleshub.redhat.com${url}`
  return undefined
}

export function resolve(signalKey: string): MaterialLink[] {
  // Try direct TDP name match first
  let tdp = getTdpByName(signalKey)

  // Try keyword inference
  if (!tdp) {
    const tdpName = inferTdp(signalKey)
    if (tdpName) tdp = getTdpByName(tdpName)
  }

  if (!tdp) return []

  const materials: MaterialLink[] = []

  // Cheatsheet
  const cheatUrl = resolveSaleshubUrl(tdp.cheatsheetUrl)
  if (cheatUrl) {
    materials.push({ title: `${tdp.name} Cheat Sheet`, url: cheatUrl, type: 'cheatsheet' })
  }

  // Customer deck
  const deckUrl = resolveSaleshubUrl(tdp.customerDeckUrl)
  if (deckUrl && deckUrl !== cheatUrl) {
    materials.push({ title: `${tdp.name} Customer Deck`, url: deckUrl, type: 'deck' })
  }

  // whatToShare items with URLs (labs, demos, interactive)
  for (const item of (tdp.whatToShare ?? []).slice(0, 5)) {
    const url = resolveSaleshubUrl(item.url)
    if (url && item.name && item.name.length > 3) {
      const isLab = /lab|demo|interactive|sandbox|trial/i.test(item.name)
      materials.push({ title: item.name, url, type: isLab ? 'lab' : 'doc' })
    }
  }

  // whatToShow items with URLs
  for (const item of (tdp.whatToShow ?? []).slice(0, 3)) {
    const url = resolveSaleshubUrl(item.url)
    if (url && item.name && item.name.length > 3 && !/selected|arrow|displaying/i.test(item.name)) {
      materials.push({ title: item.name, url, type: 'demo' })
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>()
  return materials.filter(m => {
    if (seen.has(m.url)) return false
    seen.add(m.url)
    return true
  })
}
