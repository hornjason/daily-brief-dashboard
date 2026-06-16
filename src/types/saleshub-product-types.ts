/**
 * SalesHub Product Types — GitHub Issue #819
 *
 * TypeScript interfaces for the product-first SalesHub data model.
 * Each product page has a _product.json (scraped page structure)
 * and an optional _enriched.json (Gemini-extracted content kits).
 */

export interface ProductPage {
  name: string
  slug: string
  description: string
  pageUrl: string
  scrapedAt: string
  tdpLinks: Array<{ name: string; url?: string }>
  contacts: Array<{ name: string; email?: string; role?: string }>
  slackChannels: string[]
  sections: Record<string, ProductSection>
}

export interface ProductSection {
  title: string
  type: 'cards' | 'table' | 'links' | 'accordion' | 'text' | 'mixed'
  textContent?: string
  items: SectionItem[]
  metrics?: Array<{ value: string; context: string; sourceUrl?: string }>
  subsections?: ProductSection[]
}

export interface SectionItem {
  name: string
  url?: string
  description?: string
  itemType?: string  // 'deck', 'resource', 'video', 'case-study', 'workshop', 'lab', etc.
  audience?: string  // 'internal', 'partner', 'customer', 'external'
  driveUrl?: string
  children?: SectionItem[]
  contentId?: string
  versionId?: string
  format?: string
  localPath?: string
}

export interface ProductEnrichment {
  productSlug: string
  enrichedAt: string
  contentKits: ContentKitExtraction[]
  messagingGuides: DocumentExtraction[]
  battlecards: DocumentExtraction[]
}

export interface ContentKitExtraction {
  documentName: string
  cloudProvider: string
  actionableSteps: Array<{ step: string; url?: string }>
  calculatorUrl?: string
  contactName?: string
  contactEmail?: string
  workshops: Array<{ name: string; url: string }>
  demos: Array<{ name: string; url: string }>
  battlecards: Array<{ name: string; url: string; competitor?: string }>
  internalMaterials: Array<{ name: string; url: string }>
  salesPlayAlignment: string[]
}

export interface DocumentExtraction {
  documentName: string
  summary: string
  keyPoints: string[]
  talkTracks?: string[]
  links: Array<{ name: string; url: string }>
}
