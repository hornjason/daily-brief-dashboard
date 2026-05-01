/**
 * Unit tests for src/lib/customer-folder.ts.
 *
 * Uses a stub DriveFolderClient injected via makeCustomerFolderResolverForTest.
 * No real Drive calls, no network, no auth. Each test asserts on observable
 * behavior through the public interface only.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import type { Customer } from '../../src/types.ts'
import type { AE } from '../../src/types.ts'

// ── Stub DriveFolderClient ────────────────────────────────────────────────────

interface FindDescendantCall {
  parentId: string
  name: string
  options: { fuzzy?: boolean; maxDepth?: number }
}

class StubDriveClient {
  calls: FindDescendantCall[] = []
  returnValue: string | null = 'stub-folder-id'

  async findDescendantFolder(
    parentId: string,
    name: string,
    options: { fuzzy?: boolean; maxDepth?: number } = {},
  ): Promise<string | null> {
    this.calls.push({ parentId, name, options })
    return this.returnValue
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    name: 'Acme Corp',
    ae: 'Alice AE',
    ...overrides,
  }
}

function makeAE(overrides: Partial<AE> = {}): AE {
  return {
    name: 'Alice AE',
    driveFolderId: 'ae-folder-id',
    ...overrides,
  }
}

// ── Import shared helpers ─────────────────────────────────────────────────────

async function getResolver(stub: StubDriveClient, aeList: AE[] = [makeAE()]) {
  const { makeCustomerFolderResolverForTest } = await import('../../src/lib/customer-folder.ts')
  return makeCustomerFolderResolverForTest({ driveClient: stub as any, aes: aeList })
}

// ── Slice 1: fast path ────────────────────────────────────────────────────────

describe('findCustomerDriveFolder — fast path', () => {
  test('returns driveFolderId immediately when set on customer', async () => {
    const stub = new StubDriveClient()
    const resolver = await getResolver(stub)

    const result = await resolver(makeCustomer({ driveFolderId: 'already-known-id' }))

    expect(result).toBe('already-known-id')
    expect(stub.calls.length).toBe(0)
  })
})

// ── Slice 2+3: slow path call signature and return value ─────────────────────

describe('findCustomerDriveFolder — slow path', () => {
  test('calls findDescendantFolder with correct parentId, name, and options', async () => {
    const stub = new StubDriveClient()
    stub.returnValue = 'found-folder-id'
    const resolver = await getResolver(stub, [makeAE({ driveFolderId: 'ae-folder-id' })])

    await resolver(makeCustomer({ driveFolderId: undefined }))

    expect(stub.calls.length).toBe(1)
    expect(stub.calls[0].parentId).toBe('ae-folder-id')
    expect(stub.calls[0].name).toBe('Acme Corp')
    expect(stub.calls[0].options).toEqual({ fuzzy: true, maxDepth: 2 })
  })

  test('returns the folder ID returned by findDescendantFolder', async () => {
    const stub = new StubDriveClient()
    stub.returnValue = 'matched-folder-id'
    const resolver = await getResolver(stub)

    const result = await resolver(makeCustomer({ driveFolderId: undefined }))

    expect(result).toBe('matched-folder-id')
  })
})

// ── Slice 4: error — AE has no driveFolderId ─────────────────────────────────

describe('findCustomerDriveFolder — error cases', () => {
  test('throws descriptive error when AE has no driveFolderId', async () => {
    const stub = new StubDriveClient()
    const aeWithNoFolder: AE = { name: 'Alice AE', driveFolderId: '' }
    const resolver = await getResolver(stub, [aeWithNoFolder])

    await expect(
      resolver(makeCustomer({ driveFolderId: undefined })),
    ).rejects.toThrow('Acme Corp')

    expect(stub.calls.length).toBe(0)
  })

  test('throws descriptive error when findDescendantFolder returns null', async () => {
    const stub = new StubDriveClient()
    stub.returnValue = null
    const resolver = await getResolver(stub)

    await expect(
      resolver(makeCustomer({ driveFolderId: undefined })),
    ).rejects.toThrow('Acme Corp')
  })
})

// ── Slices 6-9: normalizeCustomerName ────────────────────────────────────────

describe('normalizeCustomerName', () => {
  let normalize: (raw: string) => string

  beforeAll(async () => {
    const mod = await import('../../src/lib/customer-folder.ts')
    normalize = mod.normalizeCustomerName
  })

  test('strips state suffix " - CA"', () => {
    expect(normalize('DROPBOX, INC. - CA')).toBe('Dropbox')
  })

  test('strips parenthetical', () => {
    expect(normalize('Foo (Bar)')).toBe('Foo')
  })

  test('strips INC. suffix', () => {
    expect(normalize('A10 NETWORKS, INC.')).toBe('A10 Networks')
  })

  test('preserves digit-bearing word while applying title case', () => {
    expect(normalize('A10 NETWORKS')).toBe('A10 Networks')
  })
})
