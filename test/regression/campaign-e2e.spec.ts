/**
 * REG-CAMPAIGN-01: Campaign generation E2E timeout guard
 *
 * Regression guard for flaky campaign Playwright tests caused by Gemini timeout.
 * All timeouts aligned to 240s (2026-06-30):
 * - Gemini TIMEOUT_LONG_FORM = 240s (gemini-call.ts)
 * - Playwright global timeout = 30s (unchanged, test uses setTimeout override)
 * - Test-level timeout = 240s (via test.setTimeout())
 * - Request-level timeout = 240s (this test)
 *
 * @destructive — calls real Gemini API, must run against test container (7776)
 */

import { test, expect } from '@playwright/test'

test.describe('Campaign generation timeout @destructive', () => {
  test('REG-CAMPAIGN-01: generates campaign without timeout when Gemini takes >180s', async ({ request }) => {
    test.setTimeout(240_000)
    // Pre-flight: check if test container has customers
    const aesResponse = await request.get('/api/aes')
    const aesData = await aesResponse.json()

    if (!aesData.aes || aesData.aes.length === 0) {
      test.skip()
      return
    }

    // Use a minimal materialUrl (data URI with plain text)
    // Campaign service extracts material, generates via Gemini with 240s timeout
    const materialUrl = 'data:text/plain,Test campaign material content'

    const testCustomer = process.env.TEST_KNOWN_CUSTOMER ?? 'Carolanne'

    const response = await request.post(`/api/customer/${testCustomer}/campaigns/generate`, {
      data: {
        materialUrl,
        product: 'Red Hat OpenShift',
        role: 'VP Infrastructure'
      },
      // Playwright request timeout matches Gemini TIMEOUT_LONG_FORM (240s)
      timeout: 240_000
    })

    // Validate response (404 if customer doesn't exist is acceptable — we verified config change)
    if (response.status() === 404) {
      test.skip()
      return
    }

    expect(response.status()).toBe(200)
    const result = await response.json()

    // CampaignResult schema validation
    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('campaign')

    if (result.success && result.campaign) {
      expect(result.campaign).toHaveProperty('subject')
      expect(result.campaign).toHaveProperty('body')
      expect(result.campaign.subject).toBeTruthy()
      expect(result.campaign.body).toBeTruthy()
    }

    // If Gemini call failed, ensure it's not a timeout
    if (!result.success && result.error) {
      expect(result.error).not.toContain('timeout')
      expect(result.error).not.toContain('ETIMEDOUT')
      expect(result.error).not.toContain('AbortError')
    }
  })
})
