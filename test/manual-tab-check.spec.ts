/**
 * Manual inspection of tabbed layout
 * @destructive
 */

import { test, expect } from '@playwright/test';

test.describe('Manual Tab Check @destructive', () => {
  test('inspect dashboard and customer page structure', async ({ page }) => {
    // Go to dashboard
    await page.goto('http://localhost:7776/dashboard');
    await page.waitForLoadState('networkidle');

    // Wait a bit more for React to hydrate
    await page.waitForTimeout(2000);

    // Take screenshot of dashboard
    await page.screenshot({ path: '/tmp/qa-dashboard-7776.png', fullPage: true });

    // Try multiple selectors for customer navigation
    const customerLinks = await page.locator('a[href*="/customer/"]').count();
    const tableRows = await page.locator('table tr').count();
    const customerButtons = await page.locator('button:has-text("Customer"), a:has-text("Workday"), a:has-text("McAfee")').count();

    console.log(`Found ${customerLinks} customer href links`);
    console.log(`Found ${tableRows} table rows`);
    console.log(`Found ${customerButtons} potential customer buttons/links`);

    // Try to find any clickable customer name
    const anyCustomerLink = page.locator('a[href*="/customer/"]').first();
    const linkExists = await anyCustomerLink.count() > 0;

    console.log(`Customer link exists: ${linkExists}`);

    // Try direct navigation to a customer page regardless of links
    console.log('Attempting direct navigation to Acme Corp customer page...');
    await page.goto('http://localhost:7776/dashboard/customer/Acme%20Corp');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Take screenshot of customer detail page
    await page.screenshot({ path: '/tmp/qa-customer-detail-7776.png', fullPage: true });

    // Look for tab elements with different selectors
    const roleTabs = await page.locator('[role="tab"]').count();
    const buttonTabs = await page.locator('button:has-text("Overview"), button:has-text("Campaigns"), button:has-text("News"), button:has-text("Tools")').count();
    const allTabs = await page.locator('*:has-text("Overview"):has-text("Campaigns"):has-text("News"):has-text("Tools")').count();

    console.log(`Found ${roleTabs} [role="tab"] elements`);
    console.log(`Found ${buttonTabs} button-based tabs`);

    // Get HTML of the tab area by searching for text
    const tabAreaHTML = await page.evaluate(() => {
      // Find element containing "Overview" text near top of page
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        const text = (node as Element).textContent || '';
        if (text.includes('Overview') && text.includes('Campaigns') && text.includes('News') && text.includes('Tools')) {
          return (node as Element).outerHTML.slice(0, 2000); // First 2000 chars
        }
      }
      return 'Tab area not found';
    });

    console.log('Tab area HTML:', tabAreaHTML);

    // Try clicking tabs by text regardless of selector
    const tabNames = ['Overview', 'Campaigns', 'News', 'Tools'];
    for (const tabName of tabNames) {
      try {
        // Try multiple selectors
        const selectors = [
          `button:has-text("${tabName}")`,
          `[role="tab"]:has-text("${tabName}")`,
          `:text("${tabName}")`,
        ];

        for (const selector of selectors) {
          const count = await page.locator(selector).count();
          if (count > 0) {
            console.log(`Found ${tabName} tab using selector: ${selector}`);
            await page.locator(selector).first().click();
            await page.waitForTimeout(500);
            const filename = `/tmp/qa-tab-${tabName.toLowerCase()}.png`;
            await page.screenshot({ path: filename, fullPage: true });
            console.log(`Screenshot saved: ${filename}`);
            break;
          }
        }
      } catch (e) {
        console.log(`Failed to click ${tabName} tab:`, e);
      }
    }
  });
});
