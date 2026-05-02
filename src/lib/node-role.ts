// src/lib/node-role.ts — issue #10
//
// Single source of truth for NODE_ROLE policy.
//
// NODE_ROLE=primary  → this node is the L4 leader (Mac Mini sync daemon).
//                       L4 live scrapes (Tableau, SF Lightning) are permitted.
// NODE_ROLE unset    → hero install, L3-only.
//                       L4 live scrapes are forbidden; readers fall through to
//                       Drive-cached L3 data.
//
// Three call-site shapes are supported, matching pre-existing usage:
//   - assertPrimary(op)  — throw WrongRoleError on hero (loud failure for entry
//                          points that have no safe degraded mode, e.g. live
//                          scrape functions that callers must not invoke).
//   - ifPrimary(fn)      — run on primary, no-op on hero, returns the fn result
//                          or undefined (registration-time / scheduler gating).
//   - isPrimary()        — bool predicate (callers compose their own control flow).
//   - getRole()          — explicit role string for code that needs to log or
//                          expose the role (e.g. /api/node-role response).
//
// All other modules MUST import from this file. `process.env.NODE_ROLE` is read
// in exactly one place (this module). This makes the policy testable, typed,
// and consistent.

export type NodeRole = 'hero' | 'primary'

export class WrongRoleError extends Error {
  readonly operation: string

  constructor(operation: string) {
    super(`Operation '${operation}' is not available on a hero install`)
    this.name = 'WrongRoleError'
    this.operation = operation
  }
}

// ── Cached role ──────────────────────────────────────────────────────────────
//
// Role is resolved once at module load time, then cached. NODE_ROLE is a
// container-CMD-level decision (see docs/HERO-INSTALL.md "role-as-entrypoint")
// — it never flips at runtime in production. Tests override via
// __setRoleForTest below.

/** BKL-SEC-IS-LEADER-CASE-01: Exported only for unit tests. Production code uses isPrimary() / getRole(). */
export function _parseRole(raw: string | undefined): NodeRole {
  if (raw !== undefined && raw !== '' && raw !== 'primary') {
    console.warn(`[node-role] NODE_ROLE="${raw}" is not "primary" — treating as hero. Only NODE_ROLE=primary (exact, lowercase) enables L4 scrapes.`)
  }
  return raw === 'primary' ? 'primary' : 'hero'
}

function readRoleFromEnv(): NodeRole {
  return _parseRole(process.env.NODE_ROLE)
}

let _role: NodeRole = readRoleFromEnv()

export function getRole(): NodeRole {
  return _role
}

export function isPrimary(): boolean {
  return _role === 'primary'
}

export function assertPrimary(operation: string): void {
  if (_role !== 'primary') {
    throw new WrongRoleError(operation)
  }
}

export function ifPrimary<T>(fn: () => T): T | undefined {
  if (_role === 'primary') {
    return fn()
  }
  return undefined
}

// ── Test-only override ───────────────────────────────────────────────────────
//
// Gated behind NODE_ENV === 'test' so production code paths cannot accidentally
// flip the role. `bun test` sets NODE_ENV=test by default.

export function __setRoleForTest(role: NodeRole): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      '__setRoleForTest may only be called when NODE_ENV === "test"'
    )
  }
  _role = role
}
