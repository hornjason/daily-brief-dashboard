import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tmpDir: string
let buildHashPath: string
let lastBuildHashPath: string

// Module under test
let checkForUpgrade: typeof import('../../src/build-hash.ts').checkForUpgrade
let isUpgradeDetected: typeof import('../../src/build-hash.ts').isUpgradeDetected
let getBuildHash: typeof import('../../src/build-hash.ts').getBuildHash
let _resetForTesting: typeof import('../../src/build-hash.ts')._resetForTesting

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'build-hash-test-'))
  buildHashPath = join(tmpDir, 'BUILD_HASH')
  lastBuildHashPath = join(tmpDir, 'cache', '.last-build-hash')
  mkdirSync(join(tmpDir, 'cache'), { recursive: true })

  const mod = await import('../../src/build-hash.ts')
  checkForUpgrade = mod.checkForUpgrade
  isUpgradeDetected = mod.isUpgradeDetected
  getBuildHash = mod.getBuildHash
  _resetForTesting = mod._resetForTesting

  _resetForTesting()
})

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe('checkForUpgrade', () => {
  test('detects upgrade when hashes differ', () => {
    const currentHash = { gitSha: 'abc1234', timestamp: '2026-06-10T14:30:00Z', imageTag: 'v2.1.0' }
    writeFileSync(buildHashPath, JSON.stringify(currentHash))

    const oldHash = { gitSha: 'old5678', timestamp: '2026-06-09T10:00:00Z', imageTag: 'v2.0.0' }
    writeFileSync(lastBuildHashPath, JSON.stringify(oldHash))

    const result = checkForUpgrade(buildHashPath, lastBuildHashPath)

    expect(result.upgradeDetected).toBe(true)
    expect(result.oldSha).toBe('old5678')
    expect(result.newSha).toBe('abc1234')
    expect(result.buildInfo).toEqual(currentHash)
    expect(isUpgradeDetected()).toBe(true)

    // Verify .last-build-hash was updated
    const saved = JSON.parse(readFileSync(lastBuildHashPath, 'utf-8'))
    expect(saved.gitSha).toBe('abc1234')
  })

  test('no upgrade when hashes match', () => {
    const hash = { gitSha: 'abc1234', timestamp: '2026-06-10T14:30:00Z', imageTag: 'v2.1.0' }
    writeFileSync(buildHashPath, JSON.stringify(hash))
    writeFileSync(lastBuildHashPath, JSON.stringify(hash))

    const result = checkForUpgrade(buildHashPath, lastBuildHashPath)

    expect(result.upgradeDetected).toBe(false)
    expect(result.oldSha).toBeUndefined()
    expect(result.newSha).toBeUndefined()
    expect(result.buildInfo).toEqual(hash)
    expect(isUpgradeDetected()).toBe(false)
  })

  test('cold boot (no .last-build-hash) treated as upgrade', () => {
    const currentHash = { gitSha: 'first123', timestamp: '2026-06-10T14:30:00Z', imageTag: 'v1.0.0' }
    writeFileSync(buildHashPath, JSON.stringify(currentHash))

    expect(existsSync(lastBuildHashPath)).toBe(false)

    const result = checkForUpgrade(buildHashPath, lastBuildHashPath)

    expect(result.upgradeDetected).toBe(true)
    expect(result.oldSha).toBeUndefined()
    expect(result.newSha).toBe('first123')
    expect(result.buildInfo).toEqual(currentHash)
    expect(isUpgradeDetected()).toBe(true)

    // Verify .last-build-hash was created
    expect(existsSync(lastBuildHashPath)).toBe(true)
    const saved = JSON.parse(readFileSync(lastBuildHashPath, 'utf-8'))
    expect(saved.gitSha).toBe('first123')
  })

  test('dev environment fallback when BUILD_HASH missing', () => {
    const result = checkForUpgrade(join(tmpDir, 'nonexistent'), lastBuildHashPath)

    expect(result.buildInfo).not.toBeNull()
    expect(result.buildInfo!.gitSha).toBe('dev')
    expect(result.buildInfo!.imageTag).toBe('dev')
    // Cold boot + dev = upgrade detected
    expect(result.upgradeDetected).toBe(true)
  })
})
