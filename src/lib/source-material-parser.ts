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

const NOISE_WORDS = new Set(['the', 'our', 'their', 'this', 'that', 'with', 'from', 'red hat', 'ansible', 'openshift', 'rhel', 'customer', 'company', 'organization', 'what', 'why', 'how', 'when', 'where', 'who', 'which', 'chef', 'puppet', 'terraform', 'salt', 'why ansible', 'why aap', 'challenge', 'solution', 'results', 'products', 'background'])

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

  // Proximity-based: find "Customer Background:" sections and associate metrics within 40 lines
  const lines = content.split('\n')
  const CUSTOMER_BG_RE = /Customer(?:\s+Background)?:\s*([A-Z][A-Za-z&'.]+(?:\s+[A-Z][A-Za-z&'.]+){0,3}?)(?:[',\s])/
  const STANDALONE_NAME_RE = /^([A-Z][A-Za-z&'.]+(?:\s+[A-Z][A-Za-z&'.]*){0,3}?)\s+(?:is|was|has|had|are|were|chose|selected|replaced|consolidated|migrated|realized|in the process|Limited)/
  for (let i = 0; i < lines.length; i++) {
    const bgMatch = lines[i].match(CUSTOMER_BG_RE)
    const nameMatch = !bgMatch ? lines[i].match(STANDALONE_NAME_RE) : null
    const rawName = bgMatch?.[1] || nameMatch?.[1]
    if (!rawName) continue
    const customer = rawName.trim().replace(/['',]$/, '').replace(/'s?\s*mission$/, '')
    if (!isValidCustomerName(customer)) continue
    if (seen.has(customer.toLowerCase())) continue
    const windowLines = lines.slice(i, Math.min(i + 40, lines.length))
    const window = windowLines.join(' ')
    const metricRe = new RegExp(METRIC_PATTERN.source, METRIC_PATTERN.flags)
    if (!metricRe.test(window)) continue
    metricRe.lastIndex = 0

    // Collect lines that contain metrics — preserve narrative context
    const metricLines: { line: string; score: number }[] = []
    for (const line of windowLines) {
      const trimLine = line.trim()
      if (trimLine.length < 10) continue
      const lineMetricRe = new RegExp(METRIC_PATTERN.source, METRIC_PATTERN.flags)
      const lineMetrics: string[] = []
      let lm: RegExpExecArray | null
      while ((lm = lineMetricRe.exec(trimLine)) !== null) lineMetrics.push(lm[0])
      if (lineMetrics.length === 0) continue
      // Score: prefer lines with $ amounts and % figures
      let score = lineMetrics.length
      if (lineMetrics.some(m => m.startsWith('$'))) score += 3
      if (lineMetrics.some(m => m.includes('%'))) score += 2
      metricLines.push({ line: trimLine.replace(/^[-•*]\s*/, ''), score })
    }
    if (metricLines.length === 0) continue

    metricLines.sort((a, b) => b.score - a.score)
    const topLines = metricLines.slice(0, 3)
    let outcome = topLines.map(l => l.line).join('; ')
    if (outcome.length > 150) outcome = outcome.slice(0, 147) + '...'

    seen.add(customer.toLowerCase())
    results.push({ customer, outcome })
  }

  return results
}
