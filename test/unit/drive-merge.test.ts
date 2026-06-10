/**
 * Tests for Drive merge helpers — #737 version check + #738 multi-region
 *
 * Tests the pure-logic helpers extracted from runStartupDriveMerge.
 * No filesystem or Drive API calls.
 */
import { describe, it, expect } from 'bun:test'
import type { RegionConfig } from '../../src/region-config.ts'
import {
  computeDriveMerge,
  getUniqueParentFolderIds,
} from '../../src/setup-routes.ts'


describe('#737 — Drive merge version check', () => {
  const baseRegion: RegionConfig = {
    id: 'west-commercial',
    label: 'West Commercial',
    type: 'commercial',
    territorySheetUrl: 'https://sheets.example.com/west',
    podBookingsFolderId: 'folder123',
    parentFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
    pods: {
      WEST_POD01: { sfReportId: 'sf1', label: 'Pod 1' },
    },
  }

  it('AC-1: skips merge when Drive regions match local regions', () => {
    const local = [{ ...baseRegion }]
    const drive = [{ ...baseRegion }]
    const result = computeDriveMerge(local, drive)
    expect(result.action).toBe('skip')
    expect(result.changed).toEqual([])
  })

  it('AC-2: logs what changed when Drive regions differ (label change)', () => {
    const local = [{ ...baseRegion }]
    const drive = [{ ...baseRegion, label: 'West Commercial Updated' }]
    const result = computeDriveMerge(local, drive)
    expect(result.action).toBe('merge')
    expect(result.changed).toContain('modified region: west-commercial')
  })

  it('AC-2: detects added regions', () => {
    const local = [{ ...baseRegion }]
    const eastRegion: RegionConfig = {
      ...baseRegion,
      id: 'east-commercial',
      label: 'East Commercial',
    }
    const drive = [{ ...baseRegion }, eastRegion]
    const result = computeDriveMerge(local, drive)
    expect(result.action).toBe('merge')
    expect(result.changed).toContain('added region: east-commercial')
  })

  it('AC-2: detects removed regions', () => {
    const eastRegion: RegionConfig = {
      ...baseRegion,
      id: 'east-commercial',
      label: 'East Commercial',
    }
    const local = [{ ...baseRegion }, eastRegion]
    const drive = [{ ...baseRegion }]
    const result = computeDriveMerge(local, drive)
    expect(result.action).toBe('merge')
    expect(result.changed).toContain('removed region: east-commercial')
  })

  it('AC-3: preserves local-only fields during merge', () => {
    // Simulate local region having an extra field Drive doesn't know about
    const localRegion = { ...baseRegion, customLocalField: 'preserved' } as RegionConfig & { customLocalField: string }
    const driveRegion = { ...baseRegion } // Drive doesn't have customLocalField

    const result = computeDriveMerge([localRegion], [driveRegion])
    expect(result.action).toBe('merge')
    expect(result.merged).toBeDefined()
    // The merged result should preserve the local-only field
    const merged = result.merged![0] as any
    expect(merged.customLocalField).toBe('preserved')
  })

  it('handles empty regions gracefully', () => {
    const result = computeDriveMerge([], [])
    expect(result.action).toBe('skip')
  })

  it('handles Drive adding regions to empty local', () => {
    const result = computeDriveMerge([], [baseRegion])
    expect(result.action).toBe('merge')
    expect(result.changed).toContain('added region: west-commercial')
  })
})


describe('#738 — Multi-region parentFolderId deduplication', () => {
  it('AC-1: deduplicates parentFolderIds from all regions', () => {
    const regions: RegionConfig[] = [
      {
        id: 'west-commercial', label: 'West', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq', pods: {},
      },
      {
        id: 'east-commercial', label: 'East', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: '', // Not configured
        pods: {},
      },
      {
        id: 'tola', label: 'TOLA', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq', // Same as West
        pods: {},
      },
    ]
    const ids = getUniqueParentFolderIds(regions)
    expect(ids).toEqual(['1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq'])
  })

  it('AC-1: returns multiple unique parentFolderIds when regions differ', () => {
    const regions: RegionConfig[] = [
      {
        id: 'west-commercial', label: 'West', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: 'folderA', pods: {},
      },
      {
        id: 'east-commercial', label: 'East', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: 'folderB', pods: {},
      },
    ]
    const ids = getUniqueParentFolderIds(regions)
    expect(ids).toHaveLength(2)
    expect(ids).toContain('folderA')
    expect(ids).toContain('folderB')
  })

  it('AC-2: unchanged behavior when all regions share same folder', () => {
    const regions: RegionConfig[] = [
      {
        id: 'west-commercial', label: 'West', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: 'sharedFolder', pods: {},
      },
      {
        id: 'tola', label: 'TOLA', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: 'sharedFolder', pods: {},
      },
    ]
    const ids = getUniqueParentFolderIds(regions)
    expect(ids).toEqual(['sharedFolder'])
  })

  it('filters out empty parentFolderIds', () => {
    const regions: RegionConfig[] = [
      {
        id: 'east-commercial', label: 'East', type: 'commercial',
        territorySheetUrl: '', podBookingsFolderId: '',
        parentFolderId: '', pods: {},
      },
    ]
    const ids = getUniqueParentFolderIds(regions)
    expect(ids).toEqual([])
  })
})
