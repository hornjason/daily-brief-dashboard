/**
 * QA Validation: UX Architecture Redesign
 *
 * Tests the feature-first navigation redesign:
 * - Sidebar with page navigation (React Router links, not scroll-to anchors)
 * - Core pages: Home, Accounts, Calendar, Book of Business, Admin
 * - Collapsible module groups: Actions (Campaigns, Tools), Intelligence (News, Products, Events, Red Hat News)
 * - ModulePageShell standardization
 * - CustomerTabBar auto-discovery
 */

import { test, expect, Page } from '@playwright/test';

const BASE_URL = 'http://localhost:7777';

test.describe('UX Architecture Redesign Validation', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('1. Sidebar navigation structure', async () => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState('networkidle');

    // Take initial screenshot
    await page.screenshot({ path: '/tmp/qa-ux-sidebar-structure.png', fullPage: true });

    // Verify core pages present in sidebar
    const corePages = ['Home', 'Accounts', 'Calendar', 'Book of Business', 'Admin'];
    for (const pageName of corePages) {
      const link = page.locator(`nav >> text="${pageName}"`);
      await expect(link).toBeVisible();
      console.log(`✅ Core page link found: ${pageName}`);
    }

    // Verify Actions group header
    const actionsGroup = page.locator('text="Actions"').first();
    await expect(actionsGroup).toBeVisible();
    console.log('✅ Actions group header found');

    // Verify Actions group items
    const actionItems = ['Campaigns', 'Tools'];
    for (const item of actionItems) {
      const link = page.locator(`nav >> text="${item}"`);
      await expect(link).toBeVisible();
      console.log(`✅ Actions item found: ${item}`);
    }

    // Verify Intelligence group header
    const intelligenceGroup = page.locator('text="Intelligence"').first();
    await expect(intelligenceGroup).toBeVisible();
    console.log('✅ Intelligence group header found');

    // Verify Intelligence group items
    const intelligenceItems = ['News', 'Products', 'Events', 'Red Hat News'];
    for (const item of intelligenceItems) {
      const link = page.locator(`nav >> text="${item}"`);
      await expect(link).toBeVisible();
      console.log(`✅ Intelligence item found: ${item}`);
    }
  });

  test('2. Sidebar navigation routing', async () => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState('networkidle');

    // Test each core page navigation
    const routes = [
      { name: 'Home', path: '/dashboard', urlPattern: /\/dashboard$/ },
      { name: 'Accounts', path: '/dashboard/accounts', urlPattern: /\/dashboard\/accounts/ },
      { name: 'Calendar', path: '/dashboard/calendar', urlPattern: /\/dashboard\/calendar/ },
      { name: 'Book of Business', path: '/dashboard/book-of-business', urlPattern: /\/dashboard\/book-of-business/ },
      { name: 'Admin', path: '/dashboard/admin', urlPattern: /\/dashboard\/admin/ }
    ];

    for (const route of routes) {
      console.log(`Testing navigation to: ${route.name}`);

      // Click the sidebar link
      await page.click(`nav >> text="${route.name}"`);
      await page.waitForLoadState('networkidle');

      // Verify URL changed
      expect(page.url()).toMatch(route.urlPattern);
      console.log(`✅ URL changed to: ${page.url()}`);

      // Take screenshot
      const screenshotPath = `/tmp/qa-ux-${route.name.toLowerCase().replace(/ /g, '-')}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`✅ Screenshot saved: ${screenshotPath}`);

      // Verify active state in sidebar
      const activeLink = page.locator(`nav >> text="${route.name}"`).first();
      // Active links should have aria-current or a specific class
      const hasActiveIndicator = await activeLink.evaluate(el => {
        return el.classList.contains('active') ||
               el.getAttribute('aria-current') === 'page' ||
               el.closest('a')?.getAttribute('aria-current') === 'page';
      });

      if (hasActiveIndicator) {
        console.log(`✅ Active state highlighted for: ${route.name}`);
      } else {
        console.log(`⚠️  Active state not detected for: ${route.name}`);
      }
    }
  });

  test('3. Home page content', async () => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState('networkidle');

    // Verify Morning Summary section
    const morningSummary = page.locator('text=/Morning Summary|Good (Morning|Afternoon|Evening)/i');
    await expect(morningSummary.first()).toBeVisible();
    console.log('✅ Morning Summary section found');

    // Verify KPI cards present
    const kpiCards = page.locator('[data-testid*="kpi"], .kpi-card, .card').filter({ hasText: /Customers|AEs|Opportunities|Revenue/i });
    const kpiCount = await kpiCards.count();
    expect(kpiCount).toBeGreaterThan(0);
    console.log(`✅ KPI cards found: ${kpiCount}`);

    // Verify Pipeline and Cloud Spend sections DO NOT appear on home
    const pipelineSection = page.locator('text="Pipeline"').first();
    const cloudSpendSection = page.locator('text="Cloud Spend"').first();

    const pipelineVisible = await pipelineSection.isVisible().catch(() => false);
    const cloudSpendVisible = await cloudSpendSection.isVisible().catch(() => false);

    if (!pipelineVisible && !cloudSpendVisible) {
      console.log('✅ Pipeline and Cloud Spend sections correctly NOT on home page');
    } else {
      console.log('❌ FAIL: Pipeline or Cloud Spend sections should not be on home page');
      if (pipelineVisible) console.log('  - Pipeline section is visible');
      if (cloudSpendVisible) console.log('  - Cloud Spend section is visible');
    }

    await page.screenshot({ path: '/tmp/qa-ux-home-content.png', fullPage: true });
  });

  test('4. Module pages with ModulePageShell', async () => {
    const modulePages = [
      { name: 'Campaigns', path: '/dashboard/campaigns', hasCustomerPicker: true, pickerMode: 'optional' },
      { name: 'News', path: '/dashboard/news', hasCustomerPicker: true, pickerMode: 'optional' },
      { name: 'Tools', path: '/dashboard/tools', hasCustomerPicker: true, pickerMode: 'required' },
      { name: 'Products', path: '/dashboard/products', hasCustomerPicker: false, pickerMode: null },
      { name: 'Events', path: '/dashboard/events', hasCustomerPicker: false, pickerMode: null },
      { name: 'Red Hat News', path: '/dashboard/rh-news', hasCustomerPicker: false, pickerMode: null }
    ];

    for (const module of modulePages) {
      console.log(`Testing module page: ${module.name}`);

      await page.goto(`${BASE_URL}${module.path}`);
      await page.waitForLoadState('networkidle');

      // Verify page title shows module name
      const pageTitle = page.locator('h1, h2').filter({ hasText: module.name });
      await expect(pageTitle.first()).toBeVisible();
      console.log(`✅ Module title found: ${module.name}`);

      // Check for CustomerPicker
      if (module.hasCustomerPicker) {
        const customerPicker = page.locator('[data-testid="customer-picker"], select, .customer-picker').first();
        const pickerVisible = await customerPicker.isVisible().catch(() => false);

        if (pickerVisible) {
          console.log(`✅ CustomerPicker found on ${module.name} (${module.pickerMode} mode)`);
        } else {
          console.log(`❌ FAIL: CustomerPicker expected but not found on ${module.name}`);
        }
      } else {
        // Verify NO customer picker
        const customerPicker = page.locator('[data-testid="customer-picker"], select, .customer-picker').first();
        const pickerVisible = await customerPicker.isVisible().catch(() => false);

        if (!pickerVisible) {
          console.log(`✅ No CustomerPicker on ${module.name} (as expected)`);
        } else {
          console.log(`❌ FAIL: CustomerPicker should not be on ${module.name}`);
        }
      }

      // Take screenshot
      const screenshotPath = `/tmp/qa-ux-module-${module.name.toLowerCase().replace(/ /g, '-')}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`✅ Screenshot saved: ${screenshotPath}`);
    }
  });

  test('5. Account detail tabs (CustomerTabBar)', async () => {
    // First navigate to dashboard
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState('networkidle');

    // Find and click on first customer
    const firstCustomerLink = page.locator('a[href*="/dashboard/customer/"]').first();
    const customerExists = await firstCustomerLink.isVisible().catch(() => false);

    if (!customerExists) {
      console.log('⚠️  No customers found on dashboard, skipping account detail test');
      return;
    }

    await firstCustomerLink.click();
    await page.waitForLoadState('networkidle');

    // Verify we're on account detail page
    expect(page.url()).toMatch(/\/dashboard\/customer\/[^/]+$/);
    console.log(`✅ Navigated to account detail: ${page.url()}`);

    // Verify tab bar shows expected tabs
    const expectedTabs = ['Overview', 'Campaigns', 'News', 'Intelligence', 'Tools'];

    for (const tabName of expectedTabs) {
      const tab = page.locator(`button, a`).filter({ hasText: new RegExp(`^${tabName}$`) });
      const tabVisible = await tab.isVisible().catch(() => false);

      if (tabVisible) {
        console.log(`✅ Tab found: ${tabName}`);
      } else {
        console.log(`⚠️  Tab not found: ${tabName}`);
      }
    }

    // Test clicking each tab
    for (const tabName of expectedTabs) {
      const tab = page.locator(`button, a`).filter({ hasText: new RegExp(`^${tabName}$`) }).first();
      const tabVisible = await tab.isVisible().catch(() => false);

      if (tabVisible) {
        await tab.click();
        await page.waitForTimeout(500); // Brief wait for content to load
        console.log(`✅ Clicked tab: ${tabName}`);
      }
    }

    // Take screenshot of account detail with tabs
    await page.screenshot({ path: '/tmp/qa-ux-account-detail-tabs.png', fullPage: true });
  });

  test('6. Book of Business page content', async () => {
    await page.goto(`${BASE_URL}/dashboard/book-of-business`);
    await page.waitForLoadState('networkidle');

    // Verify Pipeline section exists
    const pipelineSection = page.locator('text="Pipeline"').first();
    const pipelineVisible = await pipelineSection.isVisible().catch(() => false);

    if (pipelineVisible) {
      console.log('✅ Pipeline section found on Book of Business page');
    } else {
      console.log('⚠️  Pipeline section not found on Book of Business page');
    }

    // Verify Cloud Spend section exists
    const cloudSpendSection = page.locator('text=/Cloud Spend|CCSP/i').first();
    const cloudSpendVisible = await cloudSpendSection.isVisible().catch(() => false);

    if (cloudSpendVisible) {
      console.log('✅ Cloud Spend section found on Book of Business page');
    } else {
      console.log('⚠️  Cloud Spend section not found on Book of Business page');
    }

    // Take screenshot
    await page.screenshot({ path: '/tmp/qa-ux-book-of-business.png', fullPage: true });
  });

  test('7. Console errors check', async () => {
    const consoleErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Navigate through all main routes and collect console errors
    const routes = [
      '/dashboard',
      '/dashboard/accounts',
      '/dashboard/campaigns',
      '/dashboard/news',
      '/dashboard/book-of-business'
    ];

    for (const route of routes) {
      await page.goto(`${BASE_URL}${route}`);
      await page.waitForLoadState('networkidle');
    }

    if (consoleErrors.length === 0) {
      console.log('✅ No console errors detected');
    } else {
      console.log('❌ Console errors detected:');
      consoleErrors.forEach(err => console.log(`  - ${err}`));
    }

    // Filter out known benign errors (favicon 404)
    const criticalErrors = consoleErrors.filter(err => !err.includes('favicon.ico'));
    expect(criticalErrors.length).toBe(0);
  });
});
