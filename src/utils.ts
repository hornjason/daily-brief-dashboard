// src/utils.ts — Shared utility functions (no imports from other src/ modules)

/** Strip internal file paths and cap length before returning error strings to clients. */
export const sanitizeErr = (e: any): string =>
  String(e?.message ?? e).slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')

/** Prefix formula-trigger characters with apostrophe to prevent injection */
export function sanitizeCell(value: string): string {
  if (typeof value !== 'string') return value
  if (/^[=+\-@]/.test(value) && !/^-?\d/.test(value)) return `'${value}`
  return value
}
