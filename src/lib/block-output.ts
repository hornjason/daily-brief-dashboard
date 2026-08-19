export interface LinkRef {
  anchor: string
  url: string
  position: 'inline' | 'reference'
}

export interface MetricRef {
  value: string
  source: string
  category: string
}

export interface BlockOutput {
  text: string
  links: LinkRef[]
  metrics: MetricRef[]
}

const SPECULATION_WORDS = /\b(?:probably|likely|should be|might|could be|perhaps|possibly|it seems|appears to)\b/i
const COACHING_WORDS = /\b(?:show how|demonstrate|highlight|emphasize|position|leverage this)\b/i
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g

export function validateBlock(name: string, output: BlockOutput, opts?: { maxWords?: number }): BlockOutput {
  if (opts?.maxWords) {
    const words = output.text.split(/\s+/).filter(Boolean).length
    if (words > opts.maxWords) {
      console.warn(`[block:${name}] Word count ${words} exceeds limit ${opts.maxWords}`)
    }
  }

  if (SPECULATION_WORDS.test(output.text)) {
    console.warn(`[block:${name}] Contains speculation language`)
  }

  if (COACHING_WORDS.test(output.text)) {
    console.warn(`[block:${name}] Contains coaching language`)
  }

  for (const link of output.links) {
    if (!link.url.startsWith('http://') && !link.url.startsWith('https://')) {
      console.warn(`[block:${name}] Link "${link.anchor}" has invalid URL: ${link.url}`)
    }
  }

  return output
}

export function blockText(b: BlockOutput): string {
  return b.text
}

export function extractLinks(text: string): LinkRef[] {
  const links: LinkRef[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(LINK_PATTERN.source, LINK_PATTERN.flags)
  while ((match = re.exec(text)) !== null) {
    links.push({ anchor: match[1], url: match[2], position: 'inline' })
  }
  return links
}

export function toBlock(text: string, metrics: MetricRef[] = []): BlockOutput {
  return { text, links: extractLinks(text), metrics }
}
