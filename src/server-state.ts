import type { AE, Customer } from './types.ts'
import { readFileSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import { mergeCustomers, readExistingCustomers } from './customer-merge.ts'
import { backupNow } from './backup-config.ts'

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
    customers = customers.filter(c => !c.inactive)  // ADR-018: safety net
    if (customers.length === 0) {
      console.warn('[WARN] customers.json loaded with 0 customers — file may be corrupted or was wiped. Re-run territory sync or bootstrap to restore.')
    } else {
      console.log(`[config] loaded ${customers.length} customers from customers.json`)
    }
  } catch {
    console.warn('[warn] config/customers.json not found — customer filtering disabled')
  }
}

// ── AE persistence ──────────────────────────────────────────────────────────

/** Persist aes[] back to aes.json atomically. */
export function saveAes(updated: AE[]): void {
  writeJsonAtomic(AES_PATH, { aes: updated })
  aes = updated
  backupNow().catch(e => console.warn('[backup] async backup failed:', e.message))
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
  // BKL-G27: merge-not-replace — carry forward AI-enriched fields not present in `updated`
  const existing = readExistingCustomers(CUSTOMERS_PATH)
  const merged = mergeCustomers(updated as Record<string, any>[], existing) as Customer[]
  writeJsonAtomic(CUSTOMERS_PATH, { customers: merged })
  customers = merged
  backupNow().catch(e => console.warn('[backup] async backup failed:', e.message))
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
  customers = newCustomers.filter(c => !c.inactive)  // ADR-018: safety net
}
