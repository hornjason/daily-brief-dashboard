export interface MaterialPeerProof {
  customer: string
  outcome: string
}

const METRIC_PATTERN = /\$[\d,.]+[MBK]?\b|[\d,.]+%\s*(?:ROI|reduction|savings|improvement|increase|decrease|growth)|[\d,]+\s*(?:nodes|servers|instances|users|endpoints|devices)/gi

const WIN_PATTERNS = [
  /(?:^|\n)\s*[-•]\s*([A-Z][A-Za-z\s&.']+?)\s*[→—–-]+\s*(.+?)(?:\n|$)/g,
  /(?:^|\n)\s*[-•]\s*([A-Z][A-Za-z\s&.']+?):\s+(.+?(?:\$[\d,.]+[MBK]?\b|[\d,.]+%|[\d,]+\s*nodes).+?)(?:\n|$)/g,
  /([A-Z][A-Za-z\s&.']{2,30})\s+(?:achieved|saved|reduced|realized|delivered|generated|gained|eliminated|consolidated|migrated|deployed|replaced|standardized)\s+(.+?(?:\$[\d,.]+[MBK]?\b|[\d,.]+%|[\d,]+\s*(?:nodes|servers|instances)).+?)(?:\.|;|\n|$)/gi,
]

const NOISE_WORDS = new Set(['the', 'our', 'their', 'this', 'that', 'with', 'from', 'red hat', 'ansible', 'openshift', 'rhel', 'customer', 'company', 'organization'])

function isValidCustomerName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 2 || trimmed.length > 40) return false
  if (NOISE_WORDS.has(trimmed.toLowerCase())) return false
  if (/^[a-z]/.test(trimmed)) return false
  if (/^\d/.test(trimmed)) return false
  return true
}

export function extractPeerProofsFromMaterial(content: string): MaterialPeerProof[] {
  const seen = new Set<string>()
  const results: MaterialPeerProof[] = []

  for (const pattern of WIN_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      const customer = match[1].trim().replace(/\s+/g, ' ')
      const outcome = match[2].trim().replace(/\s+/g, ' ')
      if (!isValidCustomerName(customer)) continue
      if (!METRIC_PATTERN.test(outcome)) {
        METRIC_PATTERN.lastIndex = 0
        continue
      }
      METRIC_PATTERN.lastIndex = 0
      const key = customer.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ customer, outcome })
    }
  }

  return results
}
