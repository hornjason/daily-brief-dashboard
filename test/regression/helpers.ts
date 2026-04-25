/**
 * Shared test helpers for regression specs.
 * Single source of truth for BASE_URL, DESTRUCTIVE_URL, KNOWN_CUSTOMER,
 * and the fetch utility functions used across all domain spec files.
 */
import { requireLocalhost, requireTestContainer } from '../utils/require-localhost'

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'
export const DESTRUCTIVE_URL = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
export const KNOWN_CUSTOMER = process.env.TEST_KNOWN_CUSTOMER ?? 'Autodesk'
export const KNOWN_CUSTOMER_ENCODED = encodeURIComponent(KNOWN_CUSTOMER)

// Localhost check fires at module scope (read-only gate — 7777 is allowed for ci project).
// Port-7777 check (requireTestContainer) is called inside beforeAll blocks of @destructive
// test files, where mutations actually happen.
requireLocalhost(DESTRUCTIVE_URL)
export { requireTestContainer }

export async function getJSON(path: string) {
  const res = await fetch(`${BASE_URL}${path}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}

export async function postJSON(path: string, data: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export async function postJSONDestructive(path: string, data: unknown) {
  const res = await fetch(`${DESTRUCTIVE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json() }
}

export async function getKnownCustomer(baseUrl = BASE_URL): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/accounts`)
    if (!res.ok) return null
    const body = await res.json()
    const customers = body?.customers ?? body ?? []
    if (!Array.isArray(customers) || customers.length === 0) return null
    return customers[0].name ?? null
  } catch { return null }
}
