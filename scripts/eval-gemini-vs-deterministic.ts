#!/usr/bin/env bun
/**
 * scripts/eval-gemini-vs-deterministic.ts
 * Blind evaluation harness: Gemini tactic recommender vs deterministic scorer.
 *
 * GitHub Issue #599 — Gemini inference layer, Phase 1
 *
 * Loads real customer intelligence graphs, runs both paths, and outputs
 * a side-by-side comparison table. Saves results to data/eval/.
 *
 * Usage:
 *   bun run scripts/eval-gemini-vs-deterministic.ts
 *
 * Environment:
 *   DATA_DIR   — path to data directory (default: ./data)
 *   CONFIG_DIR — path to config directory (default: ./config)
 *   BASE_URL   — API base URL for fetching graphs if local files absent
 *                (default: http://localhost:7777)
 *
 * The script:
 *   1. Discovers customer graphs from local data or API
 *   2. Loads the full tactic portfolio from saleshub-knowledge.json
 *   3. For each customer, runs both:
 *      a. Deterministic path: scoreTactics() → top 5
 *      b. Gemini path: recommendTactics() → top 5
 *   4. Outputs comparison table to stdout
 *   5. Saves full results to data/eval/gemini-vs-deterministic-{timestamp}.json
 */

import { resolve, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { loadGraph } from '../src/lib/intelligence-graph.ts'
import { scoreTactics } from '../src/lib/tactic-scorer.ts'
import { summarizeGraph } from '../src/lib/graph-summary.ts'
import { recommendTactics, type GeminiRecommendation } from '../src/lib/gemini-tactic-recommender.ts'
import type { CustomerGraph } from '../src/lib/intelligence-graph-types.ts'

// ── Configuration ────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR ?? resolve(import.meta.dir, '../data')
const CACHE_DIR = process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache')
const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'
const EVAL_DIR = resolve(DATA_DIR, 'eval')
const MAX_CUSTOMERS = 10

// ── Types ────────────────────────────────────────────────────────────────────

interface EvalResult {
  customer: string
  slug: string
  deterministicTop5: Array<{ name: string; parentTdp: string; score: number }>
  geminiTop5: Array<{ name: string; parentTdp: string; confidence: string; reasoning: string }>
  overlap: string[]
  geminiNovel: string[]
  deterministicNovel: string[]
  graphSummaryTokenEstimate: number
  error?: string
}

interface EvalReport {
  timestamp: string
  customerCount: number
  results: EvalResult[]
  summary: {
    avgOverlap: number
    avgGeminiNovel: number
    avgDeterministicNovel: number
    customersWithErrors: number
  }
}

// ── Customer Graph Discovery ─────────────────────────────────────────────────

/**
 * Find customer graphs from local data directory.
 * Looks for intelligence-graph.json files in data/cache/{slug}/ dirs.
 */
function discoverLocalGraphs(): Array<{ slug: string; graph: CustomerGraph }> {
  const results: Array<{ slug: string; graph: CustomerGraph }> = []

  if (!existsSync(CACHE_DIR)) {
    console.warn(`[eval] Cache directory not found: ${CACHE_DIR}`)
    return results
  }

  const entries = readdirSync(CACHE_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const graph = loadGraph(entry.name, CACHE_DIR)
    if (graph && Object.keys(graph.nodes).length > 2) {
      results.push({ slug: entry.name, graph })
    }
  }

  return results
}

/**
 * Try to fetch customer graphs from the running API.
 * Falls back to local discovery if API is unavailable.
 */
async function discoverGraphsViaApi(): Promise<Array<{ slug: string; graph: CustomerGraph }>> {
  try {
    const res = await fetch(`${BASE_URL}/api/admin/graph/density`)
    if (!res.ok) return []

    const data = await res.json() as any
    const customerSlugs = (data.customers ?? [])
      .filter((c: any) => c.nodeCount > 2)
      .sort((a: any, b: any) => b.nodeCount - a.nodeCount)
      .slice(0, MAX_CUSTOMERS)
      .map((c: any) => c.slug)

    const results: Array<{ slug: string; graph: CustomerGraph }> = []
    for (const slug of customerSlugs) {
      const graphRes = await fetch(`${BASE_URL}/api/customer/${slug}/graph`)
      if (graphRes.ok) {
        const graph = await graphRes.json() as CustomerGraph
        results.push({ slug, graph })
      }
    }
    return results
  } catch {
    return []
  }
}

// ── Tactic Portfolio Loading ─────────────────────────────────────────────────

interface AvailableTactic {
  name: string
  parentTdp: string
  description?: string
  assets: Array<{ name: string; url: string; type: string }>
}

/**
 * Load all available tactics from saleshub-knowledge.json.
 */
function loadAllTactics(): AvailableTactic[] {
  const paths = [
    resolve(CONFIG_DIR, 'saleshub-knowledge.json'),
    resolve(import.meta.dir, '../config-templates/saleshub-knowledge.json'),
  ]

  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const kb = JSON.parse(readFileSync(p, 'utf-8'))
      return (kb.tactics ?? []).map((t: any) => ({
        name: t.name,
        parentTdp: t.parentTdp,
        description: t.talkTrack?.slice(0, 100) || undefined,
        assets: (t.whatToShare ?? []).filter((a: any) => a.url),
      }))
    } catch {
      continue
    }
  }

  console.error('[eval] Could not load saleshub-knowledge.json from any path')
  return []
}

// ── Evaluation ───────────────────────────────────────────────────────────────

async function evaluateCustomer(
  slug: string,
  graph: CustomerGraph,
  allTactics: AvailableTactic[],
): Promise<EvalResult> {
  const result: EvalResult = {
    customer: graph.customerName,
    slug,
    deterministicTop5: [],
    geminiTop5: [],
    overlap: [],
    geminiNovel: [],
    deterministicNovel: [],
    graphSummaryTokenEstimate: 0,
  }

  try {
    // 1. Deterministic path
    const scored = scoreTactics(graph, allTactics)
    scored.sort((a, b) => b.compositeScore - a.compositeScore)
    result.deterministicTop5 = scored.slice(0, 5).map(t => ({
      name: t.name,
      parentTdp: t.parentTdp,
      score: Math.round(t.compositeScore * 100) / 100,
    }))

    // 2. Gemini path
    const graphSummary = summarizeGraph(graph)
    // Rough token estimate: ~4 chars per token
    result.graphSummaryTokenEstimate = Math.ceil(graphSummary.length / 4)

    const geminiRecs = await recommendTactics(
      graphSummary,
      allTactics.map(t => ({ name: t.name, parentTdp: t.parentTdp, description: t.description })),
      graph.customerName,
    )
    result.geminiTop5 = geminiRecs.map(r => ({
      name: r.tacticName,
      parentTdp: r.parentTdp,
      confidence: r.confidence,
      reasoning: r.reasoning.slice(0, 200),
    }))

    // 3. Compute overlap and novelty
    const detNames = new Set(result.deterministicTop5.map(t => t.name.toLowerCase()))
    const gemNames = new Set(result.geminiTop5.map(t => t.name.toLowerCase()))

    result.overlap = result.geminiTop5
      .filter(t => detNames.has(t.name.toLowerCase()))
      .map(t => t.name)

    result.geminiNovel = result.geminiTop5
      .filter(t => !detNames.has(t.name.toLowerCase()))
      .map(t => t.name)

    result.deterministicNovel = result.deterministicTop5
      .filter(t => !gemNames.has(t.name.toLowerCase()))
      .map(t => t.name)
  } catch (err: any) {
    result.error = err.message ?? String(err)
    console.error(`[eval] Error evaluating ${slug}: ${result.error}`)
  }

  return result
}

// ── Output ───────────────────────────────────────────────────────────────────

function printTable(results: EvalResult[]): void {
  console.log('\n' + '='.repeat(120))
  console.log('GEMINI vs DETERMINISTIC — Blind Evaluation')
  console.log('='.repeat(120))

  const header = [
    'Customer'.padEnd(25),
    'Deterministic Top 3'.padEnd(35),
    'Gemini Top 3'.padEnd(35),
    'Overlap'.padEnd(8),
    'Gemini Novel'.padEnd(15),
  ].join(' | ')

  console.log(header)
  console.log('-'.repeat(120))

  for (const r of results) {
    if (r.error) {
      console.log(`${r.customer.padEnd(25)} | ERROR: ${r.error.slice(0, 90)}`)
      continue
    }

    const detTop3 = r.deterministicTop5.slice(0, 3).map(t => t.name).join(', ')
    const gemTop3 = r.geminiTop5.slice(0, 3).map(t => t.name).join(', ')
    const overlapCount = `${r.overlap.length}/5`
    const novelCount = `${r.geminiNovel.length}`

    console.log([
      r.customer.slice(0, 25).padEnd(25),
      detTop3.slice(0, 35).padEnd(35),
      gemTop3.slice(0, 35).padEnd(35),
      overlapCount.padEnd(8),
      novelCount.padEnd(15),
    ].join(' | '))
  }

  console.log('='.repeat(120))
}

function printSummary(report: EvalReport): void {
  console.log('\nSUMMARY')
  console.log('-'.repeat(50))
  console.log(`Customers evaluated: ${report.customerCount}`)
  console.log(`Avg overlap (of 5):  ${report.summary.avgOverlap.toFixed(1)}`)
  console.log(`Avg Gemini novel:    ${report.summary.avgGeminiNovel.toFixed(1)}`)
  console.log(`Avg Det. novel:      ${report.summary.avgDeterministicNovel.toFixed(1)}`)
  console.log(`Errors:              ${report.summary.customersWithErrors}`)
  console.log()
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[eval] Starting Gemini vs Deterministic blind evaluation...')

  // 1. Load all available tactics
  const allTactics = loadAllTactics()
  if (allTactics.length === 0) {
    console.error('[eval] No tactics found. Ensure saleshub-knowledge.json exists.')
    process.exit(1)
  }
  console.log(`[eval] Loaded ${allTactics.length} available tactics`)

  // 2. Discover customer graphs
  console.log('[eval] Discovering customer graphs...')
  let customers = discoverLocalGraphs()

  if (customers.length === 0) {
    console.log('[eval] No local graphs found, trying API...')
    customers = await discoverGraphsViaApi()
  }

  if (customers.length === 0) {
    console.error('[eval] No customer graphs found (local or API). Run from the container or set BASE_URL.')
    process.exit(1)
  }

  // Limit to MAX_CUSTOMERS, preferring graphs with more nodes
  customers.sort((a, b) => Object.keys(b.graph.nodes).length - Object.keys(a.graph.nodes).length)
  customers = customers.slice(0, MAX_CUSTOMERS)
  console.log(`[eval] Found ${customers.length} customer graphs`)

  // 3. Run evaluation for each customer
  const results: EvalResult[] = []
  for (const { slug, graph } of customers) {
    console.log(`[eval] Evaluating ${graph.customerName} (${slug})...`)
    const result = await evaluateCustomer(slug, graph, allTactics)
    results.push(result)

    // Small delay between Gemini calls to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000))
  }

  // 4. Build report
  const successResults = results.filter(r => !r.error)
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    customerCount: results.length,
    results,
    summary: {
      avgOverlap: successResults.length > 0
        ? successResults.reduce((sum, r) => sum + r.overlap.length, 0) / successResults.length
        : 0,
      avgGeminiNovel: successResults.length > 0
        ? successResults.reduce((sum, r) => sum + r.geminiNovel.length, 0) / successResults.length
        : 0,
      avgDeterministicNovel: successResults.length > 0
        ? successResults.reduce((sum, r) => sum + r.deterministicNovel.length, 0) / successResults.length
        : 0,
      customersWithErrors: results.filter(r => r.error).length,
    },
  }

  // 5. Output
  printTable(results)
  printSummary(report)

  // 6. Save results
  if (!existsSync(EVAL_DIR)) {
    mkdirSync(EVAL_DIR, { recursive: true })
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = resolve(EVAL_DIR, `gemini-vs-deterministic-${timestamp}.json`)
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`[eval] Results saved to ${outPath}`)
}

main().catch(err => {
  console.error('[eval] Fatal error:', err)
  process.exit(1)
})
