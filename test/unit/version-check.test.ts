/**
 * Unit tests for version comparison logic (GitHub issue #73)
 *
 * Tests the pure function that compares semantic versions to determine
 * if an update is available. Handles release candidates, dev builds,
 * and standard semver.
 */
import { describe, test, expect } from 'bun:test'
import { compareVersions, shouldShowUpdate } from '../../src/lib/version-utils.ts'

describe('compareVersions', () => {
  test('identifies newer patch version', () => {
    expect(compareVersions('1.7.0', '1.7.1')).toBe(1) // 1.7.1 is newer
  })

  test('identifies newer minor version', () => {
    expect(compareVersions('1.7.0', '1.8.0')).toBe(1)
  })

  test('identifies newer major version', () => {
    expect(compareVersions('1.7.0', '2.0.0')).toBe(1)
  })

  test('identifies same version', () => {
    expect(compareVersions('1.7.0', '1.7.0')).toBe(0)
  })

  test('identifies older version', () => {
    expect(compareVersions('1.7.1', '1.7.0')).toBe(-1)
  })

  test('RC version is older than stable', () => {
    expect(compareVersions('1.7.0-rc8', '1.7.0')).toBe(1) // 1.7.0 is newer
  })

  test('RC version is older than next patch', () => {
    expect(compareVersions('1.7.0-rc8', '1.7.1')).toBe(1) // 1.7.1 is newer
  })

  test('higher RC number is newer than lower RC', () => {
    expect(compareVersions('1.7.0-rc8', '1.7.0-rc9')).toBe(1)
  })

  test('dev version comparison returns 0 (no update check)', () => {
    expect(compareVersions('1.0.0-dev', '2.0.0')).toBe(0)
  })
})

describe('shouldShowUpdate', () => {
  test('shows update when newer version available', () => {
    expect(shouldShowUpdate('1.7.0', '1.7.1')).toBe(true)
  })

  test('does not show update when same version', () => {
    expect(shouldShowUpdate('1.7.0', '1.7.0')).toBe(false)
  })

  test('does not show update when current is newer', () => {
    expect(shouldShowUpdate('1.7.1', '1.7.0')).toBe(false)
  })

  test('shows update when RC and stable available', () => {
    expect(shouldShowUpdate('1.7.0-rc8', '1.7.0')).toBe(true)
  })

  test('does not show update for dev builds', () => {
    expect(shouldShowUpdate('1.0.0-dev', '2.0.0')).toBe(false)
  })
})
