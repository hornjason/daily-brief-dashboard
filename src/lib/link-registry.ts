export interface ExtractedLink {
  anchor: string
  url: string
  source: 'document' | 'email' | 'supplemental'
  isInternal: boolean
  isHomepage: boolean
}

export interface LinkPlaceholder {
  marker: string
  anchor: string
  url: string
}

const INTERNAL_URL_PATTERNS = [
  /docs\.google\.com/,
  /drive\.google\.com/,
  /slides\.google\.com/,
  /access\.redhat\.com/,
  /content\.redhat\.com/,
  /source\.redhat\.com/,
  /mojo\.redhat\.com/,
  /salesforce\.com/,
  /seismic\.com/,
]

export function isInternalUrl(url: string): boolean {
  return INTERNAL_URL_PATTERNS.some(p => p.test(url))
}

export function isHomepageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '')
    return path.length < 5 || path === '/en'
  } catch {
    return true
  }
}

export class LinkRegistry {
  private links: ExtractedLink[] = []

  constructor(refs: Array<{ url: string; title: string; excerpt?: string }>, source: ExtractedLink['source'] = 'document') {
    for (const ref of refs) {
      if (ref.url && ref.title) {
        this.links.push({
          anchor: ref.title,
          url: ref.url,
          source,
          isInternal: isInternalUrl(ref.url),
          isHomepage: isHomepageUrl(ref.url),
        })
      }
    }
  }

  getExternalLinks(): ExtractedLink[] {
    return this.links.filter(l => !l.isHomepage && !l.isInternal)
  }

  getReferenceMaterials(excerpts?: Map<string, string>): Array<{ resource: string; url?: string; keyTakeaway: string }> {
    return this.getExternalLinks().map(l => {
      const excerpt = excerpts?.get(l.anchor)
      const keyTakeaway = excerpt
        ? (excerpt.length > 200 ? excerpt.slice(0, 200) + '...' : excerpt)
        : 'Source document referenced in campaign material.'
      return { resource: l.anchor, url: l.url, keyTakeaway }
    })
  }

  getSourceDomains(): Set<string> {
    const domains = new Set<string>()
    for (const l of this.links) {
      if (!l.isInternal) {
        try { domains.add(new URL(l.url).hostname) } catch {}
      }
    }
    return domains
  }

  getAll(): ExtractedLink[] {
    return [...this.links]
  }

  get size(): number {
    return this.links.length
  }
}

export function isolateLinks(body: string): { cleanBody: string; placeholders: LinkPlaceholder[] } {
  const placeholders: LinkPlaceholder[] = []
  let index = 0
  const cleanBody = body.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, anchor, url) => {
    index++
    const marker = `REF${index}`
    placeholders.push({ marker, anchor, url })
    return marker
  })
  return { cleanBody, placeholders }
}

export function restoreLinks(polished: string, placeholders: LinkPlaceholder[]): string {
  let result = polished
  for (const { marker, anchor, url } of placeholders) {
    result = result.replace(marker, `[${anchor}](${url})`)
  }
  return result
}
