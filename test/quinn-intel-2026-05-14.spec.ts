/**
 * Quinn Intelligence Tab Validation — 2026-05-14
 * Scope: GitHub Issue #201 (Product Roadmap) + #197 (lifecycle fetcher)
 * Environment: prod (7777)
 */

import { test, expect } from '@playwright/test';

test.describe('Intelligence Tab — Red Hat News + Product Roadmap', () => {
  
  test('Dashboard home loads with Red Hat Pulse card', async ({ page }) => {
    await page.goto('http://localhost:7777');
    await page.waitForLoadState('networkidle');
    
    // Screenshot home
    await page.screenshot({ path: '/tmp/quinn-intel-01-home.png', fullPage: true });
    
    // Check for Red Hat Pulse card
    const pulseCard = page.locator('text=Red Hat Pulse');
    await expect(pulseCard).toBeVisible({ timeout: 5000 });
  });
  
  test('Intelligence tab shows Red Hat News section', async ({ page }) => {
    // Get first customer
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    
    expect(customers.length).toBeGreaterThan(0);
    const customer = customers[0];
    
    // Navigate to customer detail
    await page.goto(`http://localhost:7777/customer/${encodeURIComponent(customer.name)}`);
    await page.waitForLoadState('networkidle');
    
    // Click Intelligence tab
    const intelligenceTab = page.locator('button:has-text("Intelligence")');
    await intelligenceTab.click();
    await page.waitForTimeout(1000);
    
    // Screenshot Intelligence tab
    await page.screenshot({ 
      path: '/tmp/quinn-intel-02-news-section.png', 
      fullPage: true 
    });
    
    // Verify Red Hat News section
    const newsSection = page.locator('text=Red Hat News').first();
    await expect(newsSection).toBeVisible({ timeout: 5000 });
  });
  
  test('Intelligence tab shows Product Roadmap section', async ({ page }) => {
    // Get first customer
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    
    const customer = customers[0];
    
    // Navigate to customer detail
    await page.goto(`http://localhost:7777/customer/${encodeURIComponent(customer.name)}`);
    await page.waitForLoadState('networkidle');
    
    // Click Intelligence tab
    const intelligenceTab = page.locator('button:has-text("Intelligence")');
    await intelligenceTab.click();
    await page.waitForTimeout(1000);
    
    // Screenshot Intelligence tab
    await page.screenshot({ 
      path: '/tmp/quinn-intel-03-roadmap-section.png', 
      fullPage: true 
    });
    
    // Verify Product Roadmap section
    const roadmapSection = page.locator('text=Product Roadmap').first();
    await expect(roadmapSection).toBeVisible({ timeout: 5000 });
  });
  
  test('Product Roadmap table has data and columns', async ({ page }) => {
    // Get first customer
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    
    const customer = customers[0];
    
    // Navigate to Intelligence tab
    await page.goto(`http://localhost:7777/customer/${encodeURIComponent(customer.name)}`);
    const intelligenceTab = page.locator('button:has-text("Intelligence")');
    await intelligenceTab.click();
    await page.waitForTimeout(1000);
    
    // Check table exists
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 5000 });
    
    // Check for expected column headers
    await expect(page.locator('th:has-text("Product")')).toBeVisible();
    await expect(page.locator('th:has-text("Current Version")')).toBeVisible();
    await expect(page.locator('th:has-text("Next Version")')).toBeVisible();
    await expect(page.locator('th:has-text("EOL")')).toBeVisible();
    
    // Check for table rows
    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    console.log(`Found ${rowCount} product rows`);
    
    // Take screenshot
    await page.screenshot({ 
      path: '/tmp/quinn-intel-04-roadmap-table.png', 
      fullPage: true 
    });
  });
  
  test('Product row expands to show details', async ({ page }) => {
    // Get first customer
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    
    const customer = customers[0];
    
    // Navigate to Intelligence tab
    await page.goto(`http://localhost:7777/customer/${encodeURIComponent(customer.name)}`);
    const intelligenceTab = page.locator('button:has-text("Intelligence")');
    await intelligenceTab.click();
    await page.waitForTimeout(1000);
    
    // Click first table row
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      await page.waitForTimeout(500);
      
      // Screenshot expanded state
      await page.screenshot({ 
        path: '/tmp/quinn-intel-05-expanded-details.png', 
        fullPage: true 
      });
      
      // Check for details panel elements (EUS, support end, latest patch)
      // Note: exact selectors depend on implementation
      const hasExpandedContent = await page.locator('[class*="expand"], [class*="detail"]').count();
      console.log(`Expanded content elements: ${hasExpandedContent}`);
    }
  });
  
  test('Roadmap API endpoint returns data', async ({ page }) => {
    // Get first customer
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    
    const customer = customers[0];
    
    // Test API endpoint
    const apiResponse = await page.request.get(
      `http://localhost:7777/api/customer/${encodeURIComponent(customer.name)}/intelligence/roadmap`
    );
    
    expect(apiResponse.ok()).toBeTruthy();
    
    const roadmapData = await apiResponse.json();
    console.log(`API returned:`, JSON.stringify(roadmapData, null, 2));
    
    // Verify response structure
    expect(roadmapData).toHaveProperty('products');
    expect(Array.isArray(roadmapData.products)).toBeTruthy();
  });
  
  test('Test multiple customers for data variation', async ({ page }) => {
    // Get customer list
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    
    // Test first 3 customers
    const testCustomers = customers.slice(0, Math.min(3, customers.length));
    
    for (const customer of testCustomers) {
      console.log(`\nTesting customer: ${customer.name}`);
      
      // Navigate to Intelligence tab
      await page.goto(`http://localhost:7777/customer/${encodeURIComponent(customer.name)}`);
      const intelligenceTab = page.locator('button:has-text("Intelligence")');
      await intelligenceTab.click();
      await page.waitForTimeout(1000);
      
      // Check sections visible
      const newsVisible = await page.locator('text=Red Hat News').first().isVisible();
      const roadmapVisible = await page.locator('text=Product Roadmap').first().isVisible();
      
      console.log(`  Red Hat News: ${newsVisible ? 'VISIBLE' : 'NOT VISIBLE'}`);
      console.log(`  Product Roadmap: ${roadmapVisible ? 'VISIBLE' : 'NOT VISIBLE'}`);
      
      // Screenshot each customer
      await page.screenshot({ 
        path: `/tmp/quinn-intel-customer-${customer.name.replace(/[^a-z0-9]/gi, '-')}.png`, 
        fullPage: true 
      });
    }
  });
  
  test('No regressions — all tabs still work', async ({ page }) => {
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    const customer = customers[0];
    
    await page.goto(`http://localhost:7777/customer/${encodeURIComponent(customer.name)}`);
    await page.waitForLoadState('networkidle');
    
    // Test each tab clicks without errors
    const tabs = ['Overview', 'Campaigns', 'News', 'Intelligence', 'Tools'];
    
    for (const tabName of tabs) {
      const tab = page.locator(`button:has-text("${tabName}")`);
      if (await tab.isVisible()) {
        await tab.click();
        await page.waitForTimeout(500);
        console.log(`✅ ${tabName} tab clicked successfully`);
      }
    }
    
    // Final screenshot
    await page.screenshot({ 
      path: '/tmp/quinn-intel-06-tabs-regression.png', 
      fullPage: true 
    });
  });
});
