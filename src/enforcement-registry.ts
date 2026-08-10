// src/enforcement-registry.ts
// Enforcement Registry — Layer 12 component catalog
//
// Centralizes the enforcement inventory for architectural compliance mechanisms:
//   - Architecture compliance tests
//   - Pre-commit hooks
//   - Gate scripts (fallow-gate, quality gates)
//   - Lint/format enforcement (ESLint, Prettier)
//   - Validation scripts
//
// This registry enables pattern consistency enforcement (#175) and provides
// a single source of truth for architecture compliance tracking.

export interface EnforcementComponent {
  /** Component name (human-readable) */
  name: string
  /** Enforcement type: test | hook | gate | lint | validator */
  type: 'test' | 'hook' | 'gate' | 'lint' | 'validator'
  /** File path relative to project root */
  filePath: string
  /** Description of what this enforcement mechanism validates */
  description: string
}

const _components: EnforcementComponent[] = []

export const EnforcementRegistry = {
  /** Register an enforcement component */
  register(component: EnforcementComponent): void {
    _components.push(component)
  },

  /** Get all registered components */
  list(): EnforcementComponent[] {
    return [..._components]
  },

  /** Get components by type */
  byType(type: EnforcementComponent['type']): EnforcementComponent[] {
    return _components.filter(c => c.type === type)
  },

  /** Get component count */
  count(): number {
    return _components.length
  },
}

// ── Architecture Compliance Tests ────────────────────────────────────────────
EnforcementRegistry.register({
  name: 'Architecture Compliance Tests',
  type: 'test',
  filePath: 'test/unit/architecture-compliance.test.ts',
  description: 'Deep scan + drift detection for all architectural contracts',
})

// ── Pre-commit Hooks ─────────────────────────────────────────────────────────
EnforcementRegistry.register({
  name: 'Pre-commit Hook',
  type: 'hook',
  filePath: 'scripts/hooks/pre-commit',
  description: 'Git pre-commit hook for code quality and test enforcement',
})

// ── Gate Scripts ─────────────────────────────────────────────────────────────
EnforcementRegistry.register({
  name: 'Fallow Gate',
  type: 'gate',
  filePath: '.claude/hooks/fallow-gate.sh',
  description: 'Post-commit quality gate for code simplicity and unused code detection',
})

EnforcementRegistry.register({
  name: 'Gemini Quality Gate',
  type: 'gate',
  filePath: 'src/gemini-quality-gate.ts',
  description: 'Runtime quality gate for Gemini-generated content validation',
})

EnforcementRegistry.register({
  name: 'Product Quality Gate Test',
  type: 'test',
  filePath: 'test/unit/product-quality-gate.test.ts',
  description: 'Quality gate tests for product intelligence data',
})

EnforcementRegistry.register({
  name: 'Quality Gate Test',
  type: 'test',
  filePath: 'test/unit/quality-gate.test.ts',
  description: 'Core quality gate validation tests',
})

EnforcementRegistry.register({
  name: 'Quality Gate Garbage Test',
  type: 'test',
  filePath: 'test/unit/quality-gate-garbage.test.ts',
  description: 'Quality gate tests for garbage detection and filtering',
})

EnforcementRegistry.register({
  name: 'Bootstrap L3 Gate Test',
  type: 'test',
  filePath: 'test/unit/bootstrap-l3-gate.test.ts',
  description: 'Bootstrap process L3 Drive access gate tests',
})

EnforcementRegistry.register({
  name: 'BKL Sync L3-02 Primary Gate Test',
  type: 'test',
  filePath: 'test/unit/bkl-sync-l3-02-primary-gate.test.ts',
  description: 'BKL sync primary node gate validation tests',
})

EnforcementRegistry.register({
  name: 'Quinn Issue 7 Admin Gate Test',
  type: 'test',
  filePath: 'test/quinn-issue7-admin-gate.spec.ts',
  description: 'Admin access gate validation tests',
})

// ── Validation Scripts ───────────────────────────────────────────────────────
EnforcementRegistry.register({
  name: 'Empty Catches Checker',
  type: 'validator',
  filePath: 'scripts/check-empty-catches.sh',
  description: 'Validates no empty catch blocks exist in codebase',
})

EnforcementRegistry.register({
  name: 'Environment Drift Checker',
  type: 'validator',
  filePath: 'scripts/check-env-drift.sh',
  description: 'Validates environment configuration consistency',
})
