/**
 * Atomic file write helpers.
 *
 * Centralizes the write-tmp + renameSync pattern used across the codebase
 * for crash-safe persistence of config/cache files.
 *
 * Four operations:
 *   - writeJsonAtomic(path, value, opts?)       — JSON.stringify + atomic rename, with stale-overwrite guard (sync)
 *   - writeJsonAtomicAsync(path, value, opts?)  — same as above but async (Bun.write + fs.promises.rename)
 *   - writeFileAtomic(path, data, opts?)        — raw bytes/string + atomic rename (sync)
 *   - appendLine(path, line, opts?)             — append-only log line (NOT atomic; ordering > crash safety)
 *
 * Stale-overwrite guard (writeJsonAtomic / writeJsonAtomicAsync only):
 *   If the new value is an empty array `[]` or empty object `{}`, and the existing
 *   file on disk is non-empty (parses to a non-empty array/object), the write is
 *   skipped and a warning is logged. This protects against accidentally clobbering
 *   real cached data with an empty result from a failed scrape or partial sync.
 *   See ADR-002.
 */
import {
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from 'fs'
import { mkdir as mkdirAsync, rename as renameAsync } from 'fs/promises'
import { dirname } from 'path'

export interface WriteJsonAtomicOptions {
  /** mkdirSync the parent dir before writing. Default: true. */
  mkdir?: boolean
  /** File mode for the written file. Default: 0o600. */
  mode?: number
  /** Indent for JSON.stringify. Default: 2. */
  indent?: number
  /** Suffix for the temp file. Default: '.tmp'. */
  tmpSuffix?: string
}

export interface WriteFileAtomicOptions {
  /** mkdirSync the parent dir before writing. Default: true. */
  mkdir?: boolean
  /** File mode for the written file. Default: 0o600. */
  mode?: number
  /** Suffix for the temp file. Default: '.tmp'. */
  tmpSuffix?: string
}

export interface AppendLineOptions {
  /** mkdirSync the parent dir before writing. Default: true. */
  mkdir?: boolean
}

/**
 * Returns true if `value` is a "logically empty" container that should be
 * blocked from overwriting non-empty existing content.
 */
function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length === 0
  }
  return false
}

/**
 * Returns true if the existing file at `filePath` parses to a non-empty
 * array or object. Returns false if the file does not exist, is unreadable,
 * is invalid JSON, or parses to an empty container or scalar.
 */
function existingFileIsNonEmpty(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false
    const raw = readFileSync(filePath, 'utf-8')
    if (raw.trim().length === 0) return false
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.length > 0
    if (parsed !== null && typeof parsed === 'object') {
      return Object.keys(parsed as Record<string, unknown>).length > 0
    }
    return false
  } catch {
    return false
  }
}

/**
 * Atomically write a JSON-serializable value to `filePath`.
 *
 * Steps:
 *   1. Stale-overwrite guard: if value is empty {} or [] AND existing file is non-empty, skip.
 *   2. mkdir parent if requested.
 *   3. writeFileSync to `filePath + tmpSuffix` with the requested mode.
 *   4. renameSync to the final path.
 */
export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): void {
  const {
    mkdir = true,
    mode = 0o600,
    indent = 2,
    tmpSuffix = '.tmp',
  } = options

  // Stale-overwrite guard
  if (isEmptyContainer(value) && existingFileIsNonEmpty(filePath)) {
    console.warn(
      `[atomic-write] refusing to overwrite non-empty file with empty value: ${filePath}`,
    )
    return
  }

  if (mkdir) {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  const tmp = filePath + tmpSuffix
  writeFileSync(tmp, JSON.stringify(value, null, indent), { mode })
  renameSync(tmp, filePath)
}

/**
 * Atomically write a JSON-serializable value to `filePath` — async variant.
 *
 * Identical contract to `writeJsonAtomic` but uses `Bun.write` + `fs/promises`
 * rename so the event loop is not blocked. Use this in async hot paths (scrapers,
 * background workers) where blocking I/O would stall the process.
 *
 * Steps:
 *   1. Stale-overwrite guard: if value is empty {} or [] AND existing file is non-empty, skip.
 *   2. mkdir parent if requested (async).
 *   3. Bun.write to `filePath + tmpSuffix`.
 *   4. fs/promises rename to the final path.
 */
export async function writeJsonAtomicAsync(
  filePath: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  const {
    mkdir = true,
    mode = 0o600,
    indent = 2,
    tmpSuffix = '.tmp',
  } = options

  // Stale-overwrite guard (same contract as sync version)
  if (isEmptyContainer(value) && existingFileIsNonEmpty(filePath)) {
    console.warn(
      `[atomic-write] refusing to overwrite non-empty file with empty value: ${filePath}`,
    )
    return
  }

  if (mkdir) {
    await mkdirAsync(dirname(filePath), { recursive: true })
  }

  const tmp = filePath + tmpSuffix
  await Bun.write(tmp, JSON.stringify(value, null, indent))
  // Apply mode separately — Bun.write does not accept a mode option
  await import('fs/promises').then(({ chmod }) => chmod(tmp, mode))
  await renameAsync(tmp, filePath)
}

/**
 * Atomically write a string or byte buffer to `filePath`.
 *
 * Steps:
 *   1. mkdir parent if requested.
 *   2. writeFileSync to `filePath + tmpSuffix` with the requested mode.
 *   3. renameSync to the final path.
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): void {
  const { mkdir = true, mode = 0o600, tmpSuffix = '.tmp' } = options

  if (mkdir) {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  const tmp = filePath + tmpSuffix
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, filePath)
}

/**
 * Append a line + newline to `filePath`. Uses `appendFileSync` (NOT atomic
 * rename). Suitable for write-once append logs (bootstrap-history, kpi-history)
 * where ordering matters more than crash safety.
 *
 * Creates the file if it does not exist.
 */
export function appendLine(
  filePath: string,
  line: string,
  options: AppendLineOptions = {},
): void {
  const { mkdir = true } = options

  if (mkdir) {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  appendFileSync(filePath, line + '\n')
}
