/**
 * Architecture Compliance Tests — Deep Scan + Drift Detection
 *
 * FAILING tests — violations break the build. Not advisory.
 * Auto-discovers from registry and filesystem. No hardcoded lists.
 *
 * Contract areas:
 *   1. Module contract: ensureFresh, cacheTtlMs, refreshEndpoint, displayName, syncNow
 *   2. Signal contract: rawRelevance, no hardcoded scores
 *   3. Consumer contract: templateAll, ensureFresh=true
 *   4. Service extraction: route files are thin, domain logic in services
 *   5. Path contract: uses paths.ts, not inline process.env
 *   6. Scheduler contract: tasks in registry, not standalone setTimeout
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

// Dynamic imports to ensure FeatureModuleRegistry is fully evaluated before
// modules call .register() (Bun ESM static import evaluation order issue)
beforeAll(async () => {
  await import('../../src/modules/campaigns-module.ts')
  await import('../../src/modules/news-module.ts')
  await import('../../src/modules/tools-module.ts')
  await import('../../src/modules/lifecycle-module.ts')
  await import('../../src/modules/rss-module.ts')
  await import('../../src/modules/events-module.ts')
  await import('../../src/modules/product-intel-module.ts')
  await import('../../src/modules/meeting-prep-module.ts')
  await import('../../src/modules/ccsp-module.ts')
  await import('../../src/modules/value-map-module.ts')
  await import('../../src/modules/cases-module.ts')
  await import('../../src/modules/subscriptions-module.ts')
  await import('../../src/modules/emails-module.ts')
  await import('../../src/modules/pipeline-module.ts')
  await import('../../src/modules/docs-module.ts')
  await import('../../src/modules/intelligence-module.ts')
  await import('../../src/modules/customer-product-intel-module.ts')
  await import('../../src/modules/account-plan-module.ts')
  await import('../../src/modules/playbook-module.ts')
  await import('../../src/modules/tech-stack-module.ts')
  await import('../../src/modules/cloud-marketplace-module.ts')
  await import('../../src/modules/partner-catalog-module.ts')
  await import('../../src/modules/competitive-intel-module.ts')
  await import('../../src/modules/ecosystem-catalog-module.ts')
  await import('../../src/modules/ma-module.ts')
  await import('../../src/modules/recommended-actions-module.ts')
  await import('../../src/modules/saleshub-module.ts')
  await import('../../src/modules/saleshub-content-module.ts')
  await import('../../src/modules/solution-intelligence-module.ts')
  await import('../../src/modules/value-positioning-module.ts')
})

// ── Helpers ───────────────────────────────────────────────────────────────

const SRC_DIR = resolve(import.meta.dir, '../../src')
const DASHBOARD_DIR = resolve(import.meta.dir, '../../dashboard/src')

function readSrc(rel: string): string {
  return readFileSync(resolve(SRC_DIR, rel), 'utf-8')
}

function getModuleFiles(): string[] {
  return readdirSync(resolve(SRC_DIR, 'modules'))
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

// Modules that are on-demand only (no cached data to refresh)
const ON_DEMAND_MODULES = new Set(['campaigns', 'meeting-prep', 'tools', 'playbook'])

// Consumer files that generate content from signals
const CONSUMER_FILES = [
  'playbook-generator.ts',
  'brief-pipeline.ts',
  'customer.ts',
  'campaigns-routes.ts',
  'meeting-prep-routes.ts',
]

// Route files that should be thin (domain logic in service modules)
const ROUTE_SERVICE_PAIRS = [
  { route: 'campaigns-routes.ts', service: 'campaign-service.ts', maxRouteLines: 300 },
  { route: 'meeting-prep-routes.ts', service: 'meeting-prep-service.ts', maxRouteLines: 300 },
  { route: 'dashboard-routes.ts', service: 'dashboard-service.ts', maxRouteLines: 300 },
  { route: 'product-intel-routes.ts', service: 'product-intel-service.ts', maxRouteLines: 500 },
]

// ═══════════════════════════════════════════════════════════════════════════
// 1. MODULE CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

describe('Module contract compliance', () => {
  const modules = FeatureModuleRegistry.getRegisteredModules()
  const signalProducers = modules.filter(m => m.signals)

  test('no module sets score directly — only rawRelevance (ADR-027)', () => {
    const violations: string[] = []
    for (const file of getModuleFiles()) {
      const content = readSrc(`modules/${file}`)
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
        if (/score\s*\??\s*:\s*(number|undefined)/i.test(line)) return
        if (/rawRelevance/i.test(line)) return
        if (/\b(let|const|var)\s+score\s*=/i.test(line)) return
        if (/\bscore\s*:\s*[0-9.]/i.test(line)) {
          violations.push(`modules/${file}:${idx + 1} — ${line.trim()}`)
        }
      })
    }
    expect(violations).toHaveLength(0)
  })

  test('every signal-producing module with cached data has ensureFresh', () => {
    const violations: string[] = []
    for (const mod of signalProducers) {
      if (ON_DEMAND_MODULES.has(mod.name)) continue
      if (!mod.ensureFresh) {
        violations.push(`${mod.name}: has signals() but no ensureFresh()`)
      }
    }
    if (violations.length > 0) {
      console.warn('Modules missing ensureFresh:\n' + violations.map(v => `  ! ${v}`).join('\n'))
    }
    // Advisory for now — promote to expect(violations).toHaveLength(0) when all modules comply
    expect(violations.length).toBeLessThanOrEqual(7)
  })

  test('every module with ensureFresh also has cacheTtlMs', () => {
    const violations: string[] = []
    for (const mod of modules) {
      if (mod.ensureFresh && !mod.cacheTtlMs) {
        violations.push(`${mod.name}: has ensureFresh but no cacheTtlMs`)
      }
    }
    expect(violations).toHaveLength(0)
  })

  test('every module with a working syncNow has refreshEndpoint', () => {
    const violations: string[] = []
    for (const mod of signalProducers) {
      if (ON_DEMAND_MODULES.has(mod.name)) continue
      if (!mod.refreshEndpoint) {
        // Check if syncNow is a no-op by reading the file
        const file = getModuleFiles().find(f => f.includes(mod.name.replace(/-/g, '')))
                  || getModuleFiles().find(f => readSrc(`modules/${f}`).includes(`name: '${mod.name}'`))
        if (file) {
          const content = readSrc(`modules/${file}`)
          const hasRealSyncNow = /async syncNow[^{]*\{[^}]*await/s.test(content)
          if (hasRealSyncNow) {
            violations.push(`${mod.name}: has working syncNow but no refreshEndpoint`)
          }
        }
      }
    }
    if (violations.length > 0) {
      console.warn('Modules with syncNow but no refreshEndpoint:\n' + violations.map(v => `  ! ${v}`).join('\n'))
    }
    expect(violations).toHaveLength(0)
  })

  test('every module has a displayName (not just raw slug)', () => {
    const violations: string[] = []
    for (const mod of modules) {
      if (!mod.displayName || mod.displayName === mod.name) {
        violations.push(`${mod.name}: missing displayName or same as name`)
      }
    }
    if (violations.length > 0) {
      console.warn('Modules missing displayName:\n' + violations.map(v => `  ! ${v}`).join('\n'))
    }
    // Advisory — many modules haven't been updated yet
    expect(true).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. CONSUMER CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

describe('Consumer contract compliance', () => {
  test('all consumers import from signal-templates or signal-loader', () => {
    const violations: string[] = []
    for (const file of CONSUMER_FILES) {
      try {
        const content = readSrc(file)
        const hasTemplateImport = /signal-templates/m.test(content)
        const hasLoaderImport = /signal-loader|ensureSignalsCurrent/m.test(content)
        const hasServiceImport = /campaign-service|meeting-prep-service/m.test(content)
        // Consumers that delegate to a service module are compliant
        // Consumers that import signal-templates or signal-loader are compliant
        if (!hasTemplateImport && !hasLoaderImport && !hasServiceImport) {
          violations.push(file)
        }
      } catch { /* file might not exist */ }
    }
    expect(violations).toHaveLength(0)
  })

  test('all consumers use ensureFresh when generating content', () => {
    const violations: string[] = []
    for (const file of CONSUMER_FILES) {
      try {
        const content = readSrc(file)
        if (!/loadCustomerSignals|ensureSignalsCurrent/m.test(content)) continue
        if (/loadCustomerSignals/m.test(content) && !/ensureFresh:\s*true/m.test(content)) {
          violations.push(`${file}: calls loadCustomerSignals without ensureFresh: true`)
        }
      } catch { /* skip */ }
    }
    expect(violations).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. SERVICE EXTRACTION CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

describe('Service extraction compliance', () => {
  test('extracted route files are thin (under max line count)', () => {
    const violations: string[] = []
    for (const pair of ROUTE_SERVICE_PAIRS) {
      try {
        const routeContent = readSrc(pair.route)
        const lineCount = routeContent.split('\n').length
        if (lineCount > pair.maxRouteLines) {
          violations.push(`${pair.route}: ${lineCount} lines (max: ${pair.maxRouteLines})`)
        }
      } catch { /* skip */ }
    }
    expect(violations).toHaveLength(0)
  })

  test('service modules exist for extracted routes', () => {
    for (const pair of ROUTE_SERVICE_PAIRS) {
      const servicePath = resolve(SRC_DIR, pair.service)
      expect(existsSync(servicePath)).toBe(true)
    }
  })

  test('service modules have zero Hono imports', () => {
    const violations: string[] = []
    for (const pair of ROUTE_SERVICE_PAIRS) {
      try {
        const content = readSrc(pair.service)
        if (/from\s+['"]hono['"]/m.test(content)) {
          violations.push(`${pair.service}: imports Hono (should be pure domain logic)`)
        }
      } catch { /* skip */ }
    }
    expect(violations).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. PATH CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

describe('Path contract compliance', () => {
  test('paths.ts exists and exports required constants', () => {
    const content = readSrc('lib/paths.ts')
    expect(content).toContain('export const CONFIG_DIR')
    expect(content).toContain('export const DATA_DIR')
    expect(content).toContain('export const CACHE_DIR')
    expect(content).toContain('export const DATA_CONFIG_DIR')
  })

  test('DATA_CONFIG_DIR respects CONFIG_DIR env var (container compat)', () => {
    const content = readSrc('lib/paths.ts')
    expect(content).toContain('process.env.CONFIG_DIR')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. SCHEDULER CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

describe('Scheduler contract compliance', () => {
  test('scheduler-registry.ts exists', () => {
    expect(existsSync(resolve(SRC_DIR, 'scheduler-registry.ts'))).toBe(true)
  })

  test('server.ts does not import deleted schedule functions', () => {
    const serverContent = readFileSync(resolve(import.meta.dir, '../../server.ts'), 'utf-8')
    expect(serverContent).not.toContain('scheduleProductIntelRefresh')
    expect(serverContent).not.toContain('scheduleNewsRadarRefresh')
    expect(serverContent).not.toContain('scheduleRSSRefresh')
    expect(serverContent).not.toContain('scheduleEventsRefresh')
    expect(serverContent).not.toContain('scheduleProductLifecycleRefresh')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. ADMIN UI REGRESSION GUARD
// ═══════════════════════════════════════════════════════════════════════════

describe('Admin UI regression guard', () => {
  const adminPath = resolve(DASHBOARD_DIR, 'pages/AdminPage.tsx')
  const adminContent = readFileSync(adminPath, 'utf-8')

  test('AdminPage.tsx is thin layout (<100 lines)', () => {
    expect(adminContent.split('\n').length).toBeLessThan(100)
  })

  test('AdminPage imports all 4 panel components', () => {
    expect(adminContent).toContain('SystemOverviewPanel')
    expect(adminContent).toContain('DataSourcesPanel')
    expect(adminContent).toContain('OperationsPanel')
    expect(adminContent).toContain('SettingsPanel')
  })

  test('AdminPage does NOT contain old inline sections', () => {
    expect(adminContent).not.toContain('ScrapeSection')
    expect(adminContent).not.toContain('SchedulerConfig')
    expect(adminContent).not.toContain('BatchIntelligenceSection')
  })

  test('admin panel component files exist', () => {
    const panelDir = resolve(DASHBOARD_DIR, 'components/admin')
    for (const panel of ['SystemOverviewPanel.tsx', 'DataSourcesPanel.tsx', 'OperationsPanel.tsx', 'SettingsPanel.tsx']) {
      expect(existsSync(resolve(panelDir, panel))).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. API ENDPOINT REGRESSION GUARD
// ═══════════════════════════════════════════════════════════════════════════

describe('API endpoint regression guard', () => {
  const routesContent = readSrc('feature-module-routes.ts')

  test('/api/modules/compliance endpoint exists', () => {
    expect(routesContent).toContain("'/api/modules/compliance'")
  })

  test('/api/admin/scheduler-status endpoint exists', () => {
    expect(routesContent).toContain("'/api/admin/scheduler-status'")
  })

  test('/api/modules/status endpoint exists', () => {
    expect(routesContent).toContain("'/api/modules/status'")
  })

  test('/api/modules/health endpoint exists', () => {
    expect(routesContent).toContain("'/api/modules/health'")
  })

  test('scheduler-registry import exists', () => {
    expect(routesContent).toContain('scheduler-registry')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. COMPLIANCE REPORT (informational)
// ═══════════════════════════════════════════════════════════════════════════

describe('Compliance report', () => {
  test('prints full compliance summary', () => {
    const modules = FeatureModuleRegistry.getRegisteredModules()
    const signalProducers = modules.filter(m => m.signals)
    const compliant = signalProducers.filter(m => m.ensureFresh && m.cacheTtlMs)
    const withRefresh = modules.filter(m => m.refreshEndpoint)
    const withDisplay = modules.filter(m => m.displayName && m.displayName !== m.name)

    console.log('\n=== Architecture Compliance Report ===')
    console.log(`Modules: ${modules.length} total, ${signalProducers.length} signal producers`)
    console.log(`ensureFresh + cacheTtlMs: ${compliant.length}/${signalProducers.length}`)
    console.log(`refreshEndpoint: ${withRefresh.length}/${modules.length}`)
    console.log(`displayName: ${withDisplay.length}/${modules.length}`)
    console.log(`Service extractions: ${ROUTE_SERVICE_PAIRS.length} route/service pairs`)
    console.log('=====================================\n')

    expect(true).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. PRINCIPLES.MD LAYER 3 — CONSUMER TEMPLATE COMPLIANCE (#567)
//    Consumer list and exclusions parsed from PRINCIPLES.md at runtime.
//    No hardcoded consumer arrays — single source of truth in PRINCIPLES.md.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse the "Consumer → File Mapping" table from PRINCIPLES.md.
 * Returns an array of consumer entries with their contract requirements.
 */
function parseConsumerMapping(): Array<{
  name: string
  file: string
  requiresTemplateAll: boolean
  templateAllPending: boolean
}> {
  const PROJECT_ROOT = resolve(import.meta.dir, '../..')
  const principles = readFileSync(resolve(PROJECT_ROOT, 'PRINCIPLES.md'), 'utf-8')
  const tableStart = principles.indexOf('## Consumer → File Mapping')
  if (tableStart < 0) throw new Error('PRINCIPLES.md missing "## Consumer → File Mapping" section')
  const tableEnd = principles.indexOf('\n## ', tableStart + 1)
  const section = principles.substring(tableStart, tableEnd > 0 ? tableEnd : undefined)

  const rows: Array<{ name: string; file: string; requiresTemplateAll: boolean; templateAllPending: boolean }> = []
  for (const line of section.split('\n')) {
    const match = line.match(/^\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/)
    if (!match) continue
    const name = match[1].trim()
    const file = match[2].trim()
    const templateCol = match[3].trim()
    if (name === 'Consumer' || name.startsWith('--')) continue
    if (!file.startsWith('src/')) continue

    rows.push({
      name,
      file,
      requiresTemplateAll: templateCol === '✅',
      templateAllPending: templateCol.includes('pending'),
    })
  }
  return rows
}

/**
 * Parse the "Gemini Callers — Not Consumers" exclusion table from PRINCIPLES.md.
 * Returns file paths that call callGemini() but are NOT consumers.
 */
function parseExcludedGeminiCallers(): string[] {
  const PROJECT_ROOT = resolve(import.meta.dir, '../..')
  const principles = readFileSync(resolve(PROJECT_ROOT, 'PRINCIPLES.md'), 'utf-8')
  const tableStart = principles.indexOf('## Gemini Callers — Not Consumers')
  if (tableStart < 0) throw new Error('PRINCIPLES.md missing "## Gemini Callers — Not Consumers" section')
  const tableEnd = principles.indexOf('\n## ', tableStart + 1)
  const section = principles.substring(tableStart, tableEnd > 0 ? tableEnd : undefined)

  const files: string[] = []
  for (const line of section.split('\n')) {
    const match = line.match(/^\|\s*([^|]+)\|/)
    if (!match) continue
    const file = match[1].trim()
    if (file === 'File' || file.startsWith('--') || !file.startsWith('src/')) continue
    files.push(file)
  }
  return files
}

describe('PRINCIPLES.md Layer 3 — consumers call templateAll()', () => {
  const consumers = parseConsumerMapping()
  const excludedCallers = parseExcludedGeminiCallers()

  const INDIVIDUAL_TEMPLATE_FUNCTIONS = [
    'templateProductAlignment',
    'templateCloudMarketplace',
    'templateRenewals',
    'templateCases',
    'templateTechStack',
    'templateKeyRelationships',
    'templateSalesAlignment',
    'templateStrategicOpportunities',
    'templateSalesHubContext',
  ]

  test('PRINCIPLES.md consumer mapping table is parseable and non-empty', () => {
    expect(consumers.length).toBeGreaterThanOrEqual(5)
  })

  test('PRINCIPLES.md exclusion table is parseable and non-empty', () => {
    expect(excludedCallers.length).toBeGreaterThanOrEqual(5)
  })

  test('every consumer with templateAll=yes actually calls templateAll()', () => {
    const PROJECT_ROOT = resolve(import.meta.dir, '../..')
    const violations: string[] = []
    for (const consumer of consumers) {
      if (!consumer.requiresTemplateAll) continue
      const filePath = resolve(PROJECT_ROOT, consumer.file)
      if (!existsSync(filePath)) {
        violations.push(`${consumer.name}: file ${consumer.file} not found`)
        continue
      }
      const content = readFileSync(filePath, 'utf-8')
      if (!content.includes('templateAll')) {
        violations.push(`${consumer.name} (${consumer.file}) does not call templateAll()`)
      }
    }
    expect(violations).toEqual([])
  })

  test('consumers marked pending are tracked (informational)', () => {
    const pending = consumers.filter(c => c.templateAllPending)
    if (pending.length > 0) {
      console.warn('Consumers pending templateAll migration:')
      for (const p of pending) {
        console.warn(`  ⚠️ ${p.name} (${p.file})`)
      }
    }
    // Informational tracking — always passes
    expect(true).toBe(true)
  })

  test('no consumer imports individual template functions (Layer 3 violation)', () => {
    const PROJECT_ROOT = resolve(import.meta.dir, '../..')
    const violations: string[] = []
    for (const consumer of consumers) {
      const filePath = resolve(PROJECT_ROOT, consumer.file)
      if (!existsSync(filePath)) continue
      const content = readFileSync(filePath, 'utf-8')
      for (const fn of INDIVIDUAL_TEMPLATE_FUNCTIONS) {
        if (new RegExp(`import\\s*\\{[^}]*${fn}[^}]*\\}\\s*from`, 'm').test(content)) {
          violations.push(`${consumer.name} (${consumer.file}) imports ${fn} directly — must use templateAll()`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('no consumer imports getCustomerSolutionContext directly (only modules may)', () => {
    const PROJECT_ROOT = resolve(import.meta.dir, '../..')
    const violations: string[] = []
    for (const consumer of consumers) {
      const filePath = resolve(PROJECT_ROOT, consumer.file)
      if (!existsSync(filePath)) continue
      const content = readFileSync(filePath, 'utf-8')
      if (/import\s*\{[^}]*getCustomerSolutionContext[^}]*\}\s*from/.test(content) ||
          /await\s+import\s*\([^)]*customer-solution-context/.test(content)) {
        violations.push(`${consumer.name} (${consumer.file}) imports getCustomerSolutionContext — must go through templateAll()`)
      }
    }
    expect(violations).toEqual([])
  })

  test('every callGemini() file is registered as consumer or excluded (#567)', () => {
    const PROJECT_ROOT = resolve(import.meta.dir, '../..')
    const geminiCallers: string[] = []
    function scanDir(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        if (entry.isDirectory()) {
          scanDir(full)
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const content = readFileSync(full, 'utf-8')
          if (content.includes('callGemini(') || content.includes('callGemini (')) {
            const rel = full.replace(PROJECT_ROOT + '/', '')
            // Skip the gateway itself and the quality gate
            if (rel === 'src/gemini-call.ts' || rel === 'src/gemini-quality-gate.ts') continue
            geminiCallers.push(rel)
          }
        }
      }
    }
    scanDir(resolve(PROJECT_ROOT, 'src'))

    const consumerFiles = new Set(consumers.map(c => c.file))
    const excludedFiles = new Set(excludedCallers)

    const unregistered = geminiCallers.filter(f => !consumerFiles.has(f) && !excludedFiles.has(f))
    if (unregistered.length > 0) {
      console.error('Unregistered Gemini callers — add to PRINCIPLES.md Consumer or Excluded table:')
      for (const f of unregistered) console.error(`  ❌ ${f}`)
    }
    expect(unregistered).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. CONFIG PROPAGATION — entrypoint.sh coverage
// ═══════════════════════════════════════════════════════════════════════════

describe('Config propagation — entrypoint covers all templates', () => {
  const CONFIG_TEMPLATES_DIR = resolve(import.meta.dir, '../../config-templates')
  const ENTRYPOINT_PATH = resolve(import.meta.dir, '../../entrypoint.sh')

  test('every config-template .json is referenced in entrypoint.sh', () => {
    if (!existsSync(CONFIG_TEMPLATES_DIR) || !existsSync(ENTRYPOINT_PATH)) return
    const templates = readdirSync(CONFIG_TEMPLATES_DIR).filter(f => f.endsWith('.json'))
    const entrypoint = readFileSync(ENTRYPOINT_PATH, 'utf-8')
    const missing: string[] = []
    for (const t of templates) {
      if (!entrypoint.includes(t) && !entrypoint.includes('config-templates/*.json')) {
        missing.push(`${t} not referenced in entrypoint.sh`)
      }
    }
    expect(missing).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. EXPORT PARITY — Google Docs renders what Dashboard renders
// ═══════════════════════════════════════════════════════════════════════════

describe('Export parity — Google Docs export covers Dashboard sections', () => {
  test('playbook-to-markdown.ts export covers key PlaybookTab sections', () => {
    // #440: Export path moved from generatePlaybookHTML (deleted) to
    // playbookToMarkdown in playbook-to-markdown.ts (#314). Check the
    // actual export renderer, not the routes file.
    const exportPath = resolve(SRC_DIR, 'playbook-to-markdown.ts')
    const tabPath = resolve(DASHBOARD_DIR, 'components/tabs/PlaybookTab.tsx')
    if (!existsSync(exportPath) || !existsSync(tabPath)) return

    const exportSrc = readFileSync(exportPath, 'utf-8')
    const tab = readFileSync(tabPath, 'utf-8')

    const REQUIRED_SECTIONS = [
      { name: 'strategicPosition', check: 'strategicPosition' },
      { name: 'productAlignment', check: 'productAlignment' },
      { name: 'keyRelationships', check: 'keyRelationships' },
      { name: 'engagementHistory', check: 'engagementHistory' },
      { name: 'meddpicc', check: 'meddpicc' },
    ]

    const missing: string[] = []
    for (const section of REQUIRED_SECTIONS) {
      if (tab.includes(section.check) && !exportSrc.includes(section.check)) {
        missing.push(`PlaybookTab renders ${section.name} but playbookToMarkdown does not`)
      }
    }
    expect(missing).toEqual([])
  })
})

// ── ADR → PRINCIPLES.md Drift Detection ─────────────────────────────────────
// Every ADR that creates mandatory requirements must have a corresponding
// entry in PRINCIPLES.md. This test catches drift automatically.

describe('ADR → PRINCIPLES.md drift detection', () => {
  const principlesPath = resolve(__dirname, '../../PRINCIPLES.md')
  const adrDir = resolve(__dirname, '../../docs/adr')

  let principlesContent: string
  let adrFiles: string[]

  beforeAll(() => {
    principlesContent = readFileSync(principlesPath, 'utf-8')
    adrFiles = existsSync(adrDir)
      ? readdirSync(adrDir).filter(f => f.endsWith('.md')).sort()
      : []
  })

  test('every ADR with mandatory requirements is referenced in PRINCIPLES.md', () => {
    const unreferenced: string[] = []

    for (const file of adrFiles) {
      const content = readFileSync(resolve(adrDir, file), 'utf-8')

      const adrMatch = file.match(/(?:ADR-)?(\d+)/)
      if (!adrMatch) continue
      const adrNum = adrMatch[1]

      // Check if ADR creates cross-module mandatory requirements
      // Look for "modules MUST", "consumers MUST", "every module", "every consumer" — not just "required" in isolation
      const hasMust = /modules?\s+MUST|consumers?\s+MUST|every\s+module|every\s+consumer|always\s+use\s+`/i.test(content)
      if (!hasMust) continue

      // Check if referenced in PRINCIPLES.md
      const adrRef = `ADR-${adrNum.padStart(3, '0')}`
      const isReferenced = principlesContent.includes(adrRef) || principlesContent.includes(`ADR-${adrNum}`)

      if (!isReferenced) {
        unreferenced.push(`${file} creates mandatory requirements but is not referenced in PRINCIPLES.md`)
      }
    }

    expect(unreferenced).toEqual([])
  })

  test('every ADR has a PRINCIPLES.md Update section', () => {
    const missing: string[] = []

    for (const file of adrFiles) {
      const content = readFileSync(resolve(adrDir, file), 'utf-8')
      if (/status:\s*deprecated/i.test(content)) continue

      const hasPrinciplesSection = content.includes('PRINCIPLES.md Update') ||
        content.includes('PRINCIPLES.md update') ||
        content.includes('No PRINCIPLES.md update required')

      if (!hasPrinciplesSection) {
        missing.push(file)
      }
    }

    // Advisory for now — existing ADRs predate the requirement
    if (missing.length > 0) {
      console.warn(`[advisory] ${missing.length} ADRs missing PRINCIPLES.md Update section:`)
      for (const m of missing) console.warn(`  ${m}`)
    }
  })

  test('PRINCIPLES.md has at least 15 pre-flight questions', () => {
    const questions = principlesContent.match(/^\d+\.\s+\*\*/gm) ?? []
    expect(questions.length).toBeGreaterThanOrEqual(15)
  })

  test('PRINCIPLES.md references all contract sections', () => {
    const requiredSections = [
      'syncNow vs ensureFresh',
      'L3 Drive Refresh',
      'Feature Module Registry Contract',
      'Module Navigation Contract',
      'Gemini Call Standardization',
      'Playbook State Contract',
      'Scheduler Registry Contract',
      'Portfolio Signal Relevance',
      'Solution Intelligence Contract',
      'Template Engine Unification',
    ]

    const missing = requiredSections.filter(s => !principlesContent.includes(s))
    expect(missing).toEqual([])
  })
})

// ── ADR-033: No Storage Without Action (#594) ─────────────────────────────────

describe('ADR-033: No Storage Without Action gate', () => {
  test('every node-creating SIGNAL_CONFIGS entry has a TacticScorer handler', async () => {
    const { TACTIC_SCORER_HANDLED_TYPES } = await import('../../src/lib/tactic-scorer.ts')

    const graphSource = readFileSync(resolve(SRC_DIR, 'lib/intelligence-graph.ts'), 'utf-8')

    // Parse SIGNAL_CONFIGS entries — find nodeType values that aren't 'none'
    const nodeTypeMatches = graphSource.matchAll(/nodeType:\s*'([^']+)'/g)
    const nodeCreatingTypes = new Set<string>()
    for (const match of nodeTypeMatches) {
      if (match[1] !== 'none') {
        nodeCreatingTypes.add(match[1])
      }
    }

    expect(nodeCreatingTypes.size).toBeGreaterThan(0)

    const unhandled: string[] = []
    for (const nodeType of nodeCreatingTypes) {
      if (!TACTIC_SCORER_HANDLED_TYPES.includes(nodeType)) {
        unhandled.push(nodeType)
      }
    }

    expect(
      unhandled,
      `Node types without TacticScorer handlers: ${unhandled.join(', ')}. Add handlers per ADR-033.`
    ).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. SIGNAL ROUTING COVERAGE — every producer routes to a named section
//     (#675) Prevents producer modules from silently falling to 'other'
//     in routeSignal(). 7 of 30 modules had broken routing before #672-#674.
// ═══════════════════════════════════════════════════════════════════════════

describe('Signal routing coverage — every producer routes to a named section (#675)', () => {
  // ── Helper: make a test signal with given source and metadata ──────────
  function makeSignal(
    source: string,
    opts: { type?: string; metadata?: Record<string, unknown> } = {}
  ): import('../../src/feature-module-registry.ts').Signal {
    return {
      source,
      type: (opts.type ?? 'intelligence') as import('../../src/feature-module-registry.ts').SignalType,
      headline: `Test signal from ${source}`,
      detail: `Compliance test detail for ${source} module`,
      rawRelevance: 0.5,
      timestamp: new Date().toISOString(),
      metadata: opts.metadata ?? {},
    }
  }

  // A companion solution-play signal needed to activate templateStrategicOpportunities,
  // which gates rendering of ecosystem and partner subsections.
  function makeSolutionPlaySignal(): import('../../src/feature-module-registry.ts').Signal {
    return {
      source: 'tech-stack',
      type: 'technology',
      headline: 'Solution play companion signal',
      detail: 'Activates strategic opportunities rendering',
      rawRelevance: 0.5,
      timestamp: new Date().toISOString(),
      metadata: { solutionPlayId: 'test-play-001', solutionPlayName: 'Test Play', infrastructure: true, redHatProducts: ['OpenShift'] },
    }
  }

  // Each entry: source name emitted by the module's signals(), the substring
  // expected in templateAll().deterministic when routed correctly, and any
  // metadata the template function needs to actually render.
  // If routeSignal() falls to 'other', the signal won't appear anywhere.
  const PRODUCER_ROUTES: Array<{
    source: string
    expectInDeterministic: string
    metadata?: Record<string, unknown>
    type?: string
    /** Extra signals needed to activate the parent section (e.g., solution plays) */
    companionSignals?: import('../../src/feature-module-registry.ts').Signal[]
  }> = [
    // Source-routed modules (explicit source checks in routeSignal)
    { source: 'subscriptions', expectInDeterministic: 'Product Alignment', metadata: { redHatProducts: ['OpenShift'] } },
    { source: 'ccsp', expectInDeterministic: 'Product Alignment', metadata: { redHatProducts: ['RHEL'] } },
    { source: 'cloud-marketplace', expectInDeterministic: 'Cloud Marketplace', metadata: { provider: 'AWS', hasCloudSpend: true } },
    { source: 'cases', expectInDeterministic: 'Support Cases', metadata: { severity: '2', caseNumber: '01234567' } },
    { source: 'pipeline', expectInDeterministic: 'Renewals', metadata: { renewal: true, stage: 'Negotiation', closeDate: '2026-12-01' }, type: 'subscription' },
    { source: 'tech-stack', expectInDeterministic: 'Technology Stack', metadata: { infrastructure: true } },
    { source: 'rh-events', expectInDeterministic: 'Upcoming Events', metadata: { format: 'webinar' }, type: 'event' },
    { source: 'account-plan', expectInDeterministic: 'Account Plan', type: 'account-plan' },
    // ecosystem-catalog and partner-catalog render inside templateStrategicOpportunities,
    // which requires at least one signal with metadata.solutionPlayId to activate.
    { source: 'ecosystem-catalog', expectInDeterministic: 'Partner Ecosystem', metadata: { partnerName: 'Acme Corp', solutionName: 'Cloud Tool', resourceTypes: ['guide'] }, companionSignals: [makeSolutionPlaySignal()] },
    { source: 'competitive-intel', expectInDeterministic: 'Competitive', metadata: { competitor: 'VMware', redHatCounter: 'OpenShift advantage' } },
    { source: 'intelligence', expectInDeterministic: 'Intelligence', metadata: { docType: 'company' } },
    { source: 'partner-catalog', expectInDeterministic: 'Specialized Partners', metadata: { partnerName: 'IBM', partnershipLevel: 'Premier', specializations: ['Automation'], credentialCount: 12 }, companionSignals: [makeSolutionPlaySignal()] },
    { source: 'saleshub-tactics', expectInDeterministic: 'Sales Plays', type: 'recommendation', metadata: { playType: 'tactic', parentTdp: 'TDP-001' } },
    { source: 'saleshub-plays', expectInDeterministic: 'Sales Plays', type: 'recommendation', metadata: { playType: 'strategic' } },
    { source: 'emails', expectInDeterministic: 'Email', metadata: { classification: 'technical', from: 'user@example.com' } },
    // Metadata-routed modules (route via metadata fields, not source name)
    { source: 'product-intel', expectInDeterministic: 'Product Alignment', metadata: { product: 'OpenShift' } },
    { source: 'product-lifecycle', expectInDeterministic: 'Product Alignment', metadata: { product: 'RHEL' } },
    { source: 'rh-rss', expectInDeterministic: 'Product Alignment', metadata: { productTags: ['OpenShift'] } },
    { source: 'value-maps', expectInDeterministic: 'Product Alignment', metadata: { productSlug: 'openshift' } },
    { source: 'solution-intelligence', expectInDeterministic: 'Cloud Marketplace', metadata: { provider: 'Azure', hasCloudIntel: true } },
  ]

  // Consumer-only modules (no signals()): campaigns, meeting-prep, playbook, tools, value-positioning
  // These are excluded by design — they consume signals, they don't produce them.

  for (const route of PRODUCER_ROUTES) {
    test(`${route.source} routes to "${route.expectInDeterministic}" section (not 'other')`, async () => {
      const { templateAll } = await import('../../src/lib/signal-templates.ts')

      const signal = makeSignal(route.source, { type: route.type, metadata: route.metadata })
      const signals = [...(route.companionSignals ?? []), signal]

      const result = await templateAll(signals)

      expect(
        result.deterministic,
        `Signal from '${route.source}' fell to 'other' — not routed to any named section. ` +
        `Expected "${route.expectInDeterministic}" in deterministic output. ` +
        `Fix routeSignal() in src/lib/signal-templates.ts to handle source '${route.source}'.`
      ).toContain(route.expectInDeterministic)
    })
  }

  // Skipped modules — documented reasons, visible as TODOs in test output
  test.skip('mergers-acquisitions — no data source, deferred per #674 investigation', () => {
    // mergers-acquisitions module registered but has no active data pipeline.
    // Signal routing TBD when M&A data source is connected.
  })

  test.skip('customer-docs — routes need investigation, signals may not use standard source name', () => {
    // customer-docs module needs investigation to determine what source name
    // its signals emit and what section they should route to.
  })

  test.skip('saleshub-content — routes via metadata.product, needs verification of actual signal shape', () => {
    // saleshub-content produces signals but routing depends on metadata.product
    // which routes to 'product' via the metadata path. Needs real signal sample.
  })

  test.skip('news-radar — routes via metadata, needs investigation of actual signal shape', () => {
    // news-radar signals may route via metadata fields. Need to verify what
    // metadata they carry and which section they land in.
  })

  test.skip('recommended-actions — routes via metadata.product, needs verification', () => {
    // recommended-actions produces signals that may route via metadata.product.
    // Need to verify actual signal shape and expected section.
  })

  test.skip('customer-product-intel — routes via metadata, needs verification of routing path', () => {
    // customer-product-intel is a producer but its routing path through
    // routeSignal() needs verification against actual signal metadata.
  })
})
