import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill('owner@neelkamal.test');
  await page.getByLabel('Password').fill('changeme');
  await page.getByRole('button', { name: /sign in/i }).click();
  // bcrypt is deliberately expensive.  A constrained pilot laptop can take
  // longer than Playwright's five-second assertion default while the full
  // release gate is also building images; that is not a failed login.
  await expect(page.getByText('Neelkamal Textiles').first()).toBeVisible({ timeout: 20_000 });
}

const OWNER_MODULES = [
  'dashboard', 'global_search', 'approvals', 'password', 'company_setup', 'go_live_readiness', 'platform_studio', 'edition_weaving', 'edition_dyeing', 'edition_exports', 'edition_logistics', 'edition_garments', 'barcode_history', 'audit_trail',
  'ledgers', 'qualities', 'grades', 'hsn-codes', 'units', 'widths', 'racks', 'bank-accounts', 'users', 'data_onboarding',
  'purchase_orders', 'sales_orders', 'grey_inward', 'dyeing_issue', 'dyeing_receipt', 'reprocess', 'grey_return', 'dyeing_return',
  'customer_return', 'write_off', 'cut_pack', 'regroup', 'stock_count', 'location_transfers', 'delivery_challans', 'labels',
  'dispatch', 'packing_lists', 'payments', 'bank_reconciliation', 'mill_integrations', 'sales_invoices', 'purchase_invoices', 'gst_notes', 'profit_loss',
  'balance_sheet', 'trial_balance', 'party_statement', 'receivable_ageing', 'outstanding_sales',
  'outstanding_purchases', 'party_balance', 'tds_summary', 'year_close', 'gstr1_b2b', 'gstr1_cdnr',
  'gstr1_hsn', 'gstr3b', 'itc04', 'eway_bills', 'itc_summary', 'gst_liability', 'einvoice_pending',
  'gstr2b_reconciliation', 'stock_valuation', 'cash_book', 'stock_summary', 'process_stock',
  'po_pending', 'shrinkage', 'quality_margin', 'weaver_scorecard', 'process_house_scorecard'
] as const;

test('desktop shell, deep links, forms and setup are operable and accessible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop gate');
  await signIn(page);

  await expect(page.getByText("Loading today's position…")).toBeHidden();

  const dashboardA11y = await new AxeBuilder({ page }).analyze();
  expect(dashboardA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);

  await page.getByRole('button', { name: 'Inventory' }).click();
  await page.getByRole('button', { name: 'Grey Inward (Barcoding)' }).click();
  await expect(page).toHaveURL(/#\/grey_inward$/);
  await expect(page.getByLabel(/Weaver \/ Grey Supplier/)).toBeVisible();
  await expect(page.getByLabel(/Their Challan No/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Weaver \/ Grey Supplier/)).toBeVisible();

  await page.getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Company Setup & Controls' }).click();
  await expect(page.getByRole('heading', { name: 'Company Setup and Accounting Controls' })).toBeAttached();
  await expect(page.getByLabel('Financial year')).toBeVisible();
  const setupA11y = await new AxeBuilder({ page }).analyze();
  expect(setupA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);

  await page.getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Go-Live Readiness' }).click();
  await expect(page.getByRole('heading', { name: 'Commercial foundation gate' })).toBeVisible();
  const cutoverA11y = await new AxeBuilder({ page }).analyze();
  expect(cutoverA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);

  await page.evaluate(() => { window.location.hash = '#/trial_balance'; });
  await expect(page.getByText('My saved reports')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Excel', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print PDF' })).toBeVisible();
  // A trial balance is a position as on today, so it offers no date range.
  await expect(page.getByText(/Position as on today/)).toBeVisible();
  await expect(page.getByLabel('From date')).toHaveCount(0);
  await page.getByText(/Columns \(6\/6\)/).click();
  await page.getByLabel('Control A/c').uncheck();
  await expect(page.getByRole('columnheader', { name: 'Control A/c' })).toHaveCount(0);
  const reportA11y = await new AxeBuilder({ page }).analyze();
  expect(reportA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);

  // A period report does offer one, and a ledger opens with a carried balance.
  await page.evaluate(() => { window.location.hash = '#/day_book'; });
  await expect(page.getByLabel('From date')).toBeVisible();
  await expect(page.getByLabel('To date')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/ledger'; });
  await expect(page.getByLabel('Account', { exact: true })).toBeVisible();
  await expect(page.getByText(/Choose an account to see its ledger/)).toBeVisible();
  const ledgerA11y = await new AxeBuilder({ page }).analyze();
  expect(ledgerA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);

  await page.evaluate(() => { window.location.hash = '#/platform_studio'; });
  await expect(page.getByRole('heading', { name: /Define one field/ })).toBeVisible();
  await page.getByRole('button', { name: 'Report builder' }).click();
  await expect(page.getByRole('heading', { name: 'Safe report builder' })).toBeVisible();
  await page.getByRole('button', { name: 'Integration feeds' }).click();
  await expect(page.getByRole('heading', { name: 'Audited pull integrations' })).toBeVisible();
  const platformA11y = await new AxeBuilder({ page }).analyze();
  expect(platformA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);

  await page.evaluate(() => { window.location.hash = '#/edition_weaving'; });
  await expect(page.getByRole('heading', { name: 'Weaving operations' })).toBeVisible();
  await expect(page.getByLabel('Edition workflow')).toHaveValue('loom_plan');
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeVisible();
  const editionA11y = await new AxeBuilder({ page }).analyze();
  expect(editionA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);
});

test('mobile navigation exposes every module without viewport clipping', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'mobile gate');
  await signIn(page);
  const mobileA11y = await new AxeBuilder({ page }).analyze();
  expect(mobileA11y.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('button', { name: 'GSTR-1 B2B' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Company Setup & Controls' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go-Live Readiness' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Customization & Integration Studio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Weaving Edition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Garments Edition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Godown Stock Transfers' })).toBeVisible();

  const clipped = await page.locator('button:visible, input:visible, select:visible').evaluateAll(nodes =>
    nodes.map(node => {
      const r = node.getBoundingClientRect();
      return { text: node.getAttribute('aria-label') || node.textContent?.trim(), left: r.left, right: r.right,
        top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }).filter(r => r.left < -1 || r.right > window.innerWidth + 1 || r.width < 1 || r.height < 1)
  );
  expect(clipped).toEqual([]);

  const undersized = await page.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(nodes =>
    nodes.map(node => {
      const r = node.getBoundingClientRect();
      return { name: node.getAttribute('aria-label') || node.textContent?.trim(), width: r.width, height: r.height };
    }).filter(r => r.width < 44 || r.height < 44)
  );
  expect(undersized).toEqual([]);

  await page.getByRole('button', { name: 'GSTR-1 B2B' }).click();
  await expect(page).toHaveURL(/#\/gstr1_b2b$/);
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('desktop workspaces preserve a draft while comparing another screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop gate');
  await signIn(page);
  await page.getByRole('button', { name: 'Inventory' }).click();
  await page.getByRole('button', { name: 'Grey Inward (Barcoding)' }).click();
  await page.getByLabel(/Their Challan No/).fill('UNSAVED-DRAFT');

  await page.getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('tab', { name: 'Grey Inward (Barcoding)' }).click();
  await expect(page.getByLabel(/Their Challan No/)).toHaveValue('UNSAVED-DRAFT');
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Close Dashboard' }).click();
  await expect(page.getByRole('tab', { name: 'Dashboard' })).toHaveCount(0);
});

test('every owner module renders without a browser crash or server error', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop gate');
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('response', response => {
    if (response.url().includes('/api/') && response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  await signIn(page);

  for (const moduleId of OWNER_MODULES) {
    await page.evaluate(id => { window.location.hash = `#/${id}`; }, moduleId);
    await expect(page).toHaveURL(new RegExp(`#/${moduleId.replace('-', '\\-')}$`));
    await expect(page.getByText('This screen could not be drawn')).toHaveCount(0);
    await page.waitForTimeout(75);
  }

  expect(browserErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});
