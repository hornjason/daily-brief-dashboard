import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:7777';

test.describe('BKL-ARCH-SCRAPER-09: Supportable removal QA', () => {
  test('main dashboard loads with no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
    const resp = await page.goto(BASE, { waitUntil: 'networkidle' });
    expect(resp?.ok() || resp?.status() === 304).toBeTruthy();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    const html = (await page.content()).toLowerCase();
    expect(html).not.toContain('supportable');
    await page.screenshot({ path: 'test-results/quinn-bkl09-main.png', fullPage: false });
    console.log('MAIN_ERRORS=', JSON.stringify(errors));
    console.log('MAIN_TITLE=', await page.title());
    expect(errors.filter(e => !/favicon|404/i.test(e))).toEqual([]);
  });

  test('SetupPage hydrates with no Supportable UI; expected connection cards present', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
    await page.goto(`${BASE}/dashboard/setup`, { waitUntil: 'networkidle' });
    await page.waitForLoadState('domcontentloaded');
    // Wait for SPA hydration
    await page.waitForFunction(() => {
      const root = document.getElementById('root') || document.querySelector('main') || document.body;
      return !!(root && (root.textContent || '').trim().length > 50);
    }, { timeout: 15000 });
    await page.waitForTimeout(2000);
    const text = ((await page.textContent('body')) || '').toLowerCase();
    const html = (await page.content()).toLowerCase();
    await page.screenshot({ path: 'test-results/quinn-bkl09-setup.png', fullPage: true });

    expect(text).not.toContain('supportable');
    expect(html).not.toContain('supportable');

    // SetupPage is a wizard with 5 steps (OAuth, Google Auth, RH Token, AEs, AI Settings).
    // Verify wizard structure, not legacy connection-card labels.
    const hasWizardSteps = /step \d of \d/.test(text);
    const hasOAuth = /oauth/.test(text);
    const hasRH = /red hat|rh token/.test(text);
    console.log('SETUP_TEXT_LEN=', text.length);
    console.log('SETUP_STRUCTURE wizard=', hasWizardSteps, 'oauth=', hasOAuth, 'rh=', hasRH);
    console.log('SETUP_ERRORS=', JSON.stringify(errors));
    expect(hasWizardSteps).toBeTruthy();
    expect(hasOAuth).toBeTruthy();
    expect(hasRH).toBeTruthy();
    expect(errors.filter(e => !/favicon|404/i.test(e))).toEqual([]);
  });

  test('AdminPage loads without errors and no Supportable UI', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
    const resp = await page.goto(`${BASE}/dashboard/admin`, { waitUntil: 'networkidle' });
    expect(resp?.ok() || resp?.status() === 304).toBeTruthy();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    const html = (await page.content()).toLowerCase();
    expect(html).not.toContain('supportable');
    await page.screenshot({ path: 'test-results/quinn-bkl09-admin.png', fullPage: false });
    console.log('ADMIN_ERRORS=', JSON.stringify(errors));
    expect(errors.filter(e => !/favicon|404/i.test(e))).toEqual([]);
  });

  test('API /api/status/scrapes shape: 3 active circuit breakers; supportable inert', async ({ request }) => {
    const r = await request.get(`${BASE}/api/status/scrapes`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    console.log('SCRAPE_STATUS=', JSON.stringify(j, null, 2));

    const breakers = Object.keys(j.circuitBreakers || {}).sort();
    expect(breakers).toEqual(['ccsp', 'rh-cases', 'sf-pipeline']);

    if (j.supportable) {
      expect(j.supportable.isRunning).toBe(false);
      expect(j.supportable.lastError).toBeNull();
    }
  });
});
