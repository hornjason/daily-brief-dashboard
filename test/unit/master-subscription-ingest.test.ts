import { describe, test, expect } from 'bun:test'
import { detectMasterSheets, formatMasterIngestSummary } from '../../src/sf-bookings-reader.ts'

describe('Issue #816: Master Subscription Sheet Auto-Ingest', () => {
  describe('detectMasterSheets', () => {
    test('AC-2: detects sheets whose name starts with "Master" (case-insensitive)', () => {
      const sheets = [
        { name: 'Northwest POD - Subscriptions', displayName: 'Northwest', sheetId: 'a' },
        { name: 'Master - Subscriptions - 06.15.26', displayName: 'Master', sheetId: 'b' },
        { name: 'East Comm Corp POD01 - Subscriptions', displayName: 'East', sheetId: 'c' },
      ]
      const masters = detectMasterSheets(sheets)
      expect(masters).toHaveLength(1)
      expect(masters[0].sheetId).toBe('b')
    })

    test('AC-2: case-insensitive detection', () => {
      const sheets = [
        { name: 'MASTER Subscriptions 2026', displayName: 'MASTER', sheetId: 'x' },
      ]
      expect(detectMasterSheets(sheets)).toHaveLength(1)
    })

    test('AC-A2: returns empty when no master sheet exists', () => {
      const sheets = [
        { name: 'Northwest POD - Subscriptions', displayName: 'Northwest', sheetId: 'a' },
        { name: 'East Comm Corp POD01', displayName: 'East', sheetId: 'b' },
      ]
      expect(detectMasterSheets(sheets)).toHaveLength(0)
    })

    test('AC-11: multiple masters sorted by modifiedTime descending (newest first)', () => {
      const sheets = [
        { name: 'Master - March', displayName: 'Master', sheetId: 'old', modifiedTime: '2026-03-01T00:00:00Z' },
        { name: 'Master - June', displayName: 'Master', sheetId: 'new', modifiedTime: '2026-06-15T00:00:00Z' },
      ]
      const masters = detectMasterSheets(sheets)
      expect(masters).toHaveLength(2)
      expect(masters[0].sheetId).toBe('new')
      expect(masters[1].sheetId).toBe('old')
    })

    test('AC-11: handles missing modifiedTime gracefully', () => {
      const sheets = [
        { name: 'Master - A', displayName: 'Master', sheetId: 'a' },
        { name: 'Master - B', displayName: 'Master', sheetId: 'b', modifiedTime: '2026-06-01T00:00:00Z' },
      ]
      const masters = detectMasterSheets(sheets)
      expect(masters).toHaveLength(2)
      expect(masters[0].sheetId).toBe('b')
    })

    test('does not match "Mastered" or "MasterClass" (word boundary)', () => {
      const sheets = [
        { name: 'Mastered Data Sheet', displayName: 'Mastered', sheetId: 'x' },
        { name: 'MasterClass Notes', displayName: 'MasterClass', sheetId: 'y' },
      ]
      expect(detectMasterSheets(sheets)).toHaveLength(0)
    })
  })

  describe('formatMasterIngestSummary', () => {
    test('AC-8: formats structured summary correctly', () => {
      const summary = formatMasterIngestSummary({
        totalTerritories: 4,
        totalRows: 5000,
        overwritten: ['AE-Northwest', 'AE-Southwest'],
        created: ['AE-HighPlains'],
        skipped: ['AE-East'],
      })
      expect(summary).toContain('[master-ingest]')
      expect(summary).toContain('4 territories')
      expect(summary).toContain('5000 rows')
      expect(summary).toContain('AE-Northwest')
      expect(summary).toContain('AE-HighPlains')
      expect(summary).toContain('AE-East')
    })

    test('AC-8: handles empty lists', () => {
      const summary = formatMasterIngestSummary({
        totalTerritories: 0,
        totalRows: 0,
        overwritten: [],
        created: [],
        skipped: [],
      })
      expect(summary).toContain('none')
    })
  })
})
