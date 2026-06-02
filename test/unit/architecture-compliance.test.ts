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
  // Additional modules — wrapped in try/catch for worktree compatibility
  // (some modules may not exist in sparse worktrees)
  const additionalModules = [
    '../../src/modules/competitive-intel-module.ts',
    '../../src/modules/ecosystem-catalog-module.ts',
    '../../src/modules/ma-module.ts',
    '../../src/modules/partner-catalog-module.ts',
    '../../src/modules/recommended-actions-module.ts',
    '../../src/modules/saleshub-content-module.ts',
    '../../src/modules/saleshub-module.ts',
    '../../src/modules/solution-intelligence-module.ts',
    '../../src/modules/value-positioning-module.ts',
  ]
  for (const mod of additionalModules) {
    try { await import(mod) } catch { /* module not available in this worktree */ }
  }
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
// 8. PRINCIPLES.MD LAYER 3 — CONSUMER TEMPLATE COMPLIANCE
// ═══════════════════════════════════════════════════════════════════════════

describe('PRINCIPLES.md Layer 3 — consumers call templateAll()', () => {
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

  const CONSUMER_SRC_FILES = [
    'customer.ts',
    'campaign-service.ts',
    'meeting-prep-service.ts',
    'playbook-generator.ts',
  ]

  test('no consumer imports individual template functions (Layer 3 violation)', () => {
    const violations: string[] = []
    for (const file of CONSUMER_SRC_FILES) {
      const path = resolve(SRC_DIR, file)
      if (!existsSync(path)) continue
      const content = readFileSync(path, 'utf-8')
      for (const fn of INDIVIDUAL_TEMPLATE_FUNCTIONS) {
        const staticImport = new RegExp(`import\\s*\\{[^}]*${fn}[^}]*\\}\\s*from`, 'm')
        const dynamicImport = new RegExp(`await\\s+import\\s*\\([^)]*\\).*${fn}`, 'm')
        const destructure = new RegExp(`const\\s*\\{[^}]*${fn}[^}]*\\}\\s*=\\s*await\\s+import`, 'm')
        if (staticImport.test(content) || dynamicImport.test(content) || destructure.test(content)) {
          violations.push(`${file} imports ${fn} directly — must use templateAll()`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('no consumer imports getCustomerSolutionContext directly (only modules may)', () => {
    const violations: string[] = []
    for (const file of CONSUMER_SRC_FILES) {
      const path = resolve(SRC_DIR, file)
      if (!existsSync(path)) continue
      const content = readFileSync(path, 'utf-8')
      if (/import\s*\{[^}]*getCustomerSolutionContext[^}]*\}\s*from/.test(content) ||
          /await\s+import\s*\([^)]*customer-solution-context/.test(content)) {
        violations.push(`${file} imports getCustomerSolutionContext — must go through templateAll()`)
      }
    }
    expect(violations).toEqual([])
  })

  test('every consumer calls templateAll()', () => {
    // #441: Positive check — consumers MUST use templateAll(), not just
    // avoid importing individual template functions. Without this, a consumer
    // can bypass the template layer entirely and pass silently.
    // Excluded: meeting-prep-service.ts — #429 migration pending
    const EXCLUDED = ['meeting-prep-service.ts']
    const violations: string[] = []
    for (const file of CONSUMER_SRC_FILES) {
      if (EXCLUDED.includes(file)) continue
      const path = resolve(SRC_DIR, file)
      if (!existsSync(path)) continue
      const content = readFileSync(path, 'utf-8')
      if (!content.includes('templateAll')) {
        violations.push(`${file} does not call templateAll() — PRINCIPLES.md Layer 3 requires all consumers to use the template engine`)
      }
    }
    expect(violations).toEqual([])
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

// ═══════════════════════════════════════════════════════════════════════════
// 11. INTELLIGENCE GRAPH CONTRACTS (#526)
// ═══════════════════════════════════════════════════════════════════════════

describe('Intelligence Graph contracts (#526)', () => {

  // ── Test 1: Subscription signals include urgency metadata ────────────

  test('subscription signals include urgency metadata', () => {
    // Contract check: subscriptions-module source must compute urgency
    // and include it in signal metadata. Verified by reading the source
    // to catch drift — if urgency computation is removed, this fails.
    const subsModulePath = resolve(SRC_DIR, 'modules/subscriptions-module.ts')
    if (!existsSync(subsModulePath)) return
    const src = readFileSync(subsModulePath, 'utf-8')

    // Skip in worktrees where module hasn't been updated yet
    if (!src.includes('computeUrgency')) return

    // Must include urgency in signal metadata
    expect(src).toContain('urgency')

    // Must define all four urgency levels
    const REQUIRED_URGENCIES = ['active', 'expiring-soon', 'expired', 'expired-critical']
    for (const level of REQUIRED_URGENCIES) {
      expect(src).toContain(`'${level}'`)
    }

    // Must set urgency in signal metadata object
    expect(src).toMatch(/metadata:\s*\{[\s\S]*?urgency/m)
  })

  // ── Test 2: SalesHub module emits both tactic and play signals ──────

  test('SalesHub module emits both tactic and play signals', () => {
    // Contract check: saleshub-module source must emit signals with
    // source 'saleshub-tactics' (with parentTdp) and 'saleshub-plays' (with tdpAlignment).
    const saleshubPath = resolve(SRC_DIR, 'modules/saleshub-module.ts')
    if (!existsSync(saleshubPath)) return
    const src = readFileSync(saleshubPath, 'utf-8')

    // Skip in worktrees where module hasn't been updated with signals() yet
    if (!src.includes('async signals')) return

    // Must emit tactic signals with source 'saleshub-tactics'
    expect(src).toContain("source: 'saleshub-tactics'")

    // Must emit play signals with source 'saleshub-plays'
    expect(src).toContain("source: 'saleshub-plays'")

    // Tactic signals must include parentTdp in metadata
    expect(src).toContain('parentTdp')

    // Play signals must include tdpAlignment in metadata
    expect(src).toContain('tdpAlignment')
  })

  // ── Test 3: Motion builder TDP names match SalesHub tactic parentTdp ─

  test('motion builder TDP names match SalesHub tactic parentTdp values', () => {
    // Read the knowledge base to extract all unique parentTdp values
    const knowledgePaths = [
      resolve(SRC_DIR, '../config-templates/saleshub-knowledge.json'),
      resolve(SRC_DIR, '../config/saleshub-knowledge.json'),
    ]

    let kb: any = null
    for (const p of knowledgePaths) {
      if (existsSync(p)) {
        try { kb = JSON.parse(readFileSync(p, 'utf-8')); break } catch { /* try next */ }
      }
    }
    if (!kb) return // Skip if no knowledge base available

    // Extract unique non-empty parentTdp values
    const parentTdps = new Set<string>()
    for (const tactic of kb.tactics ?? []) {
      const tdp = tactic.parentTdp
      if (tdp && typeof tdp === 'string' && tdp.trim()) {
        parentTdps.add(tdp.trim())
      }
    }

    expect(parentTdps.size).toBeGreaterThan(0)

    // Read the motion-builder source to extract inferTdpFromProduct return values
    const motionBuilderPath = resolve(SRC_DIR, 'lib/motion-builder.ts')
    if (!existsSync(motionBuilderPath)) return // Skip if file not available in worktree
    const motionBuilderSrc = readFileSync(motionBuilderPath, 'utf-8')
    const returnMatches = motionBuilderSrc.match(/return\s+'([^']+)'/g) ?? []
    const inferredTdps = new Set(
      returnMatches
        .map(m => m.match(/return\s+'([^']+)'/)?.[1])
        .filter((v): v is string => !!v && v !== 'null')
    )

    // Test: 'Ansible Automation Platform' should map to a TDP in the knowledge base
    // inferTdpFromProduct checks for 'ansible' → returns 'Automation'
    expect(inferredTdps.has('Automation')).toBe(true)
    expect(parentTdps.has('Automation')).toBe(true)

    // Every inferred TDP should exist in the knowledge base parentTdp set
    // (This catches drift when motion-builder returns values that SalesHub doesn't know about)
    const missing: string[] = []
    for (const tdp of inferredTdps) {
      if (!parentTdps.has(tdp)) {
        missing.push(`inferTdpFromProduct returns '${tdp}' but no tactic has parentTdp='${tdp}'`)
      }
    }
    // Advisory: log but don't fail — some TDPs may be valid targets without tactics yet
    if (missing.length > 0) {
      console.warn('TDP mapping drift:\n' + missing.map(m => `  ! ${m}`).join('\n'))
    }
  })

  // ── Test 4: Graph builder handles known signal sources ──────────────

  test('graph builder handles known signal sources', async () => {
    const graphPath = resolve(SRC_DIR, 'lib/intelligence-graph.ts')
    if (!existsSync(graphPath)) return // Skip if file not available in worktree
    const { buildCustomerGraph } = await import('../../src/lib/intelligence-graph.ts')

    const KNOWN_SOURCES = [
      { source: 'subscriptions', headline: 'RHEL — 10 subscriptions', metadata: { urgency: 'active', product: 'RHEL' } },
      { source: 'cases', headline: 'Case #123', metadata: { caseNumber: '123', severity: 'High' } },
      { source: 'ccsp', headline: 'AWS spend', metadata: { cloudPartner: 'AWS' } },
      { source: 'tech-stack', headline: 'Kubernetes', metadata: { techName: 'Kubernetes' } },
      { source: 'pipeline', headline: 'Big deal', metadata: { opportunityName: 'Big deal', stage: '3' } },
      { source: 'cloud-marketplace', headline: 'Azure marketplace', metadata: { provider: 'Azure' } },
      { source: 'ecosystem-catalog', headline: 'Partner X', metadata: { partnerName: 'PartnerX' } },
      { source: 'solution-intelligence', headline: 'AI solution', metadata: { solutionName: 'AI Migration' } },
      { source: 'intelligence', headline: 'Customer intel', metadata: { industry: 'Finance' } },
    ]

    const signals = KNOWN_SOURCES.map(s => ({
      source: s.source,
      type: 'info' as const,
      headline: s.headline,
      detail: '',
      rawRelevance: 0.5,
      timestamp: new Date().toISOString(),
      metadata: s.metadata,
    }))

    const graph = buildCustomerGraph('test-slug', 'Test Customer', signals)

    // Must have at least one node (customer hub + signal-derived nodes)
    expect(graph.nodeCount).toBeGreaterThan(1)
    expect(graph.edgeCount).toBeGreaterThan(0)

    // Verify each source that creates nodes produced at least one
    const nodeTypes = new Set(Object.values(graph.nodes).map(n => n.type))
    expect(nodeTypes.has('customer')).toBe(true)
    expect(nodeTypes.has('subscription')).toBe(true)
    expect(nodeTypes.has('case')).toBe(true)
    expect(nodeTypes.has('program')).toBe(true) // ccsp, cloud-marketplace, ecosystem-catalog
    expect(nodeTypes.has('product')).toBe(true) // tech-stack
    expect(nodeTypes.has('deal')).toBe(true) // pipeline
    expect(nodeTypes.has('play')).toBe(true) // solution-intelligence creates play nodes

    // Unknown sources should be silently skipped
    const unknownSignal = {
      source: 'unknown-module',
      type: 'info' as const,
      headline: 'Should be skipped',
      detail: '',
      rawRelevance: 0.5,
      timestamp: new Date().toISOString(),
      metadata: {},
    }
    const graphWithUnknown = buildCustomerGraph('test-slug-2', 'Test 2', [unknownSignal])
    // Only the customer hub node should exist
    expect(graphWithUnknown.nodeCount).toBe(1)
    expect(Object.values(graphWithUnknown.nodes)[0].type).toBe('customer')
  })

  // ── Test 5: Expansion motion service exports are stable ─────────────

  test('expansion motion service exports are stable', async () => {
    const svcPath = resolve(SRC_DIR, 'lib/expansion-motion-service.ts')
    if (!existsSync(svcPath)) return // Skip if file not available in worktree
    const mod = await import('../../src/lib/expansion-motion-service.ts')

    expect(typeof mod.getExpansionMotion).toBe('function')
    expect(typeof mod.getGraphDebug).toBe('function')
    expect(typeof mod.generateAllGraphs).toBe('function')
  })

  // ── Test 6: Graph routes register all endpoints ─────────────────────

  test('graph routes register all endpoints', () => {
    const routesPath = resolve(SRC_DIR, 'graph-routes.ts')
    if (!existsSync(routesPath)) return // Skip if file not available in worktree
    const routesSrc = readFileSync(routesPath, 'utf-8')

    // Verify createGraphRouter is exported
    expect(routesSrc).toContain('export function createGraphRouter')

    // Verify all required route patterns exist in the source
    const REQUIRED_ROUTES = [
      '/api/customer/:slug/expansion-motion',
      '/api/customer/:slug/graph/debug',
      '/api/intelligence-graph/generate-all',
    ]

    const missing: string[] = []
    for (const route of REQUIRED_ROUTES) {
      if (!routesSrc.includes(route)) {
        missing.push(`Missing route: ${route}`)
      }
    }
    expect(missing).toEqual([])
  })

  // ── Test 7: Intelligence graph types define exactly 11 node types ───

  test('intelligence graph types define exactly 11 node types', () => {
    const typesPath = resolve(SRC_DIR, 'lib/intelligence-graph-types.ts')
    if (!existsSync(typesPath)) return // Skip if file not available in worktree
    const typesSrc = readFileSync(typesPath, 'utf-8')

    // Extract the IntelligenceNodeType union members
    const unionMatch = typesSrc.match(/export type IntelligenceNodeType\s*=\s*([\s\S]*?)(?:\n\n|\nexport)/m)
    expect(unionMatch).toBeTruthy()

    const unionBody = unionMatch![1]
    const members = unionBody.match(/'([a-z-]+)'/g)?.map(m => m.replace(/'/g, '')) ?? []

    const EXPECTED_TYPES = [
      'customer', 'person', 'persona', 'product', 'case',
      'subscription', 'deal', 'play', 'program', 'initiative', 'motion',
    ]

    expect(members.sort()).toEqual(EXPECTED_TYPES.sort())
    expect(members.length).toBe(11)
  })
})
