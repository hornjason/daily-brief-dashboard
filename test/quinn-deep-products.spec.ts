import { test } from '@playwright/test';

test('deep inspection of products hub', async ({ page }) => {
  page.on('console', msg => { if (msg.type()==='error') console.log('CONSOLE_ERROR', msg.text()); });
  await page.goto('http://localhost:7777/dashboard/products', { waitUntil:'networkidle', timeout:60000 });
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 1600, height: 1100 });

  // Capture each territory card section by text
  const text = await page.locator('body').innerText();

  // Find slide corpus values per product
  const productSections = ['Red Hat Enterprise Linux','Red Hat OpenShift Container Platform','OpenShift Virtualization','Red Hat Ansible Automation Platform','Red Hat Enterprise Linux AI','Red Hat AI Inference Server','Red Hat OpenShift AI'];
  for (const p of productSections) {
    const idx = text.indexOf(p);
    if (idx === -1) { console.log('MISSING_PRODUCT', p); continue; }
    const slice = text.slice(idx, idx + 600).replace(/\n+/g,' | ');
    console.log('SECTION', p, '=>', slice);
  }

  // Scroll to mid and screenshot
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/quinn-products-mid.png', fullPage: false });

  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/quinn-products-mid2.png', fullPage: false });
});
