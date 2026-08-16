import { CATEGORY_KEYWORDS, type ObjectiveCategory, type CustomerObjectiveProfile, type ObjectiveEntry } from '../modules/intelligence-module.ts'
import type { MaterialPeerProof } from './source-material-parser.ts'

export interface ContactContext {
  name: string
  title: string
  profileText?: string
  leadershipContext?: string
}

export interface PersonaClassification {
  categories: Array<{ category: ObjectiveCategory; confidence: number }>
}

export interface PreMatchedMetric {
  recipientName: string
  recipientTitle: string
  category: ObjectiveCategory
  confidence: number
  entry: ObjectiveEntry
}

const INTERNAL_SIGNAL_PATTERN = /terminat|resign|restructur|layoff/i

export function classifyPersona(contact: ContactContext): PersonaClassification {
  const text = [contact.title, contact.profileText ?? '', contact.leadershipContext ?? ''].join(' ')
  const counts: Record<string, number> = {}
  let total = 0

  for (const [cat, regex] of Object.entries(CATEGORY_KEYWORDS) as [ObjectiveCategory, RegExp][]) {
    const matches = text.match(new RegExp(regex.source, 'gi'))
    const count = matches?.length ?? 0
    if (count > 0) {
      counts[cat] = count
      total += count
    }
  }

  if (total === 0) {
    return { categories: [{ category: 'operational', confidence: 0.5 }] }
  }

  const ranked = Object.entries(counts)
    .map(([cat, count]) => ({ category: cat as ObjectiveCategory, confidence: count / total }))
    .sort((a, b) => b.confidence - a.confidence)

  return { categories: ranked }
}

export interface PreMatchedPeerProof {
  recipientName: string
  proof: MaterialPeerProof
  category: string
}

export function preMatchPeerProofs(
  contacts: Array<{ name: string; title: string }>,
  availableProofs: MaterialPeerProof[],
): PreMatchedPeerProof[] {
  if (availableProofs.length === 0) return []

  const classifiedProofs = availableProofs.map(proof => {
    let bestCat = 'operational'
    let bestScore = 0
    for (const [cat, re] of Object.entries(CATEGORY_KEYWORDS)) {
      const matches = proof.outcome.match(new RegExp(re.source, 'gi'))
      if (matches && matches.length > bestScore) {
        bestScore = matches.length
        bestCat = cat
      }
    }
    const hasFinancialSignal = /\$[\d,.]+|ROI|cost|TCO|payback|benefit/i.test(proof.outcome)
    const hasOperationalSignal = /\bnodes?\b|deploy|infrastructure|managed\s+app|fleet|scale|provisioning|cluster/i.test(proof.outcome)
    if (hasFinancialSignal && !hasOperationalSignal) {
      bestCat = 'financial'
    }
    return { proof, category: bestCat }
  })

  const results: PreMatchedPeerProof[] = []
  const usedProofIndices = new Map<number, number>()

  for (const contact of contacts) {
    const persona = classifyPersona({ name: contact.name, title: contact.title })
    const topCategory = persona.categories[0]?.category || 'operational'

    let matched = classifiedProofs.find((cp, i) =>
      cp.category === topCategory && (usedProofIndices.get(i) || 0) < 2
    )
    if (!matched) {
      const idx = classifiedProofs.findIndex((_, i) => (usedProofIndices.get(i) || 0) < 2)
      if (idx >= 0) matched = classifiedProofs[idx]
    }
    if (!matched) matched = classifiedProofs[0]

    const proofIdx = classifiedProofs.indexOf(matched)
    usedProofIndices.set(proofIdx, (usedProofIndices.get(proofIdx) || 0) + 1)

    results.push({
      recipientName: contact.name,
      proof: matched.proof,
      category: matched.category,
    })
  }

  return results
}

export function preMatchObjectives(
  contacts: Array<{ name: string; title: string; leadershipContext?: string }>,
  profile: CustomerObjectiveProfile,
): PreMatchedMetric[] {
  const results: PreMatchedMetric[] = []

  for (const contact of contacts) {
    const classification = classifyPersona(contact)

    let matched: PreMatchedMetric | null = null
    for (const { category, confidence } of classification.categories) {
      const entries = profile[category]?.filter(e =>
        e.priority !== 'LOW' && !INTERNAL_SIGNAL_PATTERN.test(e.objective)
      ) ?? []

      if (entries.length > 0) {
        matched = {
          recipientName: contact.name,
          recipientTitle: contact.title,
          category,
          confidence,
          entry: entries[0],
        }
        break
      }
    }

    if (matched) results.push(matched)
  }

  return results
}
