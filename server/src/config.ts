import { many, one, type Db } from './db.ts';

/**
 * Per-tenant rules, read from the database rather than baked into the code.
 * Resolved once per request, never per line.
 */

export interface ShrinkagePolicy {
  warnPct: number;
  maxPct: number;
  gainPct: number;
}

const DEFAULT_SHRINKAGE: ShrinkagePolicy = { warnPct: 8, maxPct: 12, gainPct: 1 };

export async function shrinkagePolicy(
  db: Db, tenantId: string, qualityId: string | null, processHouseId: string | null
): Promise<ShrinkagePolicy> {
  const row = await one<{ warn_pct: number; max_pct: number; gain_pct: number }>(
    db, 'select * from shrinkage_policy_for($1, $2, $3)', [tenantId, qualityId, processHouseId]
  );
  return row
    ? { warnPct: row.warn_pct, maxPct: row.max_pct, gainPct: row.gain_pct }
    : DEFAULT_SHRINKAGE;
}

/** One statement for a whole receipt, whatever mix of qualities it carries. */
export async function shrinkagePoliciesFor(
  db: Db, tenantId: string, processHouseId: string, qualityIds: string[]
): Promise<Map<string, ShrinkagePolicy>> {
  const rows = await many<{ quality_id: string; warn_pct: number; max_pct: number; gain_pct: number }>(
    db,
    `select q.id as quality_id, p.warn_pct, p.max_pct, p.gain_pct
       from unnest($1::uuid[]) as q(id)
       cross join lateral shrinkage_policy_for($2, q.id, $3) as p`,
    [[...new Set(qualityIds)], tenantId, processHouseId]
  );
  return new Map(rows.map(r => [
    r.quality_id, { warnPct: r.warn_pct, maxPct: r.max_pct, gainPct: r.gain_pct }
  ]));
}

export async function settings(db: Db): Promise<Map<string, unknown>> {
  const rows = await many<{ key: string; value: unknown }>(db, 'select key, value from tenant_setting');
  return new Map(rows.map(r => [r.key, r.value]));
}

export const boolSetting = (s: Map<string, unknown>, key: string, fallback = false) => {
  const v = s.get(key);
  return typeof v === 'boolean' ? v : fallback;
};

export interface BrokerageRule {
  brokerId: string;
  basis: 'percent_of_value' | 'per_unit' | 'flat';
  rate: number;
}

/** Most specific first: a rule naming this party beats the broker-wide one. */
export async function brokerageFor(
  db: Db, brokerId: string | null, partyId: string, docType: string
): Promise<BrokerageRule | null> {
  if (!brokerId) return null;
  return one<BrokerageRule>(
    db,
    `select broker_id as "brokerId", basis, rate
       from brokerage_rule
      where broker_id = $1 and doc_type = $3
        and (party_id = $2 or party_id is null)
      order by (party_id is not null) desc
      limit 1`,
    [brokerId, partyId, docType]
  );
}

export function brokerageAmount(rule: BrokerageRule, value: number, units: number): number {
  switch (rule.basis) {
    case 'percent_of_value': return Math.round(value * rule.rate) / 100;
    case 'per_unit': return Math.round(units * rule.rate * 100) / 100;
    case 'flat': return Math.round(rule.rate * 100) / 100;
  }
}

/**
 * Credit control. Returns the shortfall when a new document would breach the
 * party's limit, or null when it is fine.
 */
export async function creditBreach(
  db: Db, partyId: string, addingValue: number
): Promise<{ limit: number; outstanding: number; wouldBe: number } | null> {
  const row = await one<{ credit_limit: number; outstanding: number }>(
    db,
    `select la.credit_limit,
            coalesce((select sum(vl.debit - vl.credit)
                        from voucher_line vl
                        join voucher v on v.id = vl.voucher_id and v.is_posted
                       where vl.ledger_id = la.id), 0) as outstanding
       from ledger_account la where la.id = $1`,
    [partyId]
  );
  if (!row || Number(row.credit_limit) <= 0) return null;

  const wouldBe = Number(row.outstanding) + addingValue;
  if (wouldBe <= Number(row.credit_limit)) return null;
  return { limit: Number(row.credit_limit), outstanding: Number(row.outstanding), wouldBe };
}
