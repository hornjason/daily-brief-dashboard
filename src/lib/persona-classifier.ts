import { CATEGORY_KEYWORDS, type ObjectiveCategory, type CustomerObjectiveProfile, type ObjectiveEntry } from '../modules/intelligence-module.ts'

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
    return { categories: [{ category: 'financial', confidence: 0.5 }] }
  }

  const ranked = Object.entries(counts)
    .map(([cat, count]) => ({ category: cat as ObjectiveCategory, confidence: count / total }))
    .sort((a, b) => b.confidence - a.confidence)

  return { categories: ranked }
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
