import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Admin page regression guard', () => {
  const adminPath = resolve(import.meta.dir, '../../dashboard/src/pages/AdminPage.tsx')
  const content = readFileSync(adminPath, 'utf-8')
  const lineCount = content.split('\n').length

  test('AdminPage.tsx is the thin layout (<100 lines), not the old god component', () => {
    expect(lineCount).toBeLessThan(100)
  })

  test('AdminPage imports SystemOverviewPanel', () => {
    expect(content).toContain('SystemOverviewPanel')
  })

  test('AdminPage imports DataSourcesPanel', () => {
    expect(content).toContain('DataSourcesPanel')
  })

  test('AdminPage imports OperationsPanel', () => {
    expect(content).toContain('OperationsPanel')
  })

  test('AdminPage imports SettingsPanel', () => {
    expect(content).toContain('SettingsPanel')
  })

  test('AdminPage does NOT contain inline section components (old pattern)', () => {
    expect(content).not.toContain('ScrapeSection')
    expect(content).not.toContain('SchedulerConfig')
    expect(content).not.toContain('BatchIntelligenceSection')
    expect(content).not.toContain('CacheManagementSection')
  })

  test('Admin panel components exist as separate files', () => {
    const panelDir = resolve(import.meta.dir, '../../dashboard/src/components/admin')
    const panels = ['SystemOverviewPanel.tsx', 'DataSourcesPanel.tsx', 'OperationsPanel.tsx', 'SettingsPanel.tsx']
    for (const panel of panels) {
      const exists = (() => { try { readFileSync(resolve(panelDir, panel)); return true } catch { return false } })()
      expect(exists).toBe(true)
    }
  })
})
