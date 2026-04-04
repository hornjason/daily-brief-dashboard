import type { AE, Customer } from './types.ts'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve } from 'path'

// ── Path constants ──────────────────────────────────────────────────────────

export const CONFIG_DIR_PATH: string = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
export const AES_PATH: string = resolve(CONFIG_DIR_PATH, 'aes.json')
export const CUSTOMERS_PATH: string = resolve(CONFIG_DIR_PATH, 'customers.json')

// ── Shared mutable state ────────────────────────────────────────────────────
// These arrays are populated at startup and mutated by various modules.
// All modules import these references and read/write them in-place.

export let aes: AE[] = []
export let customers: Customer[] = []

// ── Startup loader ──────────────────────────────────────────────────────────

export function loadServerState(): void {
  try {
    aes = JSON.parse(readFileSync(AES_PATH, 'utf-8')).aes ?? []
    console.log(`[config] loaded ${aes.length} AEs from aes.json`)
  } catch {
    console.warn('[warn] config/aes.json not found — AE config unavailable')
  }
  try {
    customers = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8')).customers ?? []
  } catch {
    console.warn('[warn] config/customers.json not found — customer filtering disabled')
  }
}

// ── AE persistence ──────────────────────────────────────────────────────────

/** Persist aes[] back to aes.json atomically. */
export function saveAes(updated: AE[]): void {
  const tmp = AES_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify({ aes: updated }, null, 2), { mode: 0o600 })
  renameSync(tmp, AES_PATH)
  aes = updated
}

/**
 * Atomically patch a single AE's fields.
 *
 * Reads fresh from disk before merging — prevents a common race where two
 * async call chains each snapshot `aes`, yield to the event loop, then both
 * write back, with the second write silently clobbering the first's changes.
 *
 * Use this instead of `saveAes(aes.map(a => a.name === n ? {...a, f} : a))`
 * whenever there is an `await` between reading `aes` and calling `saveAes`.
 */
export function patchAe(name: string, fields: Partial<AE>): void {
  let fresh: AE[]
  try {
    fresh = JSON.parse(readFileSync(AES_PATH, 'utf-8')).aes ?? []
  } catch {
    fresh = [...aes]  // fallback to in-memory if disk read fails
  }
  const updated = fresh.map(a => a.name === name ? { ...a, ...fields } : a)
  saveAes(updated)
}

export function saveCustomers(updated: Customer[]): void {
  const tmp = CUSTOMERS_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify({ customers: updated }, null, 2), { mode: 0o600 })
  renameSync(tmp, CUSTOMERS_PATH)
  customers = updated
}

/** BKL-AI11: Atomically patch a single customer's fields (same pattern as patchAe). */
export function patchCustomer(name: string, fields: Partial<Customer>): void {
  let fresh: Customer[]
  try {
    fresh = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8')).customers ?? []
  } catch {
    fresh = [...customers]
  }
  const updated = fresh.map(c => c.name === name ? { ...c, ...fields } : c)
  saveCustomers(updated)
}

// ── Direct state setters (for test restore, etc.) ───────────────────────────

export function setAes(newAes: AE[]): void {
  aes = newAes
}

export function setCustomers(newCustomers: Customer[]): void {
  customers = newCustomers
}
