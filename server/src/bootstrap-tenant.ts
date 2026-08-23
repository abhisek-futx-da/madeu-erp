import pg from 'pg';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

/**
 * Creates a deliberately empty company.  This is a deployment-only tool, not
 * an HTTP route: a public self-signup endpoint would be a cross-tenant access
 * risk, and a real mill must never inherit the demonstration company's stock,
 * parties, bank account, or books.
 */

const password = z.string().min(12, 'owner password must be at least 12 characters').max(128)
  .refine(value => /[a-z]/.test(value), 'owner password must include a lowercase letter')
  .refine(value => /[A-Z]/.test(value), 'owner password must include an uppercase letter')
  .refine(value => /\d/.test(value), 'owner password must include a number');

const inputSchema = z.object({
  legalName: z.string().trim().min(2).max(160),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/, 'invalid GSTIN shape'),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'invalid PAN shape'),
  stateCode: z.string().trim().regex(/^[0-9]{2}$/, 'state code must be two digits'),
  fyStart: z.string().regex(/^\d{4}-04-01$/, 'financial year must start on 1 April (YYYY-04-01)'),
  address1: z.string().trim().min(3).max(240),
  address2: z.string().trim().max(240).optional().default(''),
  city: z.string().trim().min(2).max(100),
  pincode: z.string().trim().regex(/^\d{6}$/, 'pincode must be six digits'),
  phone: z.string().trim().max(40)
    .refine(value => value.length === 0 || value.length >= 6, 'phone must be blank or at least six characters')
    .optional().default(''),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  ownerPassword: password
}).superRefine((value, ctx) => {
  if (value.gstin.slice(0, 2) !== value.stateCode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stateCode'], message: 'state code must match the first two GSTIN digits' });
  }
  if (value.gstin.slice(2, 12) !== value.pan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pan'], message: 'PAN must match GSTIN characters 3–12' });
  }
});

export type BootstrapInput = z.input<typeof inputSchema>;
type CleanInput = z.output<typeof inputSchema>;

export interface BootstrapResult {
  tenantId: string;
  ownerId: string;
  ownerEmail: string;
  financialYear: string;
  systemLedgers: number;
}

type ControlSpec = { code: string; name: string; subControl: string; nature: string };
type LedgerSpec = { code: string; name: string; controlCode: string; postingRole?: string };

// System heads are intentionally generic.  A mill's parties, products, HSN/
// SAC, rates, racks, TDS rules, bank details, opening balances and approval
// limits have to come from that mill and its CA; fabricating those is worse
// than leaving the company empty.
const CONTROL_ACCOUNTS: ControlSpec[] = [
  { code: '10', name: 'Creditors for Brokerage', subControl: 'Sundry Creditors', nature: 'sundry_creditor_brokerage' },
  { code: '15', name: 'Current Assets - Stock', subControl: 'Inventory', nature: 'current_asset' },
  { code: '16', name: 'Bank Accounts', subControl: 'Bank', nature: 'bank' },
  { code: '17', name: 'Cash in Hand', subControl: 'Cash', nature: 'cash' },
  { code: '20', name: 'Creditors for Transport', subControl: 'Sundry Creditors', nature: 'sundry_creditor_transport' },
  { code: '30', name: 'Creditors for Process', subControl: 'Sundry Creditors', nature: 'sundry_creditor_process' },
  { code: '40', name: 'Creditors for Grey', subControl: 'Sundry Creditors', nature: 'sundry_creditor_grey' },
  { code: '50', name: 'Creditors for Finish', subControl: 'Sundry Creditors', nature: 'sundry_creditor_finish' },
  { code: '60', name: 'Creditors for Expenses', subControl: 'Sundry Creditors', nature: 'sundry_creditor_expense' },
  { code: '70', name: 'Debtors for Finish', subControl: 'Sundry Debtors', nature: 'sundry_debtor_finish' },
  { code: '80', name: 'GST A/C', subControl: 'Duties & Taxes', nature: 'duties_and_taxes' },
  { code: '81', name: 'Output GST', subControl: 'Duties & Taxes', nature: 'duties_and_taxes' },
  { code: '82', name: 'Input GST', subControl: 'Duties & Taxes', nature: 'duties_and_taxes' },
  { code: '90', name: 'Trading Purchase', subControl: 'Direct Expenses', nature: 'expense' },
  { code: '91', name: 'Trading Sales', subControl: 'Direct Income', nature: 'income' },
  { code: '92', name: 'Cost of Goods Sold', subControl: 'Direct Expenses', nature: 'expense' },
  { code: '93', name: 'Discounts Allowed', subControl: 'Indirect Expenses', nature: 'expense' },
  { code: '94', name: 'Discounts Received', subControl: 'Indirect Income', nature: 'income' },
  { code: '95', name: 'Rounding', subControl: 'Indirect Expenses', nature: 'expense' },
  { code: '96', name: 'Stock Loss on Verification', subControl: 'Indirect Expenses', nature: 'expense' },
  { code: '97', name: 'Stock Gain on Verification', subControl: 'Indirect Income', nature: 'income' },
  { code: '98', name: 'Brokerage Expense', subControl: 'Indirect Expenses', nature: 'expense' },
  { code: '99', name: 'Capital & Reserves', subControl: 'Capital Account', nature: 'capital' }
];

const LEDGERS: LedgerSpec[] = [
  { code: '900', name: 'Trading Purchase A/c', controlCode: '90', postingRole: 'purchase_grey' },
  { code: '901', name: 'Trading Sales A/c', controlCode: '91', postingRole: 'sales_finish' },
  { code: '903', name: 'Dyeing & Processing Charges', controlCode: '90', postingRole: 'purchase_jobwork' },
  { code: '910', name: 'Output CGST', controlCode: '81', postingRole: 'cgst_output' },
  { code: '911', name: 'Output SGST', controlCode: '81', postingRole: 'sgst_output' },
  { code: '912', name: 'Output IGST', controlCode: '81', postingRole: 'igst_output' },
  { code: '920', name: 'Input CGST', controlCode: '82', postingRole: 'cgst_input' },
  { code: '921', name: 'Input SGST', controlCode: '82', postingRole: 'sgst_input' },
  { code: '922', name: 'Input IGST', controlCode: '82', postingRole: 'igst_input' },
  { code: '930', name: 'Rounding Off', controlCode: '95', postingRole: 'round_off' },
  { code: '931', name: 'RCM Liability', controlCode: '81', postingRole: 'rcm_liability' },
  { code: '940', name: 'TDS Payable', controlCode: '80' },
  { code: '950', name: 'Retained Earnings', controlCode: '99', postingRole: 'retained_earnings' },
  { code: '960', name: 'Grey Stock', controlCode: '15', postingRole: 'inventory_grey' },
  { code: '961', name: 'Finish Stock', controlCode: '15', postingRole: 'inventory_finish' },
  { code: '962', name: 'Cost of Goods Sold', controlCode: '92', postingRole: 'cogs' },
  { code: '963', name: 'Stock Loss on Verification', controlCode: '96', postingRole: 'stock_loss' },
  { code: '964', name: 'Stock Gain on Verification', controlCode: '97', postingRole: 'stock_gain' },
  { code: '970', name: 'Cash in Hand', controlCode: '17', postingRole: 'cash' },
  { code: '980', name: 'Discount Allowed', controlCode: '93', postingRole: 'discount_allowed' },
  { code: '981', name: 'Discount Received', controlCode: '94', postingRole: 'discount_received' },
  { code: '982', name: 'Brokerage Expense', controlCode: '98', postingRole: 'brokerage_expense' }
];

const DOCUMENT_SERIES: Array<[string, string]> = [
  ['grey_po', 'GPO/'], ['grey_inward', 'GIN/'], ['dyeing_issue', 'DI/'],
  ['dyeing_receipt', 'DR/'], ['dispatch', 'DC/'], ['sales_order', 'SO/'],
  ['sales_invoice', 'INV/'], ['purchase_invoice', 'PIN/'], ['credit_note', 'CN/'],
  ['debit_note', 'DN/'], ['receipt_voucher', 'RV/'], ['payment_voucher', 'PV/'],
  ['stock_count', 'SC/'], ['write_off', 'WO/'], ['grey_return', 'GR/'],
  ['dyeing_return', 'DPR/'], ['customer_return', 'CR/'], ['piece_regroup', 'RG/'],
  ['dyeing_reprocess', 'RP/'], ['dyeing_reprocess_receipt', 'RR/'],
  ['eway_bill', 'EWB/'], ['voucher_purchase', 'PUR/'], ['voucher_sales', 'SAL/'],
  ['voucher_jobwork', 'JOB/'], ['voucher_receipt', 'RCT/'], ['voucher_payment', 'PMT/'],
  ['voucher_journal', 'JV/'], ['voucher_credit_note', 'CNV/'], ['voucher_debit_note', 'DNV/']
];

function yearLabel(fyStart: string) {
  const start = Number(fyStart.slice(0, 4));
  return `${start}-${String(start + 1).slice(2)}`;
}

function financialYearEnd(fyStart: string) {
  return `${Number(fyStart.slice(0, 4)) + 1}-03-31`;
}

type BootstrapDb = pg.PoolClient | pg.Client;

async function assertSchemaReady(db: BootstrapDb) {
  const { rows } = await db.query<{ missing: string[] }>(
    `select array_agg(required.name order by required.name) filter (where to_regclass(required.name) is null) as missing
       from unnest(array[
         'tenant', 'app_user', 'membership', 'control_account', 'ledger_account',
         'document_series', 'financial_year', 'tenant_setting', 'approval_rule',
         'unit_master', 'access_audit'
       ]) as required(name)`
  );
  if (rows[0]?.missing?.length) {
    throw new Error(`database schema is incomplete; run migrations first (missing ${rows[0].missing.join(', ')})`);
  }
}

export async function bootstrapTenant(db: BootstrapDb, raw: BootstrapInput): Promise<BootstrapResult> {
  const input: CleanInput = inputSchema.parse(raw);
  // Keep this deployment tool independent from the HTTP authentication module:
  // it must not need a JWT signing key just to create the first owner.
  const ownerPasswordHash = await bcrypt.hash(input.ownerPassword, 12);
  await assertSchemaReady(db);
  const fy = yearLabel(input.fyStart);

  await db.query('begin');
  try {
    const tenant = await db.query<{ id: string }>(
      `insert into tenant (legal_name, gstin, pan, state_code, fy_start, address1, address2, city, pincode, phone, email)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [input.legalName, input.gstin, input.pan, input.stateCode, input.fyStart,
       input.address1, input.address2 || null, input.city, input.pincode, input.phone || null, input.email]
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error('tenant creation returned nothing');

    const owner = await db.query<{ id: string }>(
      `insert into app_user (email, full_name, password_hash)
       values ($1,$2,$3) returning id`,
      [input.ownerEmail, input.ownerName, ownerPasswordHash]
    );
    const ownerId = owner.rows[0]?.id;
    if (!ownerId) throw new Error('owner creation returned nothing');
    await db.query(
      `insert into membership (tenant_id, user_id, role, is_active) values ($1,$2,'owner',true)`,
      [tenantId, ownerId]
    );

    const controlIds = new Map<string, string>();
    for (const control of CONTROL_ACCOUNTS) {
      const inserted = await db.query<{ id: string }>(
        `insert into control_account (tenant_id, code, name, sub_control, nature)
         values ($1,$2,$3,$4,$5::account_nature) returning id`,
        [tenantId, control.code, control.name, control.subControl, control.nature]
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error(`control account ${control.code} creation returned nothing`);
      controlIds.set(control.code, id);
    }

    for (const ledger of LEDGERS) {
      const controlId = controlIds.get(ledger.controlCode);
      if (!controlId) throw new Error(`missing control account ${ledger.controlCode}`);
      await db.query(
        `insert into ledger_account (tenant_id, code, name, control_account_id, gst_reg_type, posting_role)
         values ($1,$2,$3,$4,'unregistered',$5::posting_role)`,
        [tenantId, ledger.code, ledger.name, controlId, ledger.postingRole ?? null]
      );
    }

    await db.query(
      `insert into financial_year (tenant_id, label, starts_on, ends_on, status)
       values ($1,$2,$3,$4,'open')`,
      [tenantId, fy, input.fyStart, financialYearEnd(input.fyStart)]
    );
    await db.query(
      `insert into tenant_setting (tenant_id, key, value) values
         ($1, 'invoice.rounding', '"nearest_rupee"'::jsonb),
         ($1, 'credit.enforce_limit', 'true'::jsonb)`,
      [tenantId]
    );
    await db.query(
      `insert into unit_master (tenant_id, code, name, uqc) values
         ($1,'MTR','Meters','MTR'), ($1,'PCS','Pieces','PCS'),
         ($1,'KGS','Kilograms','KGS'), ($1,'YDS','Yards','YDS')`,
      [tenantId]
    );
    await db.query(
      `insert into approval_rule (tenant_id, doc_type, min_amount, approver_role) values
         ($1, 'sales_invoice', 0, 'owner'),
         ($1, 'purchase_invoice', 0, 'owner'),
         ($1, 'payment', 0, 'owner'),
         ($1, 'stock_count', 0, 'owner'),
         ($1, 'customer_return', 0, 'owner'),
         ($1, 'grey_return', 0, 'owner'),
         ($1, 'dyeing_return', 0, 'owner'),
         ($1, 'write_off', 0, 'owner'),
         ($1, 'dyeing_reprocess_receipt', 0, 'owner')`,
      [tenantId]
    );
    await db.query(
      `insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number)
       select $1, item.doc_type, $2, item.prefix || $3 || '/', 1
         from unnest($4::text[], $5::text[]) as item(doc_type, prefix)`,
      [tenantId, fy, fy.slice(2), DOCUMENT_SERIES.map(([type]) => type), DOCUMENT_SERIES.map(([, prefix]) => prefix)]
    );

    await db.query('commit');
    return { tenantId, ownerId, ownerEmail: input.ownerEmail, financialYear: fy, systemLedgers: LEDGERS.length };
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    throw error;
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function inputFromEnvironment(): BootstrapInput {
  if (process.env.BOOTSTRAP_CONFIRM !== 'CREATE_REAL_MILL') {
    throw new Error('refusing to create a company: set BOOTSTRAP_CONFIRM=CREATE_REAL_MILL exactly');
  }
  return {
    legalName: requiredEnv('BOOTSTRAP_LEGAL_NAME'),
    gstin: requiredEnv('BOOTSTRAP_GSTIN'),
    pan: requiredEnv('BOOTSTRAP_PAN'),
    stateCode: requiredEnv('BOOTSTRAP_STATE_CODE'),
    fyStart: requiredEnv('BOOTSTRAP_FY_START'),
    address1: requiredEnv('BOOTSTRAP_ADDRESS1'),
    address2: process.env.BOOTSTRAP_ADDRESS2 ?? '',
    city: requiredEnv('BOOTSTRAP_CITY'),
    pincode: requiredEnv('BOOTSTRAP_PINCODE'),
    phone: process.env.BOOTSTRAP_PHONE ?? '',
    email: requiredEnv('BOOTSTRAP_EMAIL'),
    ownerName: requiredEnv('BOOTSTRAP_OWNER_NAME'),
    ownerEmail: requiredEnv('BOOTSTRAP_OWNER_EMAIL'),
    ownerPassword: requiredEnv('BOOTSTRAP_OWNER_PASSWORD')
  };
}

async function main() {
  const db = new pg.Client(); // reads the dedicated PG* variables supplied by the tools-only Compose service
  await db.connect();
  try {
    const role = await db.query<{ current_user: string; app_role: boolean }>(
      `select current_user, current_user = 'link_erp_app' as app_role`
    );
    if (role.rows[0]?.app_role) {
      throw new Error('refusing to run with the application database role; use the protected deployment database credential');
    }
    const result = await bootstrapTenant(db, inputFromEnvironment());
    console.log(JSON.stringify({ created: result }, null, 2));
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
