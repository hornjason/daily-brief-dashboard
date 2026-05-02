/**
 * src/bootstrap-routes.ts
 *
 * BKL-ARCH-01: Thin shim — re-exports createBootstrapRouter from bootstrap-orchestrator.
 * Extracted per ADR-005 (500-line cap): route registration lives in bootstrap-orchestrator.ts
 * alongside the orchestration functions it calls. This module provides the canonical import
 * path for consumers that want only the router, and keeps the public API stable for future
 * refactoring when the route handlers can be further decoupled from the orchestrator state.
 */

export { createBootstrapRouter } from './bootstrap-orchestrator.ts'
