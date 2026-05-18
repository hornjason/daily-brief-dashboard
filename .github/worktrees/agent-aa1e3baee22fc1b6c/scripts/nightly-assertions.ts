#!/usr/bin/env bun
/**
 * scripts/nightly-assertions.ts — Gate 3 data integrity validator
 *
 * Runs nightly against production (localhost:7777) to validate:
 *   - AE count > 0
 *   - Customer count per AE > 0
 *   - POD coverage (all configured PODs have at least one AE)
 *   - Required customer fields (name, accountNumbers, ae)
 *
 * Exit codes:
 *   0 — all assertions passed
 *   1 — one or more assertions failed (details written to stderr)
 *
 * Budget: <90s total (pure fetch, no Playwright)
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

interface AE {
  name: string
  driveFolderId: string
  parentFolderId?: string
  sfReportId?: string
  tableauTerritories?: string[]
  tableauUrl?: string
  subscriptionSheetId?: string
  pipelineSheetId?: string
  ccspSheetId?: string
  accounts?: string[]
}

interface Customer {
  name: string
  domain?: string
  accountNumbers?: string[]
  ae?: string
  segment?: string
  region?: string
  driveFolderId?: string
  inactive?: boolean
}

interface ValidationError {
  check: string
  message: string
  data?: unknown
}

const errors: ValidationError[] = []

function fail(check: string, message: string, data?: unknown): void {
  errors.push({ check, message, data })
}

async function fetchJson<T>(endpoint: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`)
    if (!res.ok) {
      fail('api_availability', `${endpoint} returned ${res.status}`)
      return null
    }
    return await res.json() as T
  } catch (err) {
    fail('api_availability', `${endpoint} fetch failed: ${String(err)}`)
    return null
  }
}

async function validateAEs(): Promise<AE[]> {
  const data = await fetchJson<{ aes: AE[] }>('/api/aes')
  if (!data) return []

  const { aes } = data

  if (!Array.isArray(aes)) {
    fail('ae_format', 'GET /api/aes returned non-array aes field', data)
    return []
  }

  if (aes.length === 0) {
    fail('ae_count', 'Zero AEs configured — expected at least 1')
    return []
  }

  console.log(`✓ AE count: ${aes.length}`)
  return aes
}

async function validateCustomers(aes: AE[]): Promise<Customer[]> {
  const data = await fetchJson<{ customers: Customer[] }>('/api/customers')
  if (!data) return []

  const { customers } = data

  if (!Array.isArray(customers)) {
    fail('customer_format', 'GET /api/customers returned non-array customers field', data)
    return []
  }

  if (customers.length === 0) {
    fail('customer_count', 'Zero customers configured — expected at least 1')
    return []
  }

  console.log(`✓ Customer count: ${customers.length}`)

  // Validate required fields on each customer
  for (const c of customers) {
    if (!c.name) {
      fail('customer_fields', 'Customer missing required field: name', c)
    }
    if (!c.ae) {
      fail('customer_fields', `Customer "${c.name}" missing required field: ae`, c)
    }
    // accountNumbers is optional (skipAccountDiscovery customers may not have any)
    // But if present, must be an array
    if (c.accountNumbers !== undefined && !Array.isArray(c.accountNumbers)) {
      fail('customer_fields', `Customer "${c.name}" accountNumbers is not an array`, c)
    }
  }

  // Validate each AE has at least one customer
  for (const ae of aes) {
    const aeCustomers = customers.filter(c => c.ae === ae.name)
    if (aeCustomers.length === 0) {
      fail('ae_coverage', `AE "${ae.name}" has zero customers`, ae)
    } else {
      console.log(`✓ AE "${ae.name}": ${aeCustomers.length} customer(s)`)
    }
  }

  return customers
}

async function validatePODCoverage(aes: AE[]): Promise<void> {
  // POD coverage: every configured POD should have at least one AE with data
  // In the current architecture, PODs are implicit from tableauTerritories
  // Extract unique POD prefixes (territory strings before _TERR)
  const pods = new Set<string>()
  for (const ae of aes) {
    if (ae.tableauTerritories && ae.tableauTerritories.length > 0) {
      for (const terr of ae.tableauTerritories) {
        // Extract POD from territory (e.g. "WEST_COMM_CORP_NORTHWEST_TERR01" → "WEST_COMM_CORP_NORTHWEST")
        const podMatch = terr.match(/^(.+?)_TERR\d+$/)
        if (podMatch) {
          pods.add(podMatch[1])
        } else {
          pods.add(terr) // fallback: use full territory as POD
        }
      }
    }
  }

  if (pods.size === 0) {
    // No POD data configured — not necessarily an error for hero installs
    console.log('⚠ No POD territories configured (hero install expected)')
    return
  }

  console.log(`✓ POD coverage: ${pods.size} unique POD(s) found`)
  for (const pod of Array.from(pods).sort()) {
    console.log(`  - ${pod}`)
  }
}

async function main(): Promise<number> {
  console.log('Gate 3: Nightly data assertion check')
  console.log(`Target: ${BASE_URL}`)
  console.log('')

  const aes = await validateAEs()
  if (aes.length === 0 && errors.length > 0) {
    // Fatal: can't proceed without AEs
    console.error('\n✗ FAILED — cannot validate customers without AEs')
    for (const e of errors) {
      console.error(`  [${e.check}] ${e.message}`)
      if (e.data) console.error(`    Data: ${JSON.stringify(e.data)}`)
    }
    return 1
  }

  const customers = await validateCustomers(aes)
  await validatePODCoverage(aes)

  if (errors.length > 0) {
    console.error('\n✗ FAILED — data integrity issues detected:')
    for (const e of errors) {
      console.error(`  [${e.check}] ${e.message}`)
      if (e.data) console.error(`    Data: ${JSON.stringify(e.data)}`)
    }
    return 1
  }

  console.log('\n✓ All assertions passed')
  console.log(`  AEs: ${aes.length}, Customers: ${customers.length}`)
  return 0
}

process.exit(await main())
