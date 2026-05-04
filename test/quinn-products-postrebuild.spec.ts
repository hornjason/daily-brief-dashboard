import { test, expect } from '@playwright/test';

test.describe('Quinn — Products Hub + Setup verification (post-rebuild)', () => {
  const consoleErrors: { url: string; messages: string[] }[] = [];

  test('Products Hub: features radar populated, territory cards, slide corpus', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', e => errors.push(`PAGEERROR: ${e.message}`));

    await page.goto('http://localhost:7777/dashboard/products', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: '/tmp/quinn-products-top.png', fullPage: false });
    await page.screenshot({ path: '/tmp/quinn-products-full.png', fullPage: true });

    const bodyText = await page.locator('body').innerText();

    // Territory radar cards
    const cards = ['AAP', 'RHEL AI', 'RH AI Inference', 'RHOAI'];
    const cardPresence: Record<string,boolean> = {};
    for (const name of cards) cardPresence[name] = bodyText.includes(name);
    console.log('CARD_PRESENCE', JSON.stringify(cardPresence));

    // Feature radar — check for "No features extracted yet" frequency
    const noFeaturesCount = (bodyText.match(/No features extracted yet/g) || []).length;
    console.log('NO_FEATURES_COUNT', noFeaturesCount);

    // Slide Corpus AAP
    const slideMatch = bodyText.match(/AAP[\s\S]{0,300}?(\d+)\s*files?\s*ingested/i);
    console.log('AAP_SLIDE_MATCH', slideMatch ? slideMatch[0].slice(0,200) : 'NOT FOUND');

    // Try to find feature accordion items
    const accordions = await page.locator('[role="button"], button, summary').allInnerTexts();
    const accordionMatches = accordions.filter(t => /feature|radar|extracted/i.test(t)).slice(0,10);
    console.log('ACCORDION_HINTS', JSON.stringify(accordionMatches));

    consoleErrors.push({ url: 'products', messages: errors });
    console.log('PRODUCTS_CONSOLE_ERRORS', JSON.stringify(errors));
  });

  test('Setup page: no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', e => errors.push(`PAGEERROR: ${e.message}`));

    await page.goto('http://localhost:7777/dashboard/setup', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: '/tmp/quinn-setup.png', fullPage: true });

    console.log('SETUP_CONSOLE_ERRORS', JSON.stringify(errors));
  });
});
