# E2E Testing Patterns for Data-Heavy Single-User Dashboards

**Research Date:** 2026-03-30
**Researcher:** Ava Sterling (ClaudeResearcher)
**Scope:** World-class testing patterns for DailyBriefDashboard architecture

---

## Table of Contents

1. [Testing Dashboards with External Data Sources](#1-testing-dashboards-with-external-data-sources)
2. [Scraper/Data Pipeline Testing Patterns](#2-scraperdata-pipeline-testing-patterns)
3. [Testing Data Freshness/Staleness](#3-testing-data-freshnessstaleness)
4. [Testing Multi-Step Setup Wizards](#4-testing-multi-step-setup-wizards)
5. [Testing OAuth Flows and Session Management](#5-testing-oauth-flows-and-session-management)
6. [Testing Browser Automation Within Tests](#6-testing-browser-automation-within-tests)
7. [Testing Data Export/Import](#7-testing-data-exportimport)
8. [Test Data Factories and Fixtures](#8-test-data-factories-and-fixtures)
9. [Testing Real-Time Features (SSE)](#9-testing-real-time-features-sse)
10. [Snapshot Testing for API Contracts](#10-snapshot-testing-for-api-contracts)
11. [Strategic Recommendations for DailyBriefDashboard](#11-strategic-recommendations-for-dailybriefdashboard)

---

## 1. Testing Dashboards with External Data Sources

### The Core Problem

Dashboards pulling from Salesforce, Google Sheets, and scraper-backed APIs face a fundamental tension: real external calls are slow, rate-limited, flaky, and non-deterministic. But mocking everything risks testing fiction instead of reality.

### The Three-Layer Strategy

The industry consensus converges on a **three-layer approach**:

#### Layer 1: Contract Tests (API Shape Validation)
Verify that the shape of data coming from external sources matches what your dashboard expects. This catches breaking changes in upstream APIs without hitting them every test run.

```typescript
// contracts/salesforce-opportunity.contract.ts
import { z } from 'zod';

export const SalesforceOpportunitySchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Amount: z.number().nullable(),
  StageName: z.string(),
  CloseDate: z.string(),
  Account: z.object({
    Name: z.string(),
    Id: z.string(),
  }),
});

// Run periodically against real Salesforce sandbox
test('salesforce opportunity schema has not drifted', async () => {
  const realResponse = await sfClient.query('SELECT Id, Name, Amount... FROM Opportunity LIMIT 1');
  expect(() => SalesforceOpportunitySchema.parse(realResponse.records[0])).not.toThrow();
});
```

#### Layer 2: Integration Tests with Recorded Fixtures
Record real API responses once, replay them in tests. Update fixtures on a schedule (weekly) or when contract tests detect drift.

```typescript
// fixtures/salesforce-opportunities.json - recorded from real API
// tests/dashboard-rendering.spec.ts
test('dashboard renders opportunity pipeline correctly', async ({ page }) => {
  // Mock the API layer, not Salesforce directly
  await page.route('**/api/pipeline', route =>
    route.fulfill({
      status: 200,
      body: JSON.stringify(require('../fixtures/salesforce-opportunities.json')),
    })
  );

  await page.goto('/dashboard');
  await expect(page.getByTestId('pipeline-table')).toBeVisible();
  await expect(page.getByText('$1,250,000')).toBeVisible();
});
```

#### Layer 3: Smoke Tests Against Real Sources
A small suite (2-5 tests) that hits real Salesforce/Sheets on a schedule (nightly, not per-commit). These validate that credentials work, schemas haven't changed, and end-to-end data flow is intact.

### How Retool, Metabase, and Grafana Approach This

- **Metabase** (open-source BI tool) uses a test driver system where each database type has a conformance test suite. They mock at the driver level, not at HTTP. Their test fixtures represent canonical query results that every driver must produce.
- **Grafana** tests dashboard rendering by mocking the datasource plugin interface. Each datasource plugin has unit tests for query building and response transformation, while E2E tests use mocked datasource responses to validate panel rendering.
- **Retool** (per engineering blog posts) uses a combination of API mocking for their connector layer and visual regression testing for dashboard rendering.

### Pattern: The Mock Boundary

The critical decision is **where to draw the mock boundary**:

```
[Real Salesforce] --> [Your API adapter] --> [Your API endpoint] --> [React Dashboard]
                           ^                        ^                      ^
                     Contract tests            Integration tests       E2E tests
                     (weekly, real)          (per-commit, mocked)   (per-commit, mocked)
```

Mock at **your API layer**, not at the external service SDK level. This means your adapter code (the part that translates Salesforce responses into your internal format) gets tested with contract tests against real data, while everything downstream works with your normalized data format.

---

## 2. Scraper/Data Pipeline Testing Patterns

### The Full Pipeline

```
Playwright scraper --> Google Sheets --> API reads Sheets --> React renders
```

Each junction is a potential failure point. The testing strategy maps to each junction.

### Layer 1: Scraper Output Contract Tests

Test that your scraper produces data in the expected shape, using recorded HTML snapshots of the target pages:

```typescript
// tests/scrapers/supportable-scraper.spec.ts
import { test, expect } from '@playwright/test';
import { SupportableOutputSchema } from '../contracts/supportable';

test.describe('Supportable scraper output contract', () => {
  test('produces valid output from recorded page', async ({ page }) => {
    // Serve a recorded HTML snapshot of the target page
    await page.route('https://access.redhat.com/**', route =>
      route.fulfill({
        path: './fixtures/recorded-pages/supportable-subscriptions.html',
      })
    );

    const result = await runScraper(page, 'account-123');
    expect(() => SupportableOutputSchema.parse(result)).not.toThrow();
    expect(result.subscriptions.length).toBeGreaterThan(0);
  });
});
```

### Layer 2: Pipeline Junction Tests

Test each handoff point independently:

```typescript
// tests/pipeline/sheets-write-read.spec.ts
test('data survives Sheets round-trip without corruption', async () => {
  const testData = CustomerFactory.buildList(5);

  // Write to a test sheet
  await sheetsClient.write('TestSheet!A1', formatForSheets(testData));

  // Read back
  const readBack = await sheetsClient.read('TestSheet!A1:Z100');
  const parsed = parseFromSheets(readBack);

  // Verify round-trip fidelity
  expect(parsed).toEqual(testData.map(d => ({
    ...d,
    // Known transformations (dates become strings, etc.)
    closeDate: d.closeDate.toISOString().split('T')[0],
  })));
});
```

### Layer 3: Contract Testing for the Pipeline

Define contracts at each boundary:

```typescript
// contracts/pipeline-contracts.ts
export const ScraperOutputContract = z.object({
  accountId: z.string(),
  subscriptions: z.array(z.object({
    name: z.string(),
    status: z.enum(['Active', 'Expired', 'Future']),
    startDate: z.string(),
    endDate: z.string(),
  })),
  scrapedAt: z.string().datetime(),
});

export const SheetsRowContract = z.tuple([
  z.string(), // Account ID
  z.string(), // Subscription Name
  z.string(), // Status
  z.string(), // Start Date
  z.string(), // End Date
]);

export const ApiResponseContract = z.object({
  customers: z.array(z.object({
    accountId: z.string(),
    subscriptions: z.array(z.object({
      name: z.string(),
      status: z.string(),
      startDate: z.string(),
      endDate: z.string(),
    })),
  })),
  lastUpdated: z.string().datetime(),
});
```

### Layer 4: Full Pipeline Smoke Test

Run the complete pipeline against test data on a schedule:

```typescript
// tests/pipeline/full-pipeline.smoke.ts
test('full pipeline: scrape -> sheets -> api -> render', async ({ page }) => {
  // 1. Run scraper against recorded page
  const scraperOutput = await runScraperWithFixture(page);

  // 2. Write to test sheet
  await writeToTestSheet(scraperOutput);

  // 3. Hit API that reads from sheet
  const apiResponse = await fetch('/api/customers?source=test-sheet');
  const data = await apiResponse.json();

  // 4. Render and verify
  await page.goto('/dashboard?source=test');
  await expect(page.getByTestId('customer-table')).toContainText(scraperOutput.subscriptions[0].name);
});
```

### Key Insight: Record-and-Replay for Scrapers

The most robust pattern for scraper testing is **HTML snapshot recording**:

1. Periodically capture real HTML from the target site
2. Serve these snapshots in tests via `page.route()`
3. When scraper tests fail after updating snapshots, it means the site changed
4. This separates "is the site different?" from "is the scraper broken?"

---

## 3. Testing Data Freshness/Staleness

### The Problem

Stale data is insidious because it looks correct. A dashboard showing last week's opportunity amounts without any visual indication is worse than a broken dashboard, because users make decisions on outdated information without knowing it.

### Pattern 1: Freshness Metadata in Every Response

```typescript
// Every API response includes freshness metadata
interface ApiResponse<T> {
  data: T;
  meta: {
    dataAsOf: string;        // When the data was actually current
    fetchedAt: string;        // When we last pulled it
    source: string;           // Where it came from
    freshnessStatus: 'fresh' | 'stale' | 'expired';
  };
}

// Freshness thresholds per data type
const FRESHNESS_THRESHOLDS = {
  salesforce: { stale: 4 * 60 * 60 * 1000, expired: 24 * 60 * 60 * 1000 },
  googleSheets: { stale: 1 * 60 * 60 * 1000, expired: 8 * 60 * 60 * 1000 },
  scraper: { stale: 24 * 60 * 60 * 1000, expired: 72 * 60 * 60 * 1000 },
};
```

### Pattern 2: Testing Freshness Indicators

```typescript
// tests/freshness/stale-data-indicators.spec.ts
test.describe('data freshness indicators', () => {
  test('shows fresh indicator when data is recent', async ({ page }) => {
    await page.route('**/api/pipeline', route =>
      route.fulfill({
        body: JSON.stringify({
          data: mockPipelineData,
          meta: { dataAsOf: new Date().toISOString(), freshnessStatus: 'fresh' },
        }),
      })
    );

    await page.goto('/dashboard');
    await expect(page.getByTestId('freshness-badge')).toHaveText(/Updated .* ago/);
    await expect(page.getByTestId('freshness-badge')).toHaveCSS('color', 'rgb(34, 197, 94)'); // green
  });

  test('shows stale warning when data is old', async ({ page }) => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await page.route('**/api/pipeline', route =>
      route.fulfill({
        body: JSON.stringify({
          data: mockPipelineData,
          meta: { dataAsOf: fiveHoursAgo, freshnessStatus: 'stale' },
        }),
      })
    );

    await page.goto('/dashboard');
    await expect(page.getByTestId('freshness-badge')).toContainText('5 hours ago');
    await expect(page.getByTestId('freshness-badge')).toHaveCSS('color', 'rgb(234, 179, 8)'); // yellow
  });

  test('shows expired error when data is very old', async ({ page }) => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await page.route('**/api/pipeline', route =>
      route.fulfill({
        body: JSON.stringify({
          data: mockPipelineData,
          meta: { dataAsOf: twoDaysAgo, freshnessStatus: 'expired' },
        }),
      })
    );

    await page.goto('/dashboard');
    await expect(page.getByTestId('freshness-banner')).toBeVisible();
    await expect(page.getByTestId('freshness-banner')).toContainText('Data may be outdated');
  });
});
```

### Pattern 3: Freshness Anomaly Detection

From the data observability world (Monte Carlo, Elementary, DQOps), the pattern is:

```typescript
// tests/freshness/anomaly-detection.spec.ts
test('detects freshness anomaly when update pattern breaks', async () => {
  // Normally updated every hour. Test that alert fires when 4+ hours pass.
  const monitor = new FreshnessMonitor({
    source: 'salesforce-pipeline',
    expectedInterval: 60 * 60 * 1000, // 1 hour
    alertThreshold: 4, // Alert after 4x expected interval
  });

  // Simulate time passing without update
  vi.setSystemTime(new Date('2026-03-30T16:00:00Z'));
  monitor.lastUpdate = new Date('2026-03-30T10:00:00Z'); // 6 hours ago

  expect(monitor.check()).toEqual({
    status: 'anomaly',
    hoursSinceUpdate: 6,
    expectedMaxHours: 4,
    message: 'salesforce-pipeline has not been updated in 6 hours (expected every 1 hour)',
  });
});
```

### Key Metrics to Test

1. **Data age** - time since data was last current at source
2. **Fetch lag** - time since we last pulled from source
3. **Processing lag** - time from fetch to availability in dashboard
4. **Update frequency** - whether refresh cadence matches expectations

---

## 4. Testing Multi-Step Setup Wizards

### Industry Patterns from Shopify, Stripe, and SaaS Onboarding

The consensus pattern for wizard testing is the **State Machine Model**: treat each wizard step as a state, and test both the transitions and the state persistence.

### Pattern 1: Page Object per Wizard Step

```typescript
// pages/wizard/territory-step.ts
export class TerritoryStep {
  constructor(private page: Page) {}

  async selectPOD(pod: string) {
    await this.page.getByLabel('POD').selectOption(pod);
  }

  async selectTerritory(territory: string) {
    await this.page.getByLabel('Territory').selectOption(territory);
  }

  async getSelectedPOD() {
    return this.page.getByLabel('POD').inputValue();
  }

  async clickNext() {
    await this.page.getByRole('button', { name: 'Next' }).click();
  }

  async isVisible() {
    return this.page.getByTestId('wizard-step-territory').isVisible();
  }
}

// pages/wizard/customers-step.ts
export class CustomersStep {
  constructor(private page: Page) {}

  async getCustomerList() {
    return this.page.getByTestId('customer-row').allTextContents();
  }

  async toggleCustomer(name: string) {
    await this.page.getByRole('checkbox', { name }).click();
  }

  async clickNext() {
    await this.page.getByRole('button', { name: 'Next' }).click();
  }

  async clickBack() {
    await this.page.getByRole('button', { name: 'Back' }).click();
  }
}
```

### Pattern 2: Forward/Backward Navigation with State Persistence

```typescript
// tests/wizard/navigation.spec.ts
test('wizard preserves selections when navigating back and forward', async ({ page }) => {
  const territory = new TerritoryStep(page);
  const customers = new CustomersStep(page);

  await page.goto('/setup');

  // Step 1: Select territory
  await territory.selectPOD('West');
  await territory.selectTerritory('Enterprise West A');
  await territory.clickNext();

  // Step 2: Select customers
  await customers.toggleCustomer('Acme Corp');
  await customers.toggleCustomer('Globex Industries');

  // Navigate back
  await customers.clickBack();

  // Verify step 1 state is preserved
  expect(await territory.getSelectedPOD()).toBe('West');

  // Navigate forward again
  await territory.clickNext();

  // Verify step 2 state is preserved
  const checkedCustomers = await page.getByRole('checkbox', { checked: true }).allTextContents();
  expect(checkedCustomers).toContain('Acme Corp');
  expect(checkedCustomers).toContain('Globex Industries');
});
```

### Pattern 3: Step Validation and Error Recovery

```typescript
// tests/wizard/validation.spec.ts
test('wizard prevents advancing without required fields', async ({ page }) => {
  await page.goto('/setup');

  // Try to advance without selecting anything
  await page.getByRole('button', { name: 'Next' }).click();

  // Should show validation error, not advance
  await expect(page.getByText('Please select a POD')).toBeVisible();
  await expect(page.getByTestId('wizard-step-territory')).toBeVisible(); // Still on step 1
});

test('wizard recovers from mid-step API failure', async ({ page }) => {
  await page.goto('/setup');

  // Fill in step 1
  await page.getByLabel('POD').selectOption('West');
  await page.getByLabel('Territory').selectOption('Enterprise West A');

  // Mock API failure on next
  await page.route('**/api/territory/customers', route =>
    route.fulfill({ status: 500, body: 'Internal Server Error' })
  );

  await page.getByRole('button', { name: 'Next' }).click();

  // Should show error but preserve state
  await expect(page.getByText(/failed to load customers/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

  // Fix the API
  await page.unroute('**/api/territory/customers');
  await page.route('**/api/territory/customers', route =>
    route.fulfill({ body: JSON.stringify({ customers: mockCustomers }) })
  );

  // Retry should work
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('wizard-step-customers')).toBeVisible();
});
```

### Pattern 4: Wizard Resume After Browser Refresh

```typescript
test('wizard resumes from last completed step after refresh', async ({ page }) => {
  await page.goto('/setup');

  // Complete steps 1 and 2
  await completeStep1(page);
  await completeStep2(page);

  // Refresh the page
  await page.reload();

  // Should resume at step 3, not start over
  await expect(page.getByTestId('wizard-step-3')).toBeVisible();

  // Previous selections should be intact
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  expect(await page.getByLabel('POD').inputValue()).toBe('West');
});
```

### Pattern 5: Fresh Container Testing

Given the feedback about testing in fresh containers, always include a "clean slate" test:

```typescript
test('wizard works from completely fresh state', async ({ browser }) => {
  // New context = no cookies, no localStorage, no session
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/setup');

  // Should start at step 1 with no pre-filled data
  await expect(page.getByTestId('wizard-step-territory')).toBeVisible();
  expect(await page.getByLabel('POD').inputValue()).toBe('');

  await context.close();
});
```

---

## 5. Testing OAuth Flows and Session Management

### What's Testable in Playwright vs What Needs Mocking

| Aspect | Playwright (Real) | Mock/Stub |
|--------|-------------------|-----------|
| Login form interaction | Yes | - |
| OAuth redirect to provider | Possible but fragile | Recommended |
| Token storage in cookies/localStorage | Yes | - |
| Session expiry detection UI | Yes | - |
| Token refresh logic | - | Yes (mock token endpoint) |
| OAuth callback handling | Yes | - |
| MFA/2FA flows | Fragile | Recommended |

### Pattern 1: Saved Authentication State

Playwright's recommended approach is to authenticate once and reuse the state:

```typescript
// auth.setup.ts - runs once before all tests
import { test as setup } from '@playwright/test';

setup('authenticate', async ({ page }) => {
  // If using Google OAuth, either:
  // Option A: Hit your app's test login endpoint
  await page.goto('/auth/test-login?user=test-ae');

  // Option B: Set cookies/localStorage directly
  await page.context().addCookies([{
    name: 'session',
    value: 'test-session-token',
    domain: 'localhost',
    path: '/',
  }]);

  // Save state for reuse
  await page.context().storageState({ path: '.auth/user.json' });
});

// playwright.config.ts
export default defineConfig({
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'tests',
      dependencies: ['setup'],
      use: { storageState: '.auth/user.json' },
    },
  ],
});
```

### Pattern 2: Session Expiry Detection

```typescript
test('shows session expired overlay when token expires', async ({ page }) => {
  await page.goto('/dashboard');

  // Simulate token expiry by mocking the refresh endpoint to fail
  await page.route('**/api/auth/refresh', route =>
    route.fulfill({ status: 401, body: JSON.stringify({ error: 'token_expired' }) })
  );

  // Trigger an API call that will try to refresh
  await page.getByRole('button', { name: 'Refresh Data' }).click();

  // Should show session expired UI
  await expect(page.getByText('Session expired')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
});
```

### Pattern 3: OAuth Redirect Flow Testing

```typescript
test('OAuth callback correctly stores tokens and redirects', async ({ page }) => {
  // Mock the OAuth callback
  await page.route('**/api/auth/callback**', route =>
    route.fulfill({
      status: 302,
      headers: {
        'Location': '/dashboard',
        'Set-Cookie': 'session=mock-session-token; Path=/; HttpOnly',
      },
    })
  );

  // Simulate returning from OAuth provider
  await page.goto('/api/auth/callback?code=mock-auth-code&state=mock-state');

  // Should land on dashboard
  await expect(page).toHaveURL('/dashboard');

  // Session should be active
  const cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'session')).toBeDefined();
});
```

### Strategic Insight

For DailyBriefDashboard where auth is not a priority: create a **test login bypass endpoint** (e.g., `/auth/test-login`) that's only available in development/test modes. This completely sidesteps OAuth complexity in E2E tests while still allowing you to test the session management UI behaviors.

---

## 6. Testing Browser Automation Within Tests

### The Meta-Testing Challenge

The app uses Playwright to scrape; tests also use Playwright to test the app. This creates a "Playwright-testing-Playwright" situation.

### Pattern 1: Separate Scraper and Test Browser Instances

```typescript
// The key insight: your scraper's Playwright and your test's Playwright
// should NEVER share browser instances

// tests/scraper-integration.spec.ts
test.describe('scraper produces correct output', () => {
  let scraperBrowser: Browser;

  test.beforeAll(async () => {
    // Scraper gets its own browser
    scraperBrowser = await chromium.launch();
  });

  test.afterAll(async () => {
    await scraperBrowser.close();
  });

  test('supportable scraper extracts subscriptions', async () => {
    const context = await scraperBrowser.newContext();
    const page = await context.newPage();

    // Serve recorded HTML to the scraper
    await page.route('https://access.redhat.com/**', route =>
      route.fulfill({ path: './fixtures/supportable-page.html' })
    );

    const result = await scrapeSubscriptions(page, 'test-account');
    expect(result.subscriptions).toHaveLength(3);
    expect(result.subscriptions[0]).toMatchObject({
      name: expect.any(String),
      status: expect.stringMatching(/Active|Expired|Future/),
    });

    await context.close();
  });
});
```

### Pattern 2: Scraper as a Tested Module (Unit-Level)

Extract scraper logic into pure functions that can be tested without a browser:

```typescript
// scrapers/supportable/parser.ts
export function parseSubscriptionTable(html: string): Subscription[] {
  // Parse logic that works on HTML string, no browser needed
}

// scrapers/supportable/navigator.ts
export async function navigateToSubscriptions(page: Page, accountId: string): Promise<void> {
  // Navigation logic only
}

// tests/scrapers/parser.unit.ts - No browser needed!
test('parseSubscriptionTable extracts correct data', () => {
  const html = readFileSync('./fixtures/subscription-table.html', 'utf-8');
  const result = parseSubscriptionTable(html);
  expect(result).toEqual([
    { name: 'RHEL Server', status: 'Active', startDate: '2025-01-01', endDate: '2026-12-31' },
  ]);
});
```

### Pattern 3: Test the App's Scraper Trigger, Not the Scraper Itself

In E2E tests, mock the scraper's output at the API level:

```typescript
// tests/e2e/bootstrap-flow.spec.ts
test('bootstrap triggers scraper and shows results', async ({ page }) => {
  // Mock the server endpoint that the UI calls to trigger scraping
  await page.route('**/api/scrape/supportable', route =>
    route.fulfill({
      body: JSON.stringify({
        status: 'complete',
        subscriptions: mockSubscriptions,
        scrapedAt: new Date().toISOString(),
      }),
    })
  );

  await page.goto('/setup/bootstrap');
  await page.getByRole('button', { name: 'Run Supportable Check' }).click();

  // Verify the UI handles the response correctly
  await expect(page.getByTestId('subscription-count')).toHaveText('3 subscriptions found');
});
```

### The Testing Pyramid for Scraper-Based Systems

```
                    /\
                   /  \  E2E: Mock scraper output, test UI rendering
                  /    \
                 /------\
                /        \  Integration: Test scraper against recorded HTML
               /          \
              /------------\
             /              \  Unit: Test parsers with HTML strings
            /________________\
```

---

## 7. Testing Data Export/Import

### Pattern 1: CSV Download Testing in Playwright

```typescript
// tests/export/csv-download.spec.ts
test('exports customer data as CSV', async ({ page }) => {
  await page.goto('/dashboard');

  // Listen for download event BEFORE clicking
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;

  // Verify filename
  expect(download.suggestedFilename()).toMatch(/customers-\d{4}-\d{2}-\d{2}\.csv/);

  // Read and validate content
  const path = await download.path();
  const content = readFileSync(path!, 'utf-8');
  const rows = content.split('\n');

  // Verify header
  expect(rows[0]).toBe('Account,Name,Opportunity,Amount,Stage,Close Date');

  // Verify data rows exist
  expect(rows.length).toBeGreaterThan(1);

  // Verify a specific expected row
  expect(content).toContain('Acme Corp');
});
```

### Pattern 2: CSV Content Validation with Parsing

```typescript
import { parse } from 'csv-parse/sync';

test('CSV export contains correct data matching dashboard', async ({ page }) => {
  // Mock consistent data
  await page.route('**/api/pipeline', route =>
    route.fulfill({ body: JSON.stringify(mockPipelineData) })
  );

  await page.goto('/dashboard');

  // Get dashboard row count
  const dashboardRows = await page.getByTestId('pipeline-row').count();

  // Download CSV
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;

  const csvContent = readFileSync((await download.path())!, 'utf-8');
  const records = parse(csvContent, { columns: true });

  // CSV should match dashboard
  expect(records.length).toBe(dashboardRows);

  // Verify data integrity
  for (const record of records) {
    expect(record).toHaveProperty('Account');
    expect(record).toHaveProperty('Amount');
    expect(parseFloat(record.Amount)).not.toBeNaN();
  }
});
```

### Pattern 3: Google Sheets Write Verification

```typescript
// tests/export/sheets-write.spec.ts
test('writes data to Google Sheets correctly', async ({ page }) => {
  // Intercept the Sheets write API call
  const sheetsWritePromise = page.waitForRequest(req =>
    req.url().includes('/api/sheets/write') && req.method() === 'POST'
  );

  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Push to Sheets' }).click();

  const request = await sheetsWritePromise;
  const body = JSON.parse(request.postData()!);

  // Verify the payload shape
  expect(body).toMatchObject({
    sheetId: expect.any(String),
    range: expect.stringMatching(/[A-Z]+\d+/),
    values: expect.any(Array),
  });

  // Verify data integrity
  expect(body.values[0]).toEqual(['Account', 'Name', 'Amount', 'Stage']); // Header row
  expect(body.values.length).toBeGreaterThan(1);
});
```

### Pattern 4: Import File Testing

```typescript
test('imports CSV file and populates form', async ({ page }) => {
  await page.goto('/import');

  // Create a test CSV file
  const csvContent = 'Account,Territory\nAcme Corp,West\nGlobex,East';

  // Use Playwright's file chooser
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const fileChooser = await fileChooserPromise;

  await fileChooser.setFiles({
    name: 'accounts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvContent),
  });

  // Verify imported data appears
  await expect(page.getByText('Acme Corp')).toBeVisible();
  await expect(page.getByText('2 accounts imported')).toBeVisible();
});
```

---

## 8. Test Data Factories and Fixtures

### Recommended Library: Fishery

[Fishery](https://github.com/thoughtbot/fishery) by thoughtbot is the gold standard for TypeScript test data factories. It provides type-safe factories with builder-pattern ergonomics.

### Pattern 1: Define Factories Matching Production Schema

```typescript
// factories/customer.factory.ts
import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';
import type { Customer, Subscription, Opportunity } from '../types';

export const subscriptionFactory = Factory.define<Subscription>(({ sequence }) => ({
  id: `sub-${sequence}`,
  name: faker.helpers.arrayElement([
    'Red Hat Enterprise Linux Server',
    'Red Hat OpenShift Container Platform',
    'Red Hat Ansible Automation Platform',
  ]),
  status: faker.helpers.arrayElement(['Active', 'Expired', 'Future']),
  startDate: faker.date.past({ years: 2 }).toISOString().split('T')[0],
  endDate: faker.date.future({ years: 2 }).toISOString().split('T')[0],
  quantity: faker.number.int({ min: 1, max: 100 }),
}));

export const opportunityFactory = Factory.define<Opportunity>(({ sequence }) => ({
  id: `opp-${sequence}`,
  name: `${faker.company.name()} - Renewal`,
  amount: faker.number.int({ min: 10000, max: 500000 }),
  stage: faker.helpers.arrayElement([
    'Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost',
  ]),
  closeDate: faker.date.future({ years: 1 }).toISOString().split('T')[0],
  probability: faker.number.int({ min: 0, max: 100 }),
}));

export const customerFactory = Factory.define<Customer>(({ sequence, associations }) => ({
  accountId: `acct-${sequence}`,
  name: faker.company.name(),
  territory: faker.helpers.arrayElement(['Enterprise West A', 'Enterprise East B', 'Commercial Central']),
  ae: faker.person.fullName(),
  subscriptions: associations.subscriptions || subscriptionFactory.buildList(3),
  opportunities: associations.opportunities || opportunityFactory.buildList(2),
  healthScore: faker.number.int({ min: 1, max: 100 }),
  lastContact: faker.date.recent({ days: 30 }).toISOString(),
}));
```

### Pattern 2: Scenario Builders

```typescript
// factories/scenarios.ts
export const scenarios = {
  healthyAccount: () => customerFactory.build({
    healthScore: 85,
    subscriptions: subscriptionFactory.buildList(5, { status: 'Active' }),
    opportunities: [opportunityFactory.build({ stage: 'Closed Won', amount: 250000 })],
  }),

  atRiskAccount: () => customerFactory.build({
    healthScore: 25,
    subscriptions: [
      subscriptionFactory.build({ status: 'Active', endDate: '2026-04-15' }), // Expiring soon
      subscriptionFactory.build({ status: 'Expired' }),
    ],
    opportunities: [],
    lastContact: faker.date.past({ years: 1 }).toISOString(), // Long time ago
  }),

  newAccount: () => customerFactory.build({
    healthScore: 50,
    subscriptions: subscriptionFactory.buildList(1, { status: 'Future' }),
    opportunities: [opportunityFactory.build({ stage: 'Prospecting' })],
  }),

  fullTerritory: (count = 15) => customerFactory.buildList(count),
};
```

### Pattern 3: Factory-to-Fixture Pipeline

```typescript
// fixtures/generate.ts
// Run this script to regenerate fixtures from factories when schemas change

import { scenarios } from '../factories/scenarios';
import { writeFileSync } from 'fs';

const fixtures = {
  'dashboard-mixed': {
    customers: [
      scenarios.healthyAccount(),
      scenarios.atRiskAccount(),
      scenarios.newAccount(),
      ...scenarios.fullTerritory(5),
    ],
  },
  'empty-territory': {
    customers: [],
  },
  'all-at-risk': {
    customers: Array.from({ length: 8 }, () => scenarios.atRiskAccount()),
  },
};

for (const [name, data] of Object.entries(fixtures)) {
  writeFileSync(`./fixtures/${name}.json`, JSON.stringify(data, null, 2));
}
```

### Alternative: factory.ts

For simpler needs, [factory.ts](https://github.com/willryan/factory.ts) provides a more functional approach:

```typescript
import { makeFactory, each } from 'factory.ts';

const customerFactory = makeFactory<Customer>({
  accountId: each(i => `acct-${i}`),
  name: each(() => faker.company.name()),
  territory: 'Enterprise West A',
  healthScore: 75,
});

// Usage
const customer = customerFactory.build({ name: 'Override Corp' });
const customers = customerFactory.buildList(10);
```

---

## 9. Testing Real-Time Features (SSE)

### The Playwright SSE Challenge

**Known limitation**: Playwright's `page.route()` does NOT intercept EventSource requests. This is a documented issue ([microsoft/playwright#15353](https://github.com/microsoft/playwright/issues/15353)). EventSource uses a different connection mechanism than fetch/XHR.

### Pattern 1: Mock at the Server Level with MSW

```typescript
// tests/setup/msw-handlers.ts
import { http, HttpResponse } from 'msw';

export const sseHandlers = [
  http.get('/api/events/scraper-progress', () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Simulate scraper progress events
        const events = [
          { type: 'progress', data: { step: 'login', percent: 10 } },
          { type: 'progress', data: { step: 'navigate', percent: 30 } },
          { type: 'progress', data: { step: 'scrape', percent: 70 } },
          { type: 'complete', data: { step: 'done', percent: 100 } },
        ];

        let i = 0;
        const interval = setInterval(() => {
          if (i >= events.length) {
            clearInterval(interval);
            controller.close();
            return;
          }
          const msg = `event: ${events[i].type}\ndata: ${JSON.stringify(events[i].data)}\n\n`;
          controller.enqueue(encoder.encode(msg));
          i++;
        }, 100);
      },
    });

    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }),
];
```

### Pattern 2: Test SSE via Application State Observation

Instead of intercepting the SSE stream, observe the UI effects:

```typescript
// tests/realtime/scraper-progress.spec.ts
test('scraper progress updates render in real-time', async ({ page }) => {
  // Start with a test server that emits SSE events on a schedule
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Run Scraper' }).click();

  // Observe the UI updates (don't try to intercept the SSE)
  await expect(page.getByTestId('progress-bar')).toBeVisible();

  // Wait for progress to reach 100%
  await expect(page.getByTestId('progress-text')).toHaveText('100%', { timeout: 10000 });
  await expect(page.getByText('Scraping complete')).toBeVisible();
});
```

### Pattern 3: Test Mode Flag for SSE

```typescript
// In the app: check for test mode to use polling instead of SSE
const useSSE = process.env.NODE_ENV !== 'test';

if (useSSE) {
  const eventSource = new EventSource('/api/events/progress');
  eventSource.onmessage = handleProgress;
} else {
  // Poll endpoint instead (Playwright CAN intercept fetch)
  setInterval(async () => {
    const res = await fetch('/api/progress');
    handleProgress(await res.json());
  }, 500);
}
```

```typescript
// Now tests can mock the polling endpoint easily
test('progress updates render correctly', async ({ page }) => {
  let callCount = 0;
  await page.route('**/api/progress', route => {
    callCount++;
    const progress = Math.min(callCount * 25, 100);
    route.fulfill({
      body: JSON.stringify({ percent: progress, step: `Step ${callCount}` }),
    });
  });

  await page.goto('/dashboard?testMode=true');
  await page.getByRole('button', { name: 'Run Scraper' }).click();

  await expect(page.getByTestId('progress-text')).toHaveText('100%', { timeout: 5000 });
});
```

### Strategic Recommendation

For DailyBriefDashboard, **Pattern 3 (test mode flag)** is the most pragmatic. SSE is a transport mechanism -- the business logic is "show progress updates as they arrive." Testing the transport mechanism itself has diminishing returns compared to testing that progress states render correctly.

---

## 10. Snapshot Testing for API Contracts

### Pattern 1: Zod Schema Validation (Recommended)

From Tim Deschryver's excellent pattern, using Zod as both runtime validation and test assertion:

```typescript
// contracts/api-schemas.ts
import { z } from 'zod';

export const PipelineResponseSchema = z.object({
  customers: z.array(z.object({
    accountId: z.string(),
    name: z.string(),
    territory: z.string(),
    ae: z.string(),
    subscriptions: z.array(z.object({
      name: z.string(),
      status: z.enum(['Active', 'Expired', 'Future']),
      startDate: z.string(),
      endDate: z.string(),
    })),
    opportunities: z.array(z.object({
      name: z.string(),
      amount: z.number(),
      stage: z.string(),
      closeDate: z.string(),
    })),
  })),
  meta: z.object({
    dataAsOf: z.string().datetime(),
    source: z.string(),
    freshnessStatus: z.enum(['fresh', 'stale', 'expired']),
  }),
});

// Custom Playwright matcher
import { expect } from '@playwright/test';

expect.extend({
  toMatchSchema(received: unknown, schema: z.ZodType) {
    const result = schema.safeParse(received);
    return {
      pass: result.success,
      message: () =>
        result.success
          ? 'Expected response NOT to match schema'
          : `Schema validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`,
    };
  },
});
```

```typescript
// tests/api/contracts.spec.ts
test.describe('API contract validation', () => {
  test('GET /api/pipeline matches schema', async ({ request }) => {
    const response = await request.get('/api/pipeline');
    const body = await response.json();
    expect(body).toMatchSchema(PipelineResponseSchema);
  });

  test('GET /api/customers/:id matches schema', async ({ request }) => {
    const response = await request.get('/api/customers/acct-1');
    const body = await response.json();
    expect(body).toMatchSchema(CustomerDetailSchema);
  });
});
```

### Pattern 2: Snapshot Testing with Playwright

```typescript
// tests/api/snapshots.spec.ts
test('API response shape matches snapshot', async ({ request }) => {
  const response = await request.get('/api/pipeline');
  const body = await response.json();

  // Snapshot the SHAPE, not the VALUES
  const shape = extractShape(body);
  expect(shape).toMatchSnapshot('pipeline-response-shape');
});

// Helper: extract shape without values
function extractShape(obj: unknown): unknown {
  if (obj === null) return 'null';
  if (Array.isArray(obj)) {
    return obj.length > 0 ? [extractShape(obj[0])] : '[]';
  }
  if (typeof obj === 'object') {
    const shape: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj!)) {
      shape[key] = extractShape(value);
    }
    return shape;
  }
  return typeof obj; // 'string', 'number', 'boolean'
}
```

This produces snapshots like:

```json
{
  "customers": [{
    "accountId": "string",
    "name": "string",
    "territory": "string",
    "subscriptions": [{
      "name": "string",
      "status": "string",
      "startDate": "string"
    }]
  }],
  "meta": {
    "dataAsOf": "string",
    "freshnessStatus": "string"
  }
}
```

### Pattern 3: Contract Testing Between Frontend and Backend

```typescript
// shared/contracts.ts - used by BOTH frontend and backend
export const contracts = {
  'GET /api/pipeline': {
    response: PipelineResponseSchema,
  },
  'GET /api/customers/:id': {
    params: z.object({ id: z.string() }),
    response: CustomerDetailSchema,
  },
  'POST /api/scrape/supportable': {
    body: z.object({ accountId: z.string() }),
    response: ScrapeResultSchema,
  },
};

// Backend test: verify endpoints produce valid responses
test.each(Object.entries(contracts))('%s matches contract', async ([endpoint, contract]) => {
  const [method, path] = endpoint.split(' ');
  const response = await request[method.toLowerCase()](path.replace(':id', 'test-1'));
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchSchema(contract.response);
});

// Frontend test: verify UI handles the schema correctly
test('dashboard renders all contract fields', async ({ page }) => {
  const mockData = generateFromSchema(PipelineResponseSchema);
  await page.route('**/api/pipeline', route =>
    route.fulfill({ body: JSON.stringify(mockData) })
  );
  await page.goto('/dashboard');
  // Verify every field in the schema is rendered somewhere
});
```

---

## 11. Strategic Recommendations for DailyBriefDashboard

### The Testing Pyramid for This Architecture

```
                        /\
                       /  \  Smoke (Nightly)
                      / 2-5 \ Real Salesforce + Sheets
                     /  tests \
                    /----------\
                   /            \  E2E (Per-commit)
                  / 15-25 tests  \ Wizard flows, dashboard rendering
                 /  mocked APIs   \ CSV export, session management
                /------------------\
               /                    \  Integration (Per-commit)
              /   20-40 tests        \ Scraper against recorded HTML
             /  Pipeline junctions    \ Sheets round-trip
            /  API contract validation \
           /----------------------------\
          /                              \  Unit (Per-commit)
         /       50-100 tests             \ Parsers, formatters
        /  Data transformation functions   \ Factory builders
       /  Schema validation functions       \
      /______________________________________\
```

### Priority Order for Implementation

Given the review findings from 2026-03-29, here is the recommended implementation sequence:

**Phase 1 (Week 1): Foundation**
1. Set up Fishery factories matching production schemas
2. Define Zod contracts for all API endpoints
3. Create recorded HTML fixtures for scrapers
4. Implement saved auth state pattern

**Phase 2 (Week 2): Critical Paths**
5. Wizard E2E tests (forward/back, validation, fresh container)
6. Scraper unit tests (parser functions against HTML strings)
7. API contract tests (Zod validation for every endpoint)

**Phase 3 (Week 3): Data Integrity**
8. Pipeline junction tests (Sheets round-trip)
9. Data freshness indicator tests
10. CSV export validation tests

**Phase 4 (Week 4): Resilience**
11. Error recovery tests (API failures mid-wizard, scraper failures)
12. Session expiry detection tests
13. SSE progress testing (test mode flag approach)

### Second-Order Effects to Consider

1. **Test data drift**: Factories will drift from production schemas over time. Mitigate with weekly contract tests against real APIs that fail loudly when shapes change.

2. **Recorded HTML rot**: Target sites change their HTML structure. Set up a weekly job that re-records HTML snapshots and fails if scraper tests break against new snapshots.

3. **Mock fidelity**: The more you mock, the more your tests test mocks instead of reality. The smoke test layer (real APIs, nightly) is your reality anchor. Never skip it.

4. **Container testing gap**: The feedback about fresh container testing is strategically critical. Every E2E test should use `browser.newContext()` (a fresh browser profile) and the CI pipeline should always run in a fresh container. Never rely on warm state.

---

## Sources

- [BrowserStack: Salesforce Testing](https://www.browserstack.com/guide/salesforce-testing)
- [Bunnyshell: E2E Testing Best Practices 2026](https://www.bunnyshell.com/blog/best-practices-for-end-to-end-testing-in-2025/)
- [datawookie: Test a Playwright Web Scraper](https://datawookie.dev/blog/2025/04/test-a-playwright-web-scraper/)
- [Andrey Enin: API Contract Testing on Frontend with Playwright](https://adequatica.medium.com/api-contract-testing-on-frontend-with-playwright-4509b74b3008)
- [DQOps: How to Detect Timeliness and Freshness Issues](https://dqops.com/docs/categories-of-data-quality-checks/how-to-detect-timeliness-and-freshness-issues/)
- [Monte Carlo: Data Freshness Explained](https://www.montecarlodata.com/blog-data-freshness-explained/)
- [Elementary: Data Freshness Best Practices](https://www.elementary-data.com/post/data-freshness-best-practices-and-key-metrics-to-measure-success)
- [Tacnode: Stale Data Detection and Freshness SLAs](https://tacnode.io/post/what-is-stale-data)
- [Wiiisdom: Data Freshness in Tableau](https://wiiisdom.com/blog/data-freshness-tableau/)
- [Playwright: Authentication Docs](https://playwright.dev/docs/auth)
- [Tim Deschryver: Fast Authentication with Playwright](https://timdeschryver.dev/blog/fast-and-easy-authentication-with-playwright)
- [Tim Deschryver: Playwright API Testing with Zod](https://timdeschryver.dev/blog/playwright-api-testing-with-zod)
- [Elio Struyf: E2E Testing in MFA Environment](https://www.eliostruyf.com/e2e-testing-mfa-environment-playwright-auth-session/)
- [Khurram Muslim: OAuth 2.0 PKCE with Playwright](https://medium.com/@khurrammuslim/api-testing-with-playwright-automating-oauth-2-0-authentication-with-pkce-ac564194642f)
- [MSW: Mock SSE](https://alexocallaghan.com/mock-sse-with-msw)
- [Playwright GitHub: SSE EventSource Issue #15353](https://github.com/microsoft/playwright/issues/15353)
- [DZone: Playwright Testing WebSockets and Live Data](https://dzone.com/articles/playwright-for-real-time-applications-testing-webs)
- [thoughtbot: Fishery Factory Library](https://github.com/thoughtbot/fishery)
- [factory.ts: TypeScript Test Data Factory](https://github.com/willryan/factory.ts)
- [LeaseLock: Stepping Up Fixtures with Fishery](https://medium.com/leaselock-engineering/stepping-up-our-test-fixture-game-with-fishery-be22b76d1f22)
- [Strapi: Data-Driven Testing with Playwright](https://strapi.io/blog/data-driven-testing-with-playwright)
- [Playwright: API Testing Docs](https://playwright.dev/docs/api-testing)
- [Playwright: Snapshot Testing Docs](https://playwright.dev/docs/aria-snapshots)
- [Checkly: Testing APIs with Playwright](https://www.checklyhq.com/docs/learn/playwright/testing-apis/)
- [DEV.to: Design Pattern for Playwright E2E Testing](https://dev.to/project_au_lait/design-pattern-for-playwright-end-to-end-testing-1idc)
- [Rost Glukhov: Playwright for Scraping and Testing](https://www.glukhov.org/post/2025/12/playwright-for-scraping-and-testing-webapps/)
- [Metabase GitHub](https://github.com/metabase/metabase)
- [Elio Navarrete: 12 E2E Best Practices with Playwright](https://elionavarrete.com/blog/e2e-best-practices-playwright.html)
- [DEV.to: Building E2E Test Suite with Playwright - 100+ Cases](https://dev.to/bugslayer/building-a-comprehensive-e2e-test-suite-with-playwright-lessons-from-100-test-cases-171k)
- [Testers Talk: Download & Validate Excel in Playwright](https://medium.com/@testerstalk/how-to-download-validate-excel-file-in-playwright-b8acbb19a4e8)
