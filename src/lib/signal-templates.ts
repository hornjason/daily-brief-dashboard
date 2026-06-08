/**
 * Signal Template Engine — Barrel re-export
 * GitHub Issue #684: Decomposed into domain modules under ./templates/
 *
 * All consumers continue to import from this file unchanged.
 * Actual implementations live in src/lib/templates/*.ts
 */

export * from './templates/index.ts'
