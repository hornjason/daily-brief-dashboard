/**
 * Customer Docs Module — GitHub Issue #274, #896 (SC-6, SC-8)
 * Migrates legacy customer docs corpus cache to registry signal contract.
 * Extracts structured content from textContent: tech references, key points, stakeholders.
 * Detects transcript-like documents and tags docType.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

/** SC-6: Technology keywords for reference extraction */
const TECH_KEYWORDS = [
  'Kubernetes', 'Ansible', 'OpenShift', 'Terraform', 'Jenkins',
  'Docker', 'AWS', 'Azure', 'GCP', 'Prometheus', 'Grafana', 'Elasticsearch',
] as const

/** SC-6: Patterns indicating actionable key points */
const KEY_POINT_PATTERNS = /\b(action|next step|follow up|follow-up|recommend|opportunity|priority)\b/i

/** SC-8: Patterns indicating transcript-like content */
const TRANSCRIPT_CONTENT_PATTERNS = /(?:^|\n)\s*(?:Speaker\s*:|\[?\d{1,2}:\d{2})/m

/**
 * SC-6: Extract technology references from text content.
 * Pure regex/string matching — no NLP, no Gemini.
 */
function extractTechReferences(text: string): string[] {
  const found: string[] = []
  for (const kw of TECH_KEYWORDS) {
    if (text.toLowerCase().includes(kw.toLowerCase())) {
      found.push(kw)
    }
  }
  return found
}

/**
 * SC-6: Extract actionable key points from bullet lines.
 * Looks for lines starting with * or - that contain action-oriented keywords.
 * Returns max 5 items.
 */
function extractKeyPoints(text: string): string[] {
  const lines = text.split('\n')
  const points: string[] = []
  for (const line of lines) {
    if (points.length >= 5) break
    const trimmed = line.trim()
    if ((trimmed.startsWith('*') || trimmed.startsWith('-')) && KEY_POINT_PATTERNS.test(trimmed)) {
      // Strip leading bullet and whitespace
      const clean = trimmed.replace(/^[*-]\s*/, '').trim()
      if (clean.length > 0) {
        points.push(clean)
      }
    }
  }
  return points
}

/**
 * SC-6: Extract stakeholder names from common patterns.
 * Matches patterns like "Contact:", "Owner:", "assigned to", "prepared for", "attendee".
 * Returns max 5 items.
 */
function extractStakeholders(text: string): string[] {
  const patterns = [
    /(?:Contact|Owner|Prepared for|Prepared by|Attendee|Attendees|Assigned to)\s*[:\-]\s*([^\n,;]{2,60})/gi,
  ]
  const found: string[] = []
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null && found.length < 5) {
      const name = match[1].trim()
      // Skip if it looks like a URL or email, or is too short
      if (name.length >= 2 && !name.includes('http') && !name.includes('@') && !found.includes(name)) {
        found.push(name)
      }
    }
  }
  return found.slice(0, 5)
}

/**
 * SC-8: Detect whether a file is a transcript.
 * Checks filename and content patterns.
 */
function isTranscript(fileName: string, textContent: string | undefined): boolean {
  // Check filename
  const nameLower = (fileName ?? '').toLowerCase()
  if (/transcript|meeting notes|minutes/.test(nameLower)) return true

  // Check content patterns
  if (textContent && TRANSCRIPT_CONTENT_PATTERNS.test(textContent)) return true

  return false
}

FeatureModuleRegistry.register({
  name: 'customer-docs',
  refreshEndpoint: '/api/customer/_global/modules/customer-docs/sync',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days — read-only, no independent refresh

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Data managed by product-intel pipeline — no independent refresh
  },

  cachePaths: () => [],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, 'product-intel', 'customer-docs', `${customerSlug}.json`)
    if (!existsSync(path)) return []

    let data: any
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return [] }

    const files = data.files ?? []
    if (files.length === 0) return []

    return files.map((f: any) => {
      const hasContent = !!(f.textContent && f.textContent.length > 0)
      const textContent: string = f.textContent ?? ''

      // SC-6: Build detail from textContent or fall back to metadata
      let detail: string
      if (hasContent) {
        detail = textContent.substring(0, 200).replace(/\n/g, ' ').trim()
      } else {
        detail = `${f.mimeType?.replace('application/vnd.google-apps.', '') ?? 'file'} | Modified: ${f.modifiedTime?.substring(0, 10) ?? 'unknown'}`
      }

      // SC-6: Extract structured content
      const techReferences = hasContent ? extractTechReferences(textContent) : []
      const keyPoints = hasContent ? extractKeyPoints(textContent) : []
      const stakeholders = hasContent ? extractStakeholders(textContent) : []

      // SC-8: Detect doc type
      const docType = isTranscript(f.name ?? '', hasContent ? textContent : undefined)
        ? 'transcript'
        : 'document'

      return {
        source: 'customer-docs',
        type: 'intelligence' as const,
        headline: f.name ?? 'Document',
        detail,
        rawRelevance: hasContent ? 0.6 : 0.4,
        timestamp: f.modifiedTime ?? data.extractedAt ?? new Date().toISOString(),
        metadata: {
          customerSlug,
          fileName: f.name,
          mimeType: f.mimeType,
          hasContent,
          contentLength: f.textContent?.length ?? 0,
          docType,
          ...(techReferences.length > 0 && { techReferences }),
          ...(keyPoints.length > 0 && { keyPoints }),
          ...(stakeholders.length > 0 && { stakeholders }),
        },
      }
    })
  },
})
