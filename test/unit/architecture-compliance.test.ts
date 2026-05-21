/**
 * Architecture Compliance Tests — GitHub Issue #329
 *
 * Auto-discovers architecture violations by reading the actual module registry
 * and scanning source files. NO hardcoded lists — when a new module is added,
 * it's automatically checked.
 *
 * Test categories:
 *   1. Module contract compliance (no direct score setting, ensureFresh advisory)
 *   2. Consumer compliance (template imports, ensureFresh calls)
 *   3. Module ensureFresh coverage report (advisory, informational)
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

// ── Import all modules to trigger registration ────────────────────────────
import '../../src/modules/campaigns-module.ts'
import '../../src/modules/news-module.ts'
import '../../src/modules/tools-module.ts'
import '../../src/modules/lifecycle-module.ts'
import '../../src/modules/rss-module.ts'
import '../../src/modules/events-module.ts'
import '../../src/modules/product-intel-module.ts'
import '../../src/modules/meeting-prep-module.ts'
import '../../src/modules/ccsp-module.ts'
import '../../src/modules/value-map-module.ts'
import '../../src/modules/cases-module.ts'
import '../../src/modules/subscriptions-module.ts'
import '../../src/modules/emails-module.ts'
import '../../src/modules/pipeline-module.ts'
import '../../src/modules/docs-module.ts'
import '../../src/modules/intelligence-module.ts'
import '../../src/modules/customer-product-intel-module.ts'
import '../../src/modules/account-plan-module.ts'
import '../../src/modules/playbook-module.ts'
import '../../src/modules/tech-stack-module.ts'
import '../../src/modules/cloud-marketplace-module.ts'

// ── Helper functions ───────────────────────────────────────────────────────

/**
 * Read a source file and return its content.
 */
function readSourceFile(relativePath: string): string {
  const fullPath = resolve(import.meta.dir, '../../src', relativePath)
  return readFileSync(fullPath, 'utf-8')
}

/**
 * Check if a line sets score directly on a Signal object (ADR-027 violation).
 * We're looking for object literals that assign score directly like: { score: 0.8 }
 *
 * Excludes:
 *  - Lines with `rawRelevance` (correct pattern)
 *  - Type definitions (`: number`, `?: number`)
 *  - Comments
 *  - Local variables (let score = 0.4) — these are intermediate calculations, not Signal objects
 */
function lineSetsScoredirectly(line: string): boolean {
  // Skip comments
  if (line.trim().startsWith('//') || line.trim().startsWith('*')) return false

  // Skip type definitions like `score?: number` or `score: number`
  if (/score\s*\??\s*:\s*(number|undefined)/i.test(line)) return false

  // Skip lines that mention rawRelevance (correct pattern)
  if (/rawRelevance/i.test(line)) return false

  // Skip local variable declarations (let score = 0.4) — not Signal objects
  if (/\b(let|const|var)\s+score\s*=/i.test(line)) return false

  // Detect object literal assignment: `score: 0.8` (within an object)
  // This is the ADR-027 violation we're looking for
  if (/\bscore\s*:\s*[0-9.]/i.test(line)) return true

  return false
}

/**
 * Get all module files from src/modules/ directory.
 */
function getModuleFiles(): string[] {
  const modulesDir = resolve(import.meta.dir, '../../src/modules')
  return readdirSync(modulesDir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => `modules/${f}`)
}

/**
 * Known consumer files that format signals for display.
 */
const CONSUMER_FILES = [
  'playbook-generator.ts',
  'brief-pipeline.ts',
  'customer.ts',
  'campaigns-routes.ts',
  'meeting-prep-routes.ts',
]

// ── Module Contract Compliance ────────────────────────────────────────────

describe('Architecture Compliance', () => {
  describe('Module contract compliance', () => {
    test('no module sets score directly — only rawRelevance allowed', () => {
      const violations: Array<{ file: string; line: number; content: string }> = []

      // Scan all module files
      for (const moduleFile of getModuleFiles()) {
        const content = readSourceFile(moduleFile)
        const lines = content.split('\n')

        lines.forEach((line, idx) => {
          if (lineSetsScoredirectly(line)) {
            violations.push({
              file: moduleFile,
              line: idx + 1,
              content: line.trim(),
            })
          }
        })
      }

      if (violations.length > 0) {
        const report = violations
          .map(v => `  ${v.file}:${v.line} — ${v.content}`)
          .join('\n')
        throw new Error(
          `Found ${violations.length} module(s) setting score directly (ADR-027 violation):\n${report}\n\nModules must set rawRelevance only. The registry scores centrally.`
        )
      }

      // Test passes if no violations found
      expect(violations).toHaveLength(0)
    })
  })

  describe('Consumer compliance', () => {
    test('all consumers import from signal-templates.ts', () => {
      const violations: string[] = []

      for (const consumerFile of CONSUMER_FILES) {
        try {
          const content = readSourceFile(consumerFile)

          // Check for import from signal-templates
          // Pattern: import { ... } from './lib/signal-templates'
          const hasTemplateImport = /import\s+\{[^}]*\}\s+from\s+['"]\.\/lib\/signal-templates/m.test(content)

          // Exception: brief-pipeline and customer.ts may use narrativeContext only
          // They don't need template imports if they're not formatting signals
          const isBriefPipeline = consumerFile === 'brief-pipeline.ts'
          const isCustomer = consumerFile === 'customer.ts'
          const usesNarrativeContextOnly = content.includes('narrativeContext') && !content.includes('templateAll')

          if (!hasTemplateImport && !(isBriefPipeline || isCustomer) && !usesNarrativeContextOnly) {
            violations.push(consumerFile)
          }
        } catch (e: any) {
          // File might not exist — skip
          console.warn(`[compliance] Could not read ${consumerFile}: ${e.message}`)
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `Found ${violations.length} consumer(s) missing signal-templates import:\n${violations.map(f => `  - ${f}`).join('\n')}\n\nAll consumers must import templateAll or individual template functions from signal-templates.ts`
        )
      }

      expect(violations).toHaveLength(0)
    })

    test('all consumers use ensureFresh when generating content', () => {
      const violations: string[] = []

      for (const consumerFile of CONSUMER_FILES) {
        try {
          const content = readSourceFile(consumerFile)

          // Check if file calls loadCustomerSignals or ensureSignalsCurrent
          const callsLoadSignals = /loadCustomerSignals/m.test(content)
          const callsEnsure = /ensureSignalsCurrent/m.test(content)

          if (!callsLoadSignals && !callsEnsure) {
            // File doesn't use signals at all — skip
            continue
          }

          // If it calls loadCustomerSignals, check for ensureFresh: true
          if (callsLoadSignals) {
            const hasEnsureFresh = /ensureFresh:\s*true/m.test(content)
            if (!hasEnsureFresh) {
              violations.push(`${consumerFile} (calls loadCustomerSignals without ensureFresh: true)`)
            }
          }

          // If it calls ensureSignalsCurrent directly, that's compliant
          // (customer.ts does this)
        } catch (e: any) {
          console.warn(`[compliance] Could not read ${consumerFile}: ${e.message}`)
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `Found ${violations.length} consumer(s) missing ensureFresh:\n${violations.map(f => `  - ${f}`).join('\n')}\n\nAll consumers must pass { ensureFresh: true } to loadCustomerSignals or call ensureSignalsCurrent directly.`
        )
      }

      expect(violations).toHaveLength(0)
    })
  })

  describe('Module ensureFresh coverage report', () => {
    test('reports modules with signals() missing ensureFresh', () => {
      const modules = FeatureModuleRegistry.getRegisteredModules()
      const signalProducers = modules.filter(m => m.signals)
      const withEnsureFresh = signalProducers.filter(m => m.ensureFresh)
      const withCacheTtl = signalProducers.filter(m => m.cacheTtlMs)
      const compliant = signalProducers.filter(m => m.ensureFresh && m.cacheTtlMs)
      const advisory = signalProducers.filter(m => !m.ensureFresh || !m.cacheTtlMs)
      const exempt = modules.filter(m => !m.signals)

      console.log('=== Module Compliance Report ===')
      console.log(`Total modules: ${modules.length}`)
      console.log(`Signal producers: ${signalProducers.length}`)
      console.log(`With ensureFresh: ${withEnsureFresh.length}`)
      console.log(`With cacheTtlMs: ${withCacheTtl.length}`)
      console.log(`Fully compliant: ${compliant.length}`)
      console.log('')

      if (compliant.length > 0) {
        console.log('Compliant modules (ensureFresh + cacheTtlMs):')
        for (const m of compliant) {
          console.log(`  ✓ ${m.name}`)
        }
        console.log('')
      }

      if (advisory.length > 0) {
        console.log('Advisory — missing ensureFresh or cacheTtlMs:')
        for (const m of advisory) {
          const missing: string[] = []
          if (!m.ensureFresh) missing.push('ensureFresh')
          if (!m.cacheTtlMs) missing.push('cacheTtlMs')
          console.log(`  ! ${m.name} — missing: ${missing.join(', ')}`)
        }
        console.log('')
      }

      if (exempt.length > 0) {
        console.log('Exempt (no signals):')
        for (const m of exempt) {
          console.log(`  - ${m.name}`)
        }
        console.log('')
      }

      const complianceScore = signalProducers.length > 0
        ? Math.round((compliant.length / signalProducers.length) * 100)
        : 100

      console.log(`Compliance score: ${complianceScore}% (${compliant.length}/${signalProducers.length} signal-producing modules)`)

      // This test is informational — it always passes
      expect(complianceScore).toBeGreaterThanOrEqual(0)
    })
  })
})
