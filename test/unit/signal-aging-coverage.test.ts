/**
 * GitHub Issue #374 — Signal aging: verify all signal-displaying components use SignalWithAging
 *
 * This test ensures that every component which renders timestamped signal data
 * imports and uses the SignalWithAging wrapper for consistent visual aging.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const DASHBOARD_SRC = resolve(import.meta.dir, '../../dashboard/src')

/**
 * Components that display timestamped signals and MUST use SignalWithAging.
 * Each entry: [file path relative to dashboard/src, description]
 */
const SIGNAL_DISPLAY_COMPONENTS: [string, string][] = [
  ['components/TechStackSection.tsx', 'Tech Stack signals'],
  ['components/tabs/TechStackTab.tsx', 'Tech Stack tab signals'],
  ['components/tabs/NewsTab.tsx', 'News articles with published dates'],
  ['components/tabs/IntelligenceTab.tsx', 'Intelligence tab news/events with timestamps'],
]

describe('Signal aging coverage (#374)', () => {
  for (const [filePath, description] of SIGNAL_DISPLAY_COMPONENTS) {
    test(`${description} (${filePath}) imports SignalWithAging`, () => {
      const fullPath = resolve(DASHBOARD_SRC, filePath)
      const content = readFileSync(fullPath, 'utf-8')
      expect(content).toContain('SignalWithAging')
    })
  }
})
