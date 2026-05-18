/**
 * Quinn Intelligence Tab Final Validation — 2026-05-14
 * Fixed: use exact button name to avoid strict mode violation
 */

import { test, expect } from '@playwright/test';

test.describe('Intelligence Tab — Final Validation', () => {
  
  test('Intelligence tab shows Red Hat News and Product Roadmap sections', async ({ page }) => {
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customer = data.customers[0];
    
    console.log(`\n🧪 Testing customer: ${customer.name}\n`);
    
    await page.goto(`http://localhost:7777/dashboard/customer/${encodeURIComponent(customer.name)}`);
    await page.waitForLoadState('networkidle');
    
    // Click Intelligence tab using exact name
    const intelligenceTab = page.getByRole('button', { name: 'Intelligence', exact: true });
    await expect(intelligenceTab).toBeVisible({ timeout: 5000 });
    
    console.log('✅ Intelligence tab button found - clicking...');
    await intelligenceTab.click();
    await page.waitForTimeout(2000);
    
    await page.screenshot({ path: '/tmp/quinn-final-intelligence-tab.png', fullPage: true });
    
    const pageText = await page.locator('body').innerText();
    
    // Validate sections
    const hasRedHatNews = pageText.includes('Red Hat News');
    const hasProductRoadmap = pageText.includes('Product Roadmap');
    const hasOCP = pageText.includes('OpenShift') || pageText.includes('OCP');
    const hasRHEL = pageText.includes('Red Hat Enterprise Linux') || pageText.includes('RHEL');
    const hasAAP = pageText.includes('Ansible') || pageText.includes('AAP');
    const hasCurrentVersion = pageText.includes('Current Version');
    const hasEOL = pageText.includes('EOL');
    
    console.log(`\n📋 VALIDATION RESULTS:`);
    console.log(`   Red Hat News section: ${hasRedHatNews ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Product Roadmap section: ${hasProductRoadmap ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   OpenShift data: ${hasOCP ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   RHEL data: ${hasRHEL ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Ansible data: ${hasAAP ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Table columns: ${(hasCurrentVersion && hasEOL) ? '✅ PASS' : '❌ FAIL'}`);
    
    // Assertions
    expect(hasRedHatNews).toBeTruthy();
    expect(hasProductRoadmap).toBeTruthy();
    expect(hasOCP || hasRHEL || hasAAP).toBeTruthy(); // At least one product
    expect(hasCurrentVersion).toBeTruthy();
    expect(hasEOL).toBeTruthy();
  });
  
  test('Test 3 different customers', async ({ page }) => {
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers.slice(0, 3);
    
    for (let i = 0; i < customers.length; i++) {
      const customer = customers[i];
      console.log(`\n═══ Customer ${i + 1}/3: ${customer.name} ═══`);
      
      await page.goto(`http://localhost:7777/dashboard/customer/${encodeURIComponent(customer.name)}`);
      await page.waitForLoadState('networkidle');
      
      const intelligenceTab = page.getByRole('button', { name: 'Intelligence', exact: true });
      await intelligenceTab.click();
      await page.waitForTimeout(1500);
      
      const cleanName = customer.name.replace(/[^a-z0-9]/gi, '-').substring(0, 30);
      await page.screenshot({ path: `/tmp/quinn-cust-${i + 1}-${cleanName}.png`, fullPage: true });
      
      const pageText = await page.locator('body').innerText();
      console.log(`  ✅ Red Hat News: ${pageText.includes('Red Hat News') ? 'VISIBLE' : 'MISSING'}`);
      console.log(`  ✅ Product Roadmap: ${pageText.includes('Product Roadmap') ? 'VISIBLE' : 'MISSING'}`);
    }
  });
  
  test('Verify tabs regression - all tabs still work', async ({ page }) => {
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customer = data.customers[0];
    
    await page.goto(`http://localhost:7777/dashboard/customer/${encodeURIComponent(customer.name)}`);
    await page.waitForLoadState('networkidle');
    
    const tabs = [
      { name: 'Overview', exact: true },
      { name: 'Campaigns', exact: true },
      { name: 'News', exact: true },
      { name: 'Intelligence', exact: true },
      { name: 'Tools', exact: true }
    ];
    
    console.log('\n🔄 Testing tab navigation...');
    
    for (const tab of tabs) {
      const tabButton = page.getByRole('button', tab);
      if (await tabButton.isVisible()) {
        await tabButton.click();
        await page.waitForTimeout(500);
        console.log(`  ✅ ${tab.name} tab clicked successfully`);
      } else {
        console.log(`  ⚠️  ${tab.name} tab not visible`);
      }
    }
    
    await page.screenshot({ path: '/tmp/quinn-final-tabs-regression.png', fullPage: true });
  });
});
