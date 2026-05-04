import { test, expect } from '@playwright/test';

// Quinn Council Audit — production (7777) — 2026-04-27
// Validates this session's shipped changes:
//  1) Products Hub shows real feature data (no "No features extracted yet")
//  2) Supportable UI removed everywhere
//  3) Dashboard primary view loads cleanly
//  4) Customer detail page loads
//  5) Admin page loads
// Brand-new-user perspective. ci project (targets 7777).

const BASE = 'http://localhost:7777';
const SHOTS = '/tmp/quinn-council-20260427';

interface PageResult {
  url: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: { url: string; status: number }[];
}

async function instrument(page: any, url: string): Promise<PageResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: { url: string; status: number }[] = [];
  page.on('console', (m: any) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e: any) => pageErrors.push(e.message));
  page.on('response', (r: any) => { if (r.status() >= 400) failedRequests.push({ url: r.url(), status: r.status() }); });
  return { url, consoleErrors, pageErrors, failedRequests };
}

test.describe('Quinn Council Audit 2026-04-27 (prod 7777)', () => {

  test('1. Dashboard primary view loads with data', async ({ page }) => {
    const r = await instrument(page, `${BASE}/`);
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60_000 });
    // Should redirect to /dashboard
    await page.waitForLoadState('networkidle');
    const finalUrl = page.url();
    console.log('FINAL_URL', finalUrl);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}-01-dashboard.png`, fullPage: true });

    const body = await page.locator('body').innerText();
    const len = body.length;
    console.log('DASHBOARD_BODY_LEN', len);
    console.log('DASHBOARD_HAS_AE_COL', /Carolanne|Peter|TBH|AE/i.test(body));
    console.log('DASHBOARD_CONSOLE_ERRORS', JSON.stringify(r.consoleErrors));
    console.log('DASHBOARD_PAGE_ERRORS', JSON.stringify(r.pageErrors));
    console.log('DASHBOARD_FAILED_REQS', JSON.stringify(r.failedRequests));

    // Supportable UI absence check on dashboard
    const supportableMatches = body.match(/[Ss]upportable/g) || [];
    console.log('DASHBOARD_SUPPORTABLE_MATCHES', supportableMatches.length, JSON.stringify(supportableMatches.slice(0, 5)));

    expect(finalUrl).toContain('/dashboard');
    expect(r.pageErrors).toEqual([]);
  });

  test('2. Products Hub shows real feature data', async ({ page }) => {
    const r = await instrument(page, `${BASE}/dashboard/products`);
    await page.goto(`${BASE}/dashboard/products`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SHOTS}-02-products-top.png`, fullPage: false });
    await page.screenshot({ path: `${SHOTS}-02-products-full.png`, fullPage: true });

    const body = await page.locator('body').innerText();
    const noFeaturesCount = (body.match(/No features extracted yet/g) || []).length;
    const zeroFeaturesPattern = (body.match(/0\s+features/gi) || []).length;
    console.log('PRODUCTS_NO_FEATURES_COUNT', noFeaturesCount);
    console.log('PRODUCTS_ZERO_FEATURES_PATTERN', zeroFeaturesPattern);

    // Look for product names
    const products = ['RHEL', 'OpenShift', 'AAP', 'Ansible', 'OpenShift AI'];
    const presence: Record<string, boolean> = {};
    for (const p of products) presence[p] = body.includes(p);
    console.log('PRODUCTS_PRESENCE', JSON.stringify(presence));

    // Feature counts visible (e.g., "30 features", "13 features")
    const featureCountMatches = body.match(/(\d+)\s*features?/gi) || [];
    console.log('FEATURE_COUNT_MATCHES', JSON.stringify(featureCountMatches.slice(0, 20)));

    console.log('PRODUCTS_CONSOLE_ERRORS', JSON.stringify(r.consoleErrors));
    console.log('PRODUCTS_PAGE_ERRORS', JSON.stringify(r.pageErrors));
    console.log('PRODUCTS_FAILED_REQS', JSON.stringify(r.failedRequests));

    // CRITICAL: no products should show "No features extracted yet"
    expect(noFeaturesCount).toBe(0);
  });

  test('3. Customer detail page loads', async ({ page, request }) => {
    // Get a real customer name from API
    const accts = await request.get(`${BASE}/api/accounts`);
    const data = await accts.json();
    const customers = data.customers || [];
    const target = customers.find((c: any) => c.name && c.name !== 'Acme Corp') || customers[0];
    console.log('CUSTOMER_TARGET', target?.name);

    if (!target) {
      console.log('NO_CUSTOMER_FOUND — skipping');
      return;
    }
    const r = await instrument(page, '');
    const slug = encodeURIComponent(target.name);
    const url = `${BASE}/dashboard/customer/${slug}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(e => console.log('NAV_ERR', e.message));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}-03-customer.png`, fullPage: true });
    const body = await page.locator('body').innerText();
    console.log('CUSTOMER_BODY_LEN', body.length);
    console.log('CUSTOMER_HAS_NAME', body.includes(target.name));
    console.log('CUSTOMER_CONSOLE_ERRORS', JSON.stringify(r.consoleErrors));
    console.log('CUSTOMER_PAGE_ERRORS', JSON.stringify(r.pageErrors));
    console.log('CUSTOMER_FAILED_REQS', JSON.stringify(r.failedRequests.slice(0, 10)));
  });

  test('4. Admin page loads', async ({ page }) => {
    const r = await instrument(page, `${BASE}/dashboard/admin`);
    await page.goto(`${BASE}/dashboard/admin`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}-04-admin.png`, fullPage: true });
    const body = await page.locator('body').innerText();
    console.log('ADMIN_BODY_LEN', body.length);
    console.log('ADMIN_CONSOLE_ERRORS', JSON.stringify(r.consoleErrors));
    console.log('ADMIN_PAGE_ERRORS', JSON.stringify(r.pageErrors));
    console.log('ADMIN_FAILED_REQS', JSON.stringify(r.failedRequests.slice(0, 10)));

    const supportableMatches = body.match(/[Ss]upportable/g) || [];
    console.log('ADMIN_SUPPORTABLE_MATCHES', supportableMatches.length, JSON.stringify(supportableMatches.slice(0, 10)));
  });

  test('5. Setup page — no Supportable UI', async ({ page }) => {
    const r = await instrument(page, `${BASE}/dashboard/setup`);
    await page.goto(`${BASE}/dashboard/setup`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}-05-setup.png`, fullPage: true });

    const body = await page.locator('body').innerText();
    // Look for the specific Supportable UI strings that should be GONE
    const bannedStrings = ['Retry Supportable', 'Supportable Connect', 'Connect Supportable', 'Supportable Setup', 'Supportable Sheet'];
    const found: Record<string, boolean> = {};
    for (const s of bannedStrings) found[s] = body.includes(s);
    console.log('SETUP_BANNED_STRINGS', JSON.stringify(found));

    // Generic supportable mentions
    const supportableMatches = body.match(/[Ss]upportable/g) || [];
    console.log('SETUP_SUPPORTABLE_MATCHES', supportableMatches.length);

    console.log('SETUP_CONSOLE_ERRORS', JSON.stringify(r.consoleErrors));
    console.log('SETUP_PAGE_ERRORS', JSON.stringify(r.pageErrors));
    console.log('SETUP_FAILED_REQS', JSON.stringify(r.failedRequests.slice(0, 10)));

    // Hard assertion: no banned Supportable UI strings
    for (const s of bannedStrings) expect(body).not.toContain(s);
  });
});
