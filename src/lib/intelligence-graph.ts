/**
 * src/lib/intelligence-graph.ts
 * Intelligence Graph Engine — the "deep module" with narrow interface, rich internal logic.
 *
 * GitHub Issue #511 — Intelligence Graph: types + engine + unit tests
 * References: ADR-032, PAI KnowledgeGraph.ts + GraphBuilder.ts (pattern sources)
 *
 * Builds a customer intelligence property graph from flat Signal[] data.
 * The Customer node is always the hub — all other nodes connect to it.
 *
 * Signal-to-node mapping:
 *   subscriptions → Subscription node
 *   cases         → Case node
 *   ccsp          → Program node (cloud spend)
 *   tech-stack    → Product node (isRedHat: false)
 *   pipeline      → Deal node
 *   solution-intelligence → MATCHES_PLAY derived edges
 *   cloud-marketplace     → Program node
 *   ecosystem-catalog     → Program node (partner type)
 *   intelligence          → Customer node enrichment metadata
 *   Other sources         → skipped
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { Signal } from '../feature-module-registry.ts'
import type {
  CustomerGraph,
  IntelligenceNode,
  IntelligenceEdge,
  MotionHistoryEntry,
  SignalHistory,
} from './intelligence-graph-types.ts'
import { computeContentHash, bfsTraverse, rankByEdgeStrength } from './graph-utils.ts'
import { writeJsonAtomic } from './atomic-write.ts'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAPH_VERSION = '1.0'
const MAX_GRAPH_SIZE_BYTES = 200 * 1024 // 200KB ceiling (50KB was too small for customers with 100+ signals)

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function makeNodeId(type: string, identifier: string): string {
  return `${type}:${slugify(identifier)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

// ── Signal Node Config ───────────────────────────────────────────────────────

interface SignalNodeConfig {
  nodeType: string
  buildNode: (signal: Signal, m: Record<string, any>, hash: string, ts: string) => IntelligenceNode | null
}

/**
 * Config-driven signal-to-node mapping (#580).
 * Adding a new signal source = adding a config entry. No switch statement.
 * Sources that return null create derived edges only or enrich the customer node.
 */
const SIGNAL_CONFIGS: Record<string, SignalNodeConfig> = {
  // ── Original 9 sources ─────────────────────────────────────────────────────

  'subscriptions': {
    nodeType: 'subscription',
    buildNode: (signal, m, hash, ts) => {
      const desc = String(m.productDescription ?? m.product ?? signal.headline)
      return {
        id: makeNodeId('subscription', desc),
        type: 'subscription',
        name: desc,
        properties: {
          sku: m.sku,
          quantity: m.quantity,
          status: m.status ?? m.urgency,
          urgency: m.urgency,
          startDate: m.startDate,
          endDate: m.endDate,
          productDescription: m.productDescription ?? m.product,
          url: signal.url,
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    },
  },

  'cases': {
    nodeType: 'case',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('case', String(m.caseNumber ?? 'unknown')),
      type: 'case',
      name: signal.headline,
      properties: {
        caseNumber: m.caseNumber,
        severity: m.severity,
        status: m.status,
        product: m.product,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'ccsp': {
    nodeType: 'program',
    buildNode: (signal, m, hash, ts) => {
      const partner = String(m.cloudPartner ?? 'unknown')
      return {
        id: makeNodeId('program', `ccsp-${partner}`),
        type: 'program',
        name: `CCSP: ${partner}`,
        properties: {
          cloudPartner: m.cloudPartner,
          acvPlus: m.acvPlus,
          programType: 'cloud-spend',
          url: signal.url,
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    },
  },

  'tech-stack': {
    nodeType: 'product',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('product', String(m.techName ?? signal.headline)),
      type: 'product',
      name: String(m.techName ?? signal.headline),
      properties: {
        techName: m.techName,
        category: m.category,
        context: m.context,
        isRedHat: false,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'pipeline': {
    nodeType: 'deal',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('deal', String(m.opportunityName ?? signal.headline)),
      type: 'deal',
      name: String(m.opportunityName ?? signal.headline),
      properties: {
        stage: m.stage,
        amount: m.amount,
        closeDate: m.closeDate,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'cloud-marketplace': {
    nodeType: 'program',
    buildNode: (signal, m, hash, ts) => {
      const provider = String(m.provider ?? 'unknown')
      return {
        id: makeNodeId('program', `marketplace-${provider}`),
        type: 'program',
        name: `Marketplace: ${provider}`,
        properties: {
          provider: m.provider,
          offeringCount: m.offeringCount,
          programCount: m.programCount,
          programType: 'marketplace',
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    },
  },

  'ecosystem-catalog': {
    nodeType: 'program',
    buildNode: (signal, m, hash, ts) => {
      const partnerName = String(m.partnerName ?? signal.headline)
      return {
        id: makeNodeId('program', `ecosystem-${partnerName}`),
        type: 'program',
        name: `Ecosystem: ${partnerName}`,
        properties: {
          partnerName: m.partnerName,
          partnerType: m.partnerType,
          programType: 'ecosystem',
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    },
  },

  'solution-intelligence': {
    nodeType: 'none',
    buildNode: () => null, // creates derived edges only
  },

  'intelligence': {
    nodeType: 'none',
    buildNode: () => null, // enriches customer node
  },

  // ── New sources (#580) — engagement, intel, lifecycle, events, evidence ──

  'emails': {
    nodeType: 'engagement',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('engagement', `email-${String(m.threadId ?? signal.headline).slice(0, 30)}`),
      type: 'engagement',
      name: signal.headline,
      properties: {
        channel: 'email',
        techMentions: m.techMentions,
        classification: m.classification,
        from: m.from,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'competitive-intel': {
    nodeType: 'intel',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('intel', `competitive-${String(m.competitor ?? signal.headline).slice(0, 30)}`),
      type: 'intel',
      name: signal.headline,
      properties: {
        intelType: 'competitive',
        competitor: m.competitor,
        product: m.product,
        threatLevel: m.threatLevel,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'product-lifecycle': {
    nodeType: 'lifecycle',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('lifecycle', String(m.product ?? signal.headline).slice(0, 40)),
      type: 'lifecycle',
      name: signal.headline,
      properties: {
        eolDate: m.eolDate,
        currentVersion: m.currentVersion,
        nextVersion: m.nextVersion,
        product: m.product,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'product-intel': {
    nodeType: 'intel',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('intel', `product-${String(m.product ?? signal.headline).slice(0, 30)}`),
      type: 'intel',
      name: signal.headline,
      properties: {
        intelType: 'product',
        product: m.product,
        category: m.category,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'account-plan': {
    nodeType: 'none',
    buildNode: () => null, // enriches customer node, like intelligence
  },

  'news-radar': {
    nodeType: 'intel',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('intel', `news-${String(m.title ?? signal.headline).slice(0, 30)}`),
      type: 'intel',
      name: signal.headline,
      properties: {
        intelType: 'news',
        source: m.source,
        publishedAt: m.publishedAt,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'rh-events': {
    nodeType: 'event',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('event', String(m.eventName ?? signal.headline).slice(0, 40)),
      type: 'event',
      name: signal.headline,
      properties: {
        eventType: m.eventType,
        date: m.date,
        url: signal.url,
        location: m.location,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'mergers-acquisitions': {
    nodeType: 'intel',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('intel', `ma-${String(m.target ?? signal.headline).slice(0, 30)}`),
      type: 'intel',
      name: signal.headline,
      properties: {
        intelType: 'ma',
        target: m.target,
        acquirer: m.acquirer,
        dealValue: m.dealValue,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'customer-docs': {
    nodeType: 'evidence',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('evidence', `doc-${String(m.docTitle ?? signal.headline).slice(0, 30)}`),
      type: 'evidence',
      name: signal.headline,
      properties: {
        docType: m.docType,
        url: signal.url,
        summary: m.summary,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'customer-product-intel': {
    nodeType: 'intel',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('intel', `cpi-${String(m.product ?? signal.headline).slice(0, 30)}`),
      type: 'intel',
      name: signal.headline,
      properties: {
        intelType: 'product-customer',
        product: m.product,
        usage: m.usage,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'rh-rss': {
    nodeType: 'intel',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('intel', `rss-${String(m.title ?? signal.headline).slice(0, 30)}`),
      type: 'intel',
      name: signal.headline,
      properties: {
        intelType: 'rss',
        feedSource: m.feedSource,
        publishedAt: m.publishedAt,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'saleshub-plays': {
    nodeType: 'none',
    buildNode: () => null, // feeds through solution-intelligence
  },

  'saleshub-tactics': {
    nodeType: 'none',
    buildNode: () => null, // feeds through solution-intelligence
  },

  'value-maps': {
    nodeType: 'evidence',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('evidence', `value-${String(m.mapName ?? signal.headline).slice(0, 30)}`),
      type: 'evidence',
      name: signal.headline,
      properties: {
        intelType: 'value',
        mapName: m.mapName,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'partner-catalog': {
    nodeType: 'partner',
    buildNode: (signal, m, hash, ts) => ({
      id: makeNodeId('partner', String(m.partnerName ?? signal.headline).slice(0, 40)),
      type: 'partner',
      name: String(m.partnerName ?? signal.headline),
      properties: {
        partnerName: m.partnerName,
        specializations: m.specializations,
        tier: m.tier,
        url: signal.url,
      },
      sourceModule: signal.source,
      contentHash: hash,
      updatedAt: ts,
    }),
  },

  'recommended-actions': {
    nodeType: 'none',
    buildNode: () => null, // output of graph, not input
  },

  'playbook': {
    nodeType: 'none',
    buildNode: () => null, // output, not input
  },

  'SalesHub Content': {
    nodeType: 'none',
    buildNode: () => null, // used via saleshub module
  },
}

// ── Signal-to-Node Mapping ────────────────────────────────────────────────────

function signalToNode(signal: Signal): IntelligenceNode | null {
  const config = SIGNAL_CONFIGS[signal.source]
  if (!config) return null
  const m = signal.metadata ?? {}
  const hash = computeContentHash(JSON.stringify(signal))
  const ts = nowIso()
  return config.buildNode(signal, m, hash, ts)
}

// ── Timestamp Extraction (#596) ──────────────────────────────────────────────

/**
 * Source-specific timestamp field mapping.
 * Each signal source knows which metadata fields carry real timestamps.
 * This eliminates the generic fallback chain that produced nowIso() for most signals.
 */
const SOURCE_TIMESTAMP_FIELDS: Record<string, string[]> = {
  'subscriptions': ['startDate', 'endDate'],
  'cases': ['createdDate', 'lastModifiedDate', 'created'],
  'emails': ['date', 'receivedAt', 'sentAt'],
  'pipeline': ['closeDate', 'createdDate'],
  'ccsp': ['reportDate'],
  'news-radar': ['publishedAt', 'date'],
  'rh-events': ['date', 'eventDate'],
  'product-lifecycle': ['eolDate'],
  'competitive-intel': ['detectedAt', 'date'],
  'mergers-acquisitions': ['announcedAt', 'date'],
  'rh-rss': ['publishedAt', 'date'],
  'cloud-marketplace': ['date'],
  'ecosystem-catalog': ['date'],
  'tech-stack': ['date'],
  'customer-docs': ['date'],
  'customer-product-intel': ['date'],
  'product-intel': ['date'],
  'partner-catalog': ['date'],
  'value-maps': ['date'],
}

/**
 * Extract the best available timestamp from a signal's metadata.
 * Tries source-specific fields first, then generic fields, then signal.timestamp.
 * Returns { ts, source } where source indicates provenance.
 */
export function extractSignalTimestamp(
  signal: Signal,
  m: Record<string, any>,
): { ts: string; source: 'signal' | 'ingestion' } {
  // Try source-specific fields first
  const fields = SOURCE_TIMESTAMP_FIELDS[signal.source] ?? []
  for (const field of fields) {
    const val = m[field]
    if (val && typeof val === 'string' && !isNaN(Date.parse(val))) {
      return { ts: val, source: 'signal' }
    }
  }

  // Try generic fields
  for (const field of ['startDate', 'createdAt', 'date', 'timestamp', 'createdDate']) {
    const val = m[field]
    if (val && typeof val === 'string' && !isNaN(Date.parse(val))) {
      return { ts: val, source: 'signal' }
    }
  }

  // Try signal-level timestamp
  if (signal.timestamp && typeof signal.timestamp === 'string' && !isNaN(Date.parse(signal.timestamp))) {
    return { ts: signal.timestamp, source: 'signal' }
  }

  // No real timestamp found — caller should use graph builtAt
  return { ts: '', source: 'ingestion' }
}

// ── Edge Creation ─────────────────────────────────────────────────────────────

function createFactualEdge(
  customerNodeId: string,
  node: IntelligenceNode,
  signal: Signal,
  graphBuiltAt: string,
): IntelligenceEdge {
  const relationMap: Record<string, string> = {
    subscription: 'HAS_SUBSCRIPTION',
    case: 'HAS_CASE',
    product: 'USES_PRODUCT',
    deal: 'HAS_DEAL',
    program: 'PARTICIPATES_IN',
    engagement: 'HAS_ENGAGEMENT',
    intel: 'HAS_INTEL',
    lifecycle: 'HAS_LIFECYCLE',
    event: 'ATTENDED_EVENT',
    evidence: 'HAS_EVIDENCE',
    partner: 'HAS_PARTNER',
  }

  const m = signal.metadata ?? {}
  const { ts, source: timestampSource } = extractSignalTimestamp(signal, m)
  const createdAt = ts || graphBuiltAt

  return {
    from: customerNodeId,
    to: node.id,
    relation: relationMap[node.type] ?? 'RELATED_TO',
    tier: 'factual',
    strength: signal.score ?? signal.rawRelevance ?? 0.5,
    evidence: [signal.headline],
    sourceUrl: signal.url,
    scoredAt: nowIso(),
    createdAt,
    sourceType: signal.source,
    timestampSource,
  }
}

// ── Subscription → Play Mapping (#573) ───────────────────────────────────────

const TDP_TO_PLAY: Record<string, string> = {
  'Automation': 'Build and Run Applications',
  'Container Mgmt': 'Build and Run Applications',
  'Server/Cloud OS': 'Server and Cloud Computing',
  'Management': 'Server and Cloud Computing',
  'AI Platform': 'Server and Cloud Computing',
  'Virtualization': 'Server and Cloud Computing',
}

function inferTdpFromSubscription(productName: string): string | null {
  const lower = productName.toLowerCase()
  if (lower.includes('ansible') || lower.includes('automation')) return 'Automation'
  if (lower.includes('openshift') || lower.includes('container') || lower.includes('kubernetes')) return 'Container Mgmt'
  if (lower.includes('rhel') || lower.includes('enterprise linux') || lower.includes('server')) return 'Server/Cloud OS'
  if (lower.includes('virtualization') || lower.includes('virt')) return 'Virtualization'
  if (lower.includes('satellite')) return 'Management'
  if (lower.includes('ai') || lower.includes('rhoai')) return 'AI Platform'
  if (lower.includes('runtime')) return 'Container Mgmt'
  return null
}

function createDerivedEdges(
  customerNodeId: string,
  signal: Signal,
  existingNodes: Record<string, IntelligenceNode>,
  graphBuiltAt: string,
): IntelligenceEdge[] {
  const edges: IntelligenceEdge[] = []
  const m = signal.metadata ?? {}
  const { ts, source: timestampSource } = extractSignalTimestamp(signal, m)
  const derivedCreatedAt = ts || graphBuiltAt

  if (signal.source === 'solution-intelligence') {
    const solutionName = String(m.solutionName ?? signal.headline)
    const playNodeId = makeNodeId('play', solutionName)

    // Create the play node if it doesn't exist (side effect)
    if (!existingNodes[playNodeId]) {
      existingNodes[playNodeId] = {
        id: playNodeId,
        type: 'play',
        name: solutionName,
        properties: {
          productAlignment: m.productAlignment,
          matchedTechnologies: m.matchedTechnologies,
          url: signal.url,
        },
        sourceModule: signal.source,
        contentHash: computeContentHash(JSON.stringify(signal)),
        updatedAt: nowIso(),
      }
    }

    // Customer → Play edge
    edges.push({
      from: customerNodeId,
      to: playNodeId,
      relation: 'MATCHES_PLAY',
      tier: 'derived',
      strength: signal.score ?? signal.rawRelevance ?? 0.7,
      evidence: [signal.headline],
      sourceUrl: signal.url,
      scoredAt: nowIso(),
      createdAt: derivedCreatedAt,
      sourceType: signal.source,
      timestampSource,
    })

    // If matched technologies reference existing product nodes, link play → product
    const matchedTechs = (m.matchedTechnologies as string[]) ?? []
    for (const tech of matchedTechs) {
      const productNodeId = makeNodeId('product', tech)
      if (existingNodes[productNodeId]) {
        edges.push({
          from: playNodeId,
          to: productNodeId,
          relation: 'TARGETS_PRODUCT',
          tier: 'derived',
          strength: 0.8,
          evidence: [signal.headline],
          sourceUrl: signal.url,
          scoredAt: nowIso(),
          createdAt: derivedCreatedAt,
          sourceType: signal.source,
          timestampSource,
        })
      }
    }
  }

  // Emails with techMentions → MENTIONED_IN edges to matching Product/Play nodes (#580)
  if (signal.source === 'emails') {
    const techMentions = (m.techMentions as string[]) ?? []
    for (const tech of techMentions) {
      // Check for matching product nodes
      const productNodeId = makeNodeId('product', tech)
      if (existingNodes[productNodeId]) {
        edges.push({
          from: existingNodes[productNodeId].id,
          to: makeNodeId('engagement', `email-${String(m.threadId ?? signal.headline).slice(0, 30)}`),
          relation: 'MENTIONED_IN',
          tier: 'derived',
          strength: 0.6,
          evidence: [signal.headline],
          sourceUrl: signal.url,
          scoredAt: nowIso(),
          createdAt: derivedCreatedAt,
          sourceType: signal.source,
          timestampSource,
        })
      }
      // Check for matching play nodes
      const playNodeId = makeNodeId('play', tech)
      if (existingNodes[playNodeId]) {
        edges.push({
          from: existingNodes[playNodeId].id,
          to: makeNodeId('engagement', `email-${String(m.threadId ?? signal.headline).slice(0, 30)}`),
          relation: 'MENTIONED_IN',
          tier: 'derived',
          strength: 0.6,
          evidence: [signal.headline],
          sourceUrl: signal.url,
          scoredAt: nowIso(),
          createdAt: derivedCreatedAt,
          sourceType: signal.source,
          timestampSource,
        })
      }
    }
  }

  // Competitive intel → COMPETITIVE_PRESSURE edges (#580)
  if (signal.source === 'competitive-intel') {
    const competitor = String(m.competitor ?? signal.headline).slice(0, 30)
    const competitorNodeId = makeNodeId('intel', `competitive-${competitor}`)
    // Link competitor intel to any matching product nodes
    const product = m.product as string | undefined
    if (product) {
      const productNodeId = makeNodeId('product', product)
      if (existingNodes[productNodeId]) {
        edges.push({
          from: competitorNodeId,
          to: productNodeId,
          relation: 'COMPETITIVE_PRESSURE',
          tier: 'derived',
          strength: signal.score ?? 0.7,
          evidence: [signal.headline],
          sourceUrl: signal.url,
          scoredAt: nowIso(),
          createdAt: derivedCreatedAt,
          sourceType: signal.source,
          timestampSource,
        })
      }
    }
  }

  // Product lifecycle → enrich existing Subscription nodes with EOL data (#580)
  if (signal.source === 'product-lifecycle') {
    const productName = String(m.product ?? signal.headline)
    // Find subscription nodes that match this product
    for (const [nodeId, node] of Object.entries(existingNodes)) {
      if (node.type === 'subscription') {
        const subProduct = String(node.properties.productDescription ?? node.name ?? '')
        if (subProduct.toLowerCase().includes(productName.toLowerCase())) {
          // Enrich the subscription node with lifecycle data
          node.properties.eolDate = m.eolDate
          node.properties.currentVersion = m.currentVersion
          node.properties.nextVersion = m.nextVersion
        }
      }
    }
  }

  // Subscriptions → MATCHES_PLAY (derived from product → TDP mapping)
  // Ensures customers with subscriptions but no tech-stack get play matches (#573)
  if (signal.source === 'subscriptions') {
    const productDesc = String(m.productDescription ?? signal.headline ?? '')
    const tdp = inferTdpFromSubscription(productDesc)
    if (tdp) {
      const playName = TDP_TO_PLAY[tdp]
      if (playName) {
        const playNodeId = makeNodeId('play', playName)
        if (!existingNodes[playNodeId]) {
          existingNodes[playNodeId] = {
            id: playNodeId,
            type: 'play',
            name: playName,
            properties: {
              tdp,
              source: 'subscription-derived',
            },
            sourceModule: 'subscriptions',
            contentHash: computeContentHash(productDesc),
            updatedAt: nowIso(),
          }
        }
        edges.push({
          from: customerNodeId,
          to: playNodeId,
          relation: 'MATCHES_PLAY',
          tier: 'derived',
          strength: 0.8,
          evidence: [`Active subscription: ${productDesc}`],
          scoredAt: nowIso(),
          createdAt: derivedCreatedAt,
          sourceType: signal.source,
          timestampSource,
        })
      }
    }
  }

  return edges
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build a complete customer intelligence graph from flat Signal[] data.
 *
 * The Customer node is always created as the hub.
 * Signal sources map to node types per the mapping table in this module's header.
 * Content-hash caching: if a signal hasn't changed (same hash), reuse existing node.
 */
export function buildCustomerGraph(
  customerSlug: string,
  customerName: string,
  signals: Signal[],
  existingGraph?: CustomerGraph | null,
): CustomerGraph {
  const ts = nowIso()
  const customerNodeId = makeNodeId('customer', customerSlug)

  // Build existing hash lookup for cache reuse
  const existingHashes = new Map<string, IntelligenceNode>()
  if (existingGraph) {
    for (const node of Object.values(existingGraph.nodes)) {
      existingHashes.set(`${node.id}:${node.contentHash}`, node)
    }
  }

  // Customer node is always the hub
  const nodes: Record<string, IntelligenceNode> = {
    [customerNodeId]: {
      id: customerNodeId,
      type: 'customer',
      name: customerName,
      properties: {},
      sourceModule: 'intelligence-graph',
      contentHash: computeContentHash(customerSlug),
      updatedAt: ts,
    },
  }

  const edges: IntelligenceEdge[] = []

  // Process signals: create nodes and factual edges
  for (const signal of signals) {
    // Enrich customer node with intelligence metadata
    if (signal.source === 'intelligence') {
      const m = signal.metadata ?? {}
      Object.assign(nodes[customerNodeId].properties, m)
      continue
    }

    const node = signalToNode(signal)
    if (node) {
      // Content-hash caching: reuse existing node if hash matches
      const cacheKey = `${node.id}:${node.contentHash}`
      const cached = existingHashes.get(cacheKey)
      if (cached) {
        nodes[node.id] = cached
      } else {
        nodes[node.id] = node
      }

      // Create factual edge from customer → node
      edges.push(createFactualEdge(customerNodeId, node, signal, ts))
    }

    // Create derived edges (e.g., solution-intelligence → MATCHES_PLAY)
    const derivedEdges = createDerivedEdges(customerNodeId, signal, nodes, ts)
    edges.push(...derivedEdges)
  }

  // ── Temporal signal persistence (#601) ────────────────────────────────────
  // Set history on all new/active nodes, carry forward historical nodes from existing graph

  // Mark all nodes in the new graph as active with history
  for (const node of Object.values(nodes)) {
    const existingNode = existingGraph?.nodes[node.id]
    node.history = {
      appeared: existingNode?.history?.appeared ?? ts,
      lastSeen: ts,
      status: 'active',
    }
  }

  // Carry forward historical nodes — nodes that existed in the previous graph but not in the new one
  if (existingGraph) {
    for (const [nodeId, existingNode] of Object.entries(existingGraph.nodes)) {
      if (!nodes[nodeId]) {
        // This node disappeared from the current signal feed — mark as historical
        nodes[nodeId] = {
          ...existingNode,
          history: {
            appeared: existingNode.history?.appeared ?? existingNode.updatedAt,
            lastSeen: existingNode.history?.lastSeen ?? existingNode.updatedAt,
            status: 'historical',
          },
        }
        // Carry forward existing edges for this historical node (don't generate new ones)
        const existingEdgesForNode = existingGraph.edges.filter(
          e => e.from === nodeId || e.to === nodeId,
        )
        edges.push(...existingEdgesForNode)
      }
    }
  }

  // Count only active nodes/edges for denormalized counts
  const activeNodeCount = Object.values(nodes).filter(
    n => n.history?.status !== 'historical',
  ).length
  const activeEdgeCount = edges.filter(e => {
    const fromNode = nodes[e.from]
    const toNode = nodes[e.to]
    // An edge is active if both endpoints are active (or have no history = legacy)
    return (fromNode?.history?.status !== 'historical') &&
           (toNode?.history?.status !== 'historical')
  }).length

  const graph: CustomerGraph = {
    customerId: customerSlug,
    customerName,
    version: GRAPH_VERSION,
    builtAt: ts,
    nodeCount: activeNodeCount,
    edgeCount: activeEdgeCount,
    nodes,
    edges,
  }

  return graph
}

// ── Persist / Load ────────────────────────────────────────────────────────────

/**
 * Persist graph to {dataDir}/{customerSlug}/intelligence-graph.json.
 * Enforces <50KB ceiling — throws if exceeded.
 * Uses writeJsonAtomic for crash-safe writes.
 */
export function persistGraph(graph: CustomerGraph, dataDir: string): void {
  if (/[^a-zA-Z0-9_-]/.test(graph.customerId)) {
    throw new Error(`[intelligence-graph] unsafe customerId: ${graph.customerId}`)
  }
  const json = JSON.stringify(graph, null, 2)

  if (Buffer.byteLength(json, 'utf-8') > MAX_GRAPH_SIZE_BYTES) {
    throw new Error(
      `Intelligence graph for ${graph.customerId} exceeds 50KB ceiling ` +
      `(${Buffer.byteLength(json, 'utf-8')} bytes). ` +
      `Reduce node/edge count or prune stale data.`,
    )
  }

  const filePath = resolve(dataDir, graph.customerId, 'intelligence-graph.json')

  // Save the current graph as .previous.json before overwriting (#671)
  if (existsSync(filePath)) {
    try {
      const currentRaw = readFileSync(filePath, 'utf-8')
      const previousPath = resolve(dataDir, graph.customerId, 'intelligence-graph.previous.json')
      writeJsonAtomic(previousPath, JSON.parse(currentRaw))
    } catch {
      // If we can't read/parse the current file, skip creating previous snapshot
    }
  }

  writeJsonAtomic(filePath, graph)
}

/**
 * Load persisted graph. Returns null if file doesn't exist.
 */
export function loadGraph(
  customerSlug: string,
  dataDir: string,
): CustomerGraph | null {
  if (/[^a-zA-Z0-9_-]/.test(customerSlug)) {
    throw new Error(`[intelligence-graph] unsafe customerSlug: ${customerSlug}`)
  }
  const filePath = resolve(dataDir, customerSlug, 'intelligence-graph.json')

  if (!existsSync(filePath)) {
    return null
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as CustomerGraph
  } catch {
    return null
  }
}

// ── History & Staleness (#522) ────────────────────────────────────────────

const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

/**
 * Merge previous motion history into a rebuilt graph.
 * Preserves dismissed/pinned status from the previous cycle.
 * Updates lastSeenAt for entries that still exist; carries forward
 * all others unchanged.
 *
 * Returns the graph with the merged history array set.
 */
export function mergeHistory(
  graph: CustomerGraph,
  previousHistory: MotionHistoryEntry[],
): CustomerGraph {
  const ts = nowIso()
  const merged = new Map<string, MotionHistoryEntry>()

  // Carry forward all previous entries
  for (const entry of previousHistory) {
    merged.set(entry.motionId, { ...entry, lastSeenAt: ts })
  }

  // Prune before attaching
  const prunedHistory = pruneHistory([...merged.values()])
  graph.history = prunedHistory

  return graph
}

/**
 * Remove history entries older than 90 days (based on firstSeenAt).
 * Keeps the graph file under the 50KB ceiling.
 */
export function pruneHistory(history: MotionHistoryEntry[]): MotionHistoryEntry[] {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS
  return history.filter(entry => new Date(entry.firstSeenAt).getTime() > cutoff)
}

/**
 * Filter out stale derived edges from a graph.
 *
 * A derived edge is stale when its scoredAt timestamp is older than the
 * updatedAt of any source node referenced in its evidence[] array or
 * connected via from/to.
 *
 * Only filters derived edges; factual edges pass through unchanged.
 */
export function filterStaleEdges(graph: CustomerGraph): IntelligenceEdge[] {
  return graph.edges.filter(edge => {
    // Only check derived edges for staleness
    if (edge.tier === 'factual') return true

    const scoredAtMs = new Date(edge.scoredAt).getTime()

    // Check if either endpoint node has been updated after the edge was scored
    const fromNode = graph.nodes[edge.from]
    const toNode = graph.nodes[edge.to]

    if (fromNode) {
      const fromUpdatedMs = new Date(fromNode.updatedAt).getTime()
      if (fromUpdatedMs > scoredAtMs) return false
    }

    if (toNode) {
      const toUpdatedMs = new Date(toNode.updatedAt).getTime()
      if (toUpdatedMs > scoredAtMs) return false
    }

    return true
  })
}

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Start at customer node, BFS 2-3 hops, return Play nodes ranked by
 * converging edge strength.
 *
 * A play with 3 signals pointing at it ranks higher than one with 1 signal.
 */
export function queryPlays(graph: CustomerGraph): IntelligenceNode[] {
  const customerNodeId = Object.values(graph.nodes).find(
    n => n.type === 'customer',
  )?.id

  if (!customerNodeId) return []

  // BFS 3 hops from customer to find all reachable nodes
  const reachable = bfsTraverse(graph, customerNodeId, 3)

  // Filter to play nodes only
  const plays = reachable.filter(n => n.type === 'play')

  if (plays.length === 0) return []

  // Rank by converging edge strength (sum of all edges touching each play)
  return rankByEdgeStrength(plays, graph.edges)
}
