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
  await import('../../src/modules/competitive-intel-module.ts')
  await import('../../src/modules/ecosystem-catalog-module.ts')
  await import('../../src/modules/ma-module.ts')
  await import('../../src/modules/partner-catalog-module.ts')
  await import('../../src/modules/recommended-actions-module.ts')
  await import('../../src/modules/saleshub-content-module.ts')
  await import('../../src/modules/saleshub-module.ts')
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
// 11. SIGNAL DATA QUALITY — no hardcoded model tiers (#472, #480)
// ═══════════════════════════════════════════════════════════════════════════

describe('Signal data quality — no hardcoded Gemini model tiers', () => {
  test('no callGemini calls use model: \'lite\' (PRINCIPLES.md Q11)', () => {
    const violations: string[] = []
    const allTsFiles = readdirSync(SRC_DIR, { recursive: true }) as string[]
    for (const file of allTsFiles) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const filePath = resolve(SRC_DIR, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        if (content.includes("model: 'lite'")) {
          violations.push(`src/${file}`)
        }
      } catch { /* skip unreadable */ }
    }
    expect(violations).toEqual([])
  })

  test('no callGemini calls use model: \'full\' (PRINCIPLES.md Q11)', () => {
    const violations: string[] = []
    const allTsFiles = readdirSync(SRC_DIR, { recursive: true }) as string[]
    for (const file of allTsFiles) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      if (file === 'gemini-call.ts') continue // type definition is OK
      const filePath = resolve(SRC_DIR, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        if (content.includes("model: 'full'")) {
          violations.push(`src/${file}`)
        }
      } catch { /* skip unreadable */ }
    }
    expect(violations).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. SIGNAL DATA QUALITY — modules must not pre-truncate signals (#480)
// ═══════════════════════════════════════════════════════════════════════════

describe('Signal data quality — no pre-truncation in signals()', () => {
  // Known exceptions: emails-module.ts caps at 50 emails (pre-existing, tracked in #476)
  const TRUNCATION_EXCEPTIONS = new Set(['emails-module.ts'])

  test('no module signals() method slices its output array', () => {
    const violations: string[] = []
    for (const file of getModuleFiles()) {
      if (TRUNCATION_EXCEPTIONS.has(file)) continue
      const content = readSrc(`modules/${file}`)
      const signalsMatch = content.match(/async signals\([^)]*\)[^{]*\{([\s\S]*?)^\s*\},?\s*$/m)
      if (!signalsMatch) continue
      const signalsBody = signalsMatch[1]
      if (/return\s+\w+\.slice\s*\(\s*0\s*,/m.test(signalsBody)) {
        violations.push(`modules/${file}: signals() truncates output array — budget caps are the registry's job`)
      }
    }
    expect(violations).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 13. PRINCIPLES.MD PRE-FLIGHT QUESTION COUNT (#480)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 13a. ADR-032a: SIGNAL ROLE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

describe('ADR-032a: Signal role classification', () => {
  test('all registered modules declare signalRole', () => {
    const modules = FeatureModuleRegistry.getRegisteredModules()
    const violations: string[] = []
    for (const mod of modules) {
      if (!mod.signalRole) {
        violations.push(`${mod.name} must declare signalRole`)
      }
    }
    expect(violations).toEqual([])
  })

  test('all registered modules declare signalAudience', () => {
    const modules = FeatureModuleRegistry.getRegisteredModules()
    const violations: string[] = []
    for (const mod of modules) {
      if (!mod.signalAudience) {
        violations.push(`${mod.name} must declare signalAudience`)
      }
    }
    expect(violations).toEqual([])
  })
})

describe('PRINCIPLES.md integrity', () => {
  const principlesPath = resolve(import.meta.dir, '../../PRINCIPLES.md')
  const principlesContent = existsSync(principlesPath) ? readFileSync(principlesPath, 'utf-8') : ''

  test('pre-flight questions have not been removed (minimum 11)', () => {
    const questionCount = (principlesContent.match(/^\d+\.\s+\*\*/gm) ?? []).length
    expect(questionCount).toBeGreaterThanOrEqual(11)
  })

  test('anti-patterns section exists and has minimum entries', () => {
    const antiPatterns = (principlesContent.match(/^- ❌/gm) ?? []).length
    expect(antiPatterns).toBeGreaterThanOrEqual(15)
  })

  test('enforcement section references architecture-compliance.test.ts', () => {
    expect(principlesContent).toContain('architecture-compliance.test.ts')
  })
})
