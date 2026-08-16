const EMAIL_PREFIX_PATTERN = /^\s*(?:\[[^\]]+\]\s*)*(?:(?:Re|Fwd|FW|Fw):\s*)*/gi

const PRESERVED_ACRONYMS = new Set(['SaaS', 'AI', 'API', 'AAP', 'TCO', 'ROI', 'RHEL', 'AWS', 'GCP', 'VMware', 'IaC', 'DDoS', 'EBITDA', 'EPS', 'YoY', 'CI', 'CD', 'DevOps', 'MLOps', 'AIOps', 'OpenShift', 'CISO', 'CTO', 'CFO', 'CEO', 'CIO'])

export function cleanEmailSubject(rawTitle: string): string {
  if (!rawTitle) return ''
  let cleaned = rawTitle.replace(EMAIL_PREFIX_PATTERN, '').trim()
  if (!cleaned) return rawTitle.trim()
  const minorWords = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'from', 'by', 'in', 'of', 'with', 'as', 'is', 'vs'])
  const acronymLookup = new Map([...PRESERVED_ACRONYMS].map(a => [a.toLowerCase(), a]))
  cleaned = cleaned.replace(/\b\w+/g, (word, index) => {
    const preserved = acronymLookup.get(word.toLowerCase())
    if (preserved) return preserved
    if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    if (minorWords.has(word.toLowerCase())) return word.toLowerCase()
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  })
  return cleaned
}
