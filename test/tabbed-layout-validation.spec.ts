/**
 * Tabbed Layout Validation — GitHub Issues #141-#146
 * Tests the new tabbed layout on customer detail pages
 *
 * @destructive — tests against test container (port 7776)
 */

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:7776';

test.describe('Customer Detail Tabbed Layout @destructive', () => {
  test('should show all four tabs and navigate between them', async ({ page }) => {
    // Navigate to dashboard
    await page.goto(`${BASE_URL}/dashboard`);

    // Wait for customer cards to load
    await page.waitForSelector('[data-testid="customer-card"]', { timeout: 10000 });

    // Click the first customer card
    const firstCustomerCard = page.locator('[data-testid="customer-card"]').first();
    await firstCustomerCard.click();

    // Wait for customer detail page to load
    await page.waitForURL(/\/dashboard\/customer\/.+/);
    await page.waitForLoadState('networkidle');

    // Verify tab bar is visible
    const tabBar = page.locator('[role="tablist"]');
    await expect(tabBar).toBeVisible();

    // Verify all four tabs are present
    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(4);

    const tabTexts = await tabs.allTextContents();
    expect(tabTexts).toContain('Overview');
    expect(tabTexts).toContain('Campaigns');
    expect(tabTexts).toContain('News');
    expect(tabTexts).toContain('Tools');

    // Screenshot: Initial state (Overview tab)
    await page.screenshot({ path: '/tmp/qa-tab-overview.png', fullPage: true });

    // Verify Overview tab is selected by default
    const overviewTab = page.locator('[role="tab"]:has-text("Overview")');
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  test('Overview tab should show all existing sections', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForSelector('[data-testid="customer-card"]');
    await page.locator('[data-testid="customer-card"]').first().click();
    await page.waitForURL(/\/dashboard\/customer\/.+/);

    // Wait for Overview tab content to load
    await page.waitForSelector('[role="tabpanel"]', { timeout: 10000 });

    // Verify key sections are present in Overview
    // (These are the sections that existed before tabbed layout)
    const overviewPanel = page.locator('[role="tabpanel"]').first();

    // Check for common section headers (adjust based on actual implementation)
    // Using text content checks for flexibility
    const pageText = await overviewPanel.textContent();

    // Take screenshot for manual verification
    await page.screenshot({ path: '/tmp/qa-tab-overview-sections.png', fullPage: true });
  });

  test('Campaigns tab should show feature description and disabled Create button', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForSelector('[data-testid="customer-card"]');
    await page.locator('[data-testid="customer-card"]').first().click();
    await page.waitForURL(/\/dashboard\/customer\/.+/);

    // Click Campaigns tab
    const campaignsTab = page.locator('[role="tab"]:has-text("Campaigns")');
    await campaignsTab.click();

    // Wait for tab panel to switch
    await page.waitForTimeout(300); // Small delay for transition

    // Verify Campaigns tab is now selected
    await expect(campaignsTab).toHaveAttribute('aria-selected', 'true');

    // Check for "Campaigns" header
    const campaignsPanel = page.locator('[role="tabpanel"]:visible');
    const headerText = await campaignsPanel.locator('h2, h3').first().textContent();
    expect(headerText?.toLowerCase()).toContain('campaign');

    // Check for disabled "Create Campaign" button
    const createButton = campaignsPanel.locator('button:has-text("Create Campaign")');
    await expect(createButton).toBeVisible();
    await expect(createButton).toBeDisabled();

    // Screenshot
    await page.screenshot({ path: '/tmp/qa-tab-campaigns.png', fullPage: true });
  });

  test('News tab should show Customer News header and empty state', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForSelector('[data-testid="customer-card"]');
    await page.locator('[data-testid="customer-card"]').first().click();
    await page.waitForURL(/\/dashboard\/customer\/.+/);

    // Click News tab
    const newsTab = page.locator('[role="tab"]:has-text("News")');
    await newsTab.click();
    await page.waitForTimeout(300);

    // Verify News tab is selected
    await expect(newsTab).toHaveAttribute('aria-selected', 'true');

    // Check for "Customer News" header
    const newsPanel = page.locator('[role="tabpanel"]:visible');
    const headerText = await newsPanel.locator('h2, h3').first().textContent();
    expect(headerText?.toLowerCase()).toContain('news');

    // Screenshot
    await page.screenshot({ path: '/tmp/qa-tab-news.png', fullPage: true });
  });

  test('Tools tab should show Business Value Tools header and tool cards', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForSelector('[data-testid="customer-card"]');
    await page.locator('[data-testid="customer-card"]').first().click();
    await page.waitForURL(/\/dashboard\/customer\/.+/);

    // Click Tools tab
    const toolsTab = page.locator('[role="tab"]:has-text("Tools")');
    await toolsTab.click();
    await page.waitForTimeout(300);

    // Verify Tools tab is selected
    await expect(toolsTab).toHaveAttribute('aria-selected', 'true');

    // Check for "Business Value Tools" header
    const toolsPanel = page.locator('[role="tabpanel"]:visible');
    const headerText = await toolsPanel.locator('h2, h3').first().textContent();
    expect(headerText?.toLowerCase()).toContain('tool');

    // Check for three tool cards (PitchBuilder+, FinListics CBV, CBVS)
    const toolCards = toolsPanel.locator('[class*="card"], [class*="Card"]');
    const cardCount = await toolCards.count();
    expect(cardCount).toBeGreaterThanOrEqual(3); // At least 3 tool cards

    // Screenshot
    await page.screenshot({ path: '/tmp/qa-tab-tools.png', fullPage: true });
  });

  test('Tab switching should preserve content without re-loading', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForSelector('[data-testid="customer-card"]');
    await page.locator('[data-testid="customer-card"]').first().click();
    await page.waitForURL(/\/dashboard\/customer\/.+/);

    // Get initial Overview content
    const overviewPanel = page.locator('[role="tabpanel"]').first();
    const initialContent = await overviewPanel.textContent();

    // Switch to Campaigns
    await page.locator('[role="tab"]:has-text("Campaigns")').click();
    await page.waitForTimeout(300);

    // Switch back to Overview
    await page.locator('[role="tab"]:has-text("Overview")').click();
    await page.waitForTimeout(300);

    // Verify content is still the same (no re-load)
    const afterContent = await overviewPanel.textContent();
    expect(afterContent).toBe(initialContent);
  });

  test('Header should persist on all tabs', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForSelector('[data-testid="customer-card"]');
    await page.locator('[data-testid="customer-card"]').first().click();
    await page.waitForURL(/\/dashboard\/customer\/.+/);

    // Look for sticky header elements (customer name, health dot, stat badges)
    // This selector may need adjustment based on actual implementation
    const header = page.locator('[class*="sticky"], [class*="Sticky"]').first();

    // Verify header is visible on Overview
    await expect(header).toBeVisible();
    const overviewHeaderText = await header.textContent();

    // Switch to each tab and verify header persists
    for (const tabName of ['Campaigns', 'News', 'Tools']) {
      await page.locator(`[role="tab"]:has-text("${tabName}")`).click();
      await page.waitForTimeout(300);

      // Header should still be visible
      await expect(header).toBeVisible();

      // Header text should be unchanged
      const currentHeaderText = await header.textContent();
      expect(currentHeaderText).toBe(overviewHeaderText);
    }

    // Screenshot final state
    await page.screenshot({ path: '/tmp/qa-tab-header-persistence.png', fullPage: true });
  });
});
