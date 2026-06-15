/**
 * src/lib/motion-config.ts
 * Shared configuration for motion builder context handling.
 * Extracted from motion-builder.ts per #803, #811.
 */

/** Priority ordering for product context types (lower = higher priority) */
export const CONTEXT_PRIORITY: Record<string, number> = {
  migrating_from: 0,
  evaluating: 1,
  using: 2,
}

/** Human-readable verb mapping for evidence text */
export const CONTEXT_VERB_MAP: Record<string, string> = {
  evaluating: 'evaluating',
  migrating_from: 'migrating from',
  using: 'uses',
}
