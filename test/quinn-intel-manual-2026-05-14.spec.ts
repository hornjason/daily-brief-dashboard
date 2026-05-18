/**
 * Quinn Intelligence Tab Manual Validation — 2026-05-14
 * Scope: GitHub Issue #201 (Product Roadmap) + #197 (lifecycle fetcher)
 * Environment: prod (7777)
 * Fixed routing: /dashboard/customer/:name
 */

import { test, expect } from '@playwright/test';

test.describe('Intelligence Tab Manual Validation', () => {
  
  test('Navigate to customer and verify Intelligence tab exists', async ({ page }) => {
    // Load dashboard home
    await page.goto('http://localhost:7777');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: '/tmp/quinn-manual-01-home.png', fullPage: true });
    
    // Get a customer from API
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers || [];
    expect(customers.length).toBeGreaterThan(0);
    
    const customer = customers[0];
    console.log(`Testing with customer: ${customer.name}`);
    
    // Navigate using correct route
    const customerUrl = `http://localhost:7777/dashboard/customer/${encodeURIComponent(customer.name)}`;
    console.log(`Navigating to: ${customerUrl}`);
    
    await page.goto(customerUrl);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // Wait for SPA to render
    
    // Screenshot customer detail page
    await page.screenshot({ path: '/tmp/quinn-manual-02-customer-detail.png', fullPage: true });
    
    // Check if Intelligence tab button exists
    const intelligenceTab = page.locator('button', { hasText: 'Intelligence' });
    const tabVisible = await intelligenceTab.isVisible({ timeout: 10000 }).catch(() => false);
    
    console.log(`Intelligence tab visible: ${tabVisible}`);
    
    if (tabVisible) {
      // Click Intelligence tab
      await intelligenceTab.click();
      await page.waitForTimeout(2000);
      
      // Screenshot Intelligence tab
      await page.screenshot({ path: '/tmp/quinn-manual-03-intelligence-tab.png', fullPage: true });
      
      // Check for sections
      const newsHeading = await page.locator('text=Red Hat News').isVisible({ timeout: 5000 }).catch(() => false);
      const roadmapHeading = await page.locator('text=Product Roadmap').isVisible({ timeout: 5000 }).catch(() => false);
      
      console.log(`Red Hat News section visible: ${newsHeading}`);
      console.log(`Product Roadmap section visible: ${roadmapHeading}`);
      
      // Check for table
      const table = await page.locator('table').first().isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`Product table visible: ${table}`);
      
      if (table) {
        const rowCount = await page.locator('table tbody tr').count();
        console.log(`Product rows: ${rowCount}`);
      }
    }
    
    // Log all visible text for debugging
    const pageText = await page.locator('body').innerText();
    console.log('\n--- Page Content Preview ---');
    console.log(pageText.substring(0, 500));
  });
  
  test('Verify API endpoint returns product lifecycle data', async ({ page }) => {
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customer = data.customers[0];
    
    const roadmapResponse = await page.request.get(
      `http://localhost:7777/api/customer/${encodeURIComponent(customer.name)}/intelligence/roadmap`
    );
    
    expect(roadmapResponse.ok()).toBeTruthy();
    const roadmapData = await roadmapResponse.json();
    
    console.log('Roadmap API Response:', JSON.stringify(roadmapData, null, 2));
    
    expect(roadmapData).toHaveProperty('products');
    expect(Array.isArray(roadmapData.products)).toBeTruthy();
    expect(roadmapData.products.length).toBeGreaterThan(0);
    
    // Verify expected products
    const productSlugs = roadmapData.products.map((p: any) => p.slug);
    console.log('Product slugs:', productSlugs);
    
    expect(productSlugs).toContain('ocp');
    expect(productSlugs).toContain('rhel');
    expect(productSlugs).toContain('aap');
  });
});
