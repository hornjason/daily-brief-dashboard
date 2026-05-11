import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * REG-093: Remove Step 1 (OAuth Keys) from setup wizard
 * https://github.com/hornjason/asaCommandCenter/issues/93
 *
 * Verifies:
 * 1. SetupPage.tsx does NOT render "Step 1 of 5 — OAuth Keys" accordion
 * 2. Remaining steps are renumbered (Step 1 through Step 4, not Step 2 through Step 5)
 * 3. Step0OAuthKeys component code is preserved (not deleted)
 */

const SETUP_PAGE_PATH = resolve(import.meta.dir, '../../dashboard/src/pages/SetupPage.tsx')

test('REG-093: OAuth Keys step removed from setup wizard', () => {
  const source = readFileSync(SETUP_PAGE_PATH, 'utf-8')

  // Verify the OAuth Keys section is wrapped in {false && (...)} to prevent rendering
  const hasConditionalFalse = /\{false &&[\s\S]*?id="oauth-keys"/m.test(source)
  expect(hasConditionalFalse).toBe(true)

  // Verify Step0OAuthKeys component is still in the file (after the AccordionSection)
  const hasPreservedComponent = source.includes('Step0OAuthKeys onReady')
  expect(hasPreservedComponent).toBe(true)
})

test('REG-093: Remaining steps renumbered to 1-4 (not 2-5)', () => {
  const source = readFileSync(SETUP_PAGE_PATH, 'utf-8')

  // After removing Step 1 (OAuth Keys), the wizard should show:
  // - Step 1 of 4 — Google Auth
  // - Step 2 of 4 — Connections
  // - Step 3 of 4 — AEs & Customers
  // - Step 4 of 4 — AI & Intelligence Settings (optional)

  // Should have "Step 1 of 4" (not "Step 2 of 5")
  expect(source).toContain('Step 1 of 4')

  // Should have "Step 2 of 4" (not "Step 3 of 5")
  expect(source).toContain('Step 2 of 4')

  // Should have "Step 3 of 4" (not "Step 4 of 5")
  expect(source).toContain('Step 3 of 4')

  // Should NOT have old numbering
  expect(source).not.toContain('Step 2 of 5')
  expect(source).not.toContain('Step 3 of 5')
  expect(source).not.toContain('Step 4 of 5')
})

test('REG-093: Step0OAuthKeys component code preserved', () => {
  const source = readFileSync(SETUP_PAGE_PATH, 'utf-8')

  // The Step0OAuthKeys function definition should still exist
  expect(source).toContain('function Step0OAuthKeys')

  // Implementation details should be preserved
  expect(source).toContain('GDRIVE_KEYS_URL')
  expect(source).toContain('/api/setup/oauth-keys-status')
})
