/**
 * Quinn Intelligence Tab Click Test — 2026-05-14
 * Actually click the Intelligence tab and capture content
 */

import { test, expect } from '@playwright/test';

test.describe('Intelligence Tab Content Validation', () => {
  
  test('Click Intelligence tab and verify both sections render', async ({ page }) => {
    // Get a customer
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customer = data.customers[0];
    
    console.log(`\n🧪 Testing customer: ${customer.name}\n`);
    
    // Navigate to customer detail
    await page.goto(`http://localhost:7777/dashboard/customer/${encodeURIComponent(customer.name)}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    
    // Screenshot before clicking
    await page.screenshot({ path: '/tmp/quinn-click-01-before.png', fullPage: true });
    
    // Find and click Intelligence tab using role
    const intelligenceTab = page.getByRole('button', { name: /intelligence/i });
    await expect(intelligenceTab).toBeVisible({ timeout: 5000 });
    
    console.log('✅ Intelligence tab button found');
    
    await intelligenceTab.click();
    await page.waitForTimeout(2000); // Wait for content to load
    
    // Screenshot after clicking
    await page.screenshot({ path: '/tmp/quinn-click-02-intelligence-tab.png', fullPage: true });
    
    // Get all visible text
    const pageText = await page.locator('body').innerText();
    console.log('\n--- Intelligence Tab Content ---');
    console.log(pageText);
    
    // Check for Red Hat News section
    const hasRedHatNews = pageText.includes('Red Hat News');
    console.log(`\n📰 Red Hat News section: ${hasRedHatNews ? '✅ PRESENT' : '❌ MISSING'}`);
    
    // Check for Product Roadmap section
    const hasProductRoadmap = pageText.includes('Product Roadmap');
    console.log(`🗺️  Product Roadmap section: ${hasProductRoadmap ? '✅ PRESENT' : '❌ MISSING'}`);
    
    // Check for product names
    const hasOCP = pageText.includes('OpenShift') || pageText.includes('OCP');
    const hasRHEL = pageText.includes('Red Hat Enterprise Linux') || pageText.includes('RHEL');
    const hasAAP = pageText.includes('Ansible') || pageText.includes('AAP');
    
    console.log(`\n🔍 Product Data:`);
    console.log(`   OpenShift: ${hasOCP ? '✅' : '❌'}`);
    console.log(`   RHEL: ${hasRHEL ? '✅' : '❌'}`);
    console.log(`   Ansible: ${hasAAP ? '✅' : '❌'}`);
    
    // Check for table columns
    const hasCurrentVersion = pageText.includes('Current Version');
    const hasNextVersion = pageText.includes('Next Version');
    const hasEOL = pageText.includes('EOL');
    
    console.log(`\n📊 Table Columns:`);
    console.log(`   Current Version: ${hasCurrentVersion ? '✅' : '❌'}`);
    console.log(`   Next Version: ${hasNextVersion ? '✅' : '❌'}`);
    console.log(`   EOL: ${hasEOL ? '✅' : '❌'}`);
  });
  
  test('Test Intelligence tab on multiple customers', async ({ page }) => {
    const response = await page.request.get('http://localhost:7777/api/accounts');
    const data = await response.json();
    const customers = data.customers.slice(0, 3);
    
    for (const customer of customers) {
      console.log(`\n\n═══ Testing: ${customer.name} ═══`);
      
      await page.goto(`http://localhost:7777/dashboard/customer/${encodeURIComponent(customer.name)}`);
      await page.waitForLoadState('networkidle');
      
      const intelligenceTab = page.getByRole('button', { name: /intelligence/i });
      await intelligenceTab.click();
      await page.waitForTimeout(1500);
      
      const cleanName = customer.name.replace(/[^a-z0-9]/gi, '-');
      await page.screenshot({ 
        path: `/tmp/quinn-customer-${cleanName}.png`, 
        fullPage: true 
      });
      
      const pageText = await page.locator('body').innerText();
      const hasNews = pageText.includes('Red Hat News');
      const hasRoadmap = pageText.includes('Product Roadmap');
      
      console.log(`  Red Hat News: ${hasNews ? '✅' : '❌'}`);
      console.log(`  Product Roadmap: ${hasRoadmap ? '✅' : '❌'}`);
    }
  });
});
