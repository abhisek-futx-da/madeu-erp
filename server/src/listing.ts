import { z } from 'zod';
import type { Response } from 'express';
import { many, type Db } from './db.ts';

/**
 * Every document list was `... order by date desc limit 200` with no search,
 * no date range and no way past row 200 — so a mill's 201st dispatch was
 * simply unreachable. One helper gives all of them the same three controls
 * and the same paging contract, rather than eight near-identical rewrites.
 */

export const listQuery = z.object({
  q: z.string().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(['json', 'csv']).default('json')
});

export type ListQuery = z.infer<typeof listQuery>;

export interface ListSpec {
  /** The FROM and JOINs, without SELECT — reused for both rows and count. */
  from: string;
  /** Columns selected for the page of rows. */
  select: string;
  /** Columns `q` searches, matched case-insensitively on any of them. */
  search: string[];
  /** The date column `from`/`to` filter on. */
  dateColumn: string;
  orderBy: string;
  /** Extra always-on predicates, already parameterised as $1.. if needed. */
  where?: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Runs the page and its count. Two statements rather than a window function,
 * because the count must ignore LIMIT and a `count(*) over ()` returns nothing
 * at all once the offset runs past the end.
 */
export async function paged<T>(db: Db, spec: ListSpec, q: ListQuery): Promise<Page<T>> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (spec.where) clauses.push(`(${spec.where})`);

  if (q.q) {
    params.push(`%${q.q}%`);
    const p = `$${params.length}`;
    clauses.push(`(${spec.search.map(c => `${c} ilike ${p}`).join(' or ')})`);
  }
  if (q.from) {
    params.push(q.from);
    clauses.push(`${spec.dateColumn} >= $${params.length}::date`);
  }
  if (q.to) {
    params.push(q.to);
    clauses.push(`${spec.dateColumn} <= $${params.length}::date`);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';

  const countRows = await many<{ n: number }>(
    db, `select count(*)::int as n from (select 1 from ${spec.from} ${where}) c`, params
  );

  params.push(q.limit, q.offset);
  const rows = await many<T>(
    db,
    `select ${spec.select} from ${spec.from} ${where}
      order by ${spec.orderBy} limit $${params.length - 1} offset $${params.length}`,
    params
  );

  return { rows, total: countRows[0]?.n ?? 0, limit: q.limit, offset: q.offset };
}

/**
 * RFC 4180. A field is quoted whenever it contains a delimiter, a quote or a
 * newline; an inner quote is doubled. Excel is the destination for most of
 * these, and Excel reads a leading `=` or `+` as a formula, so those are
 * prefixed with a quote — a CSV is data, not a program.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  if (cols.length === 0) return '';

  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))];
  return lines.join('\r\n');
}

/** Sends `rows` as a download Excel will open with the right encoding. */
export function sendCsv(res: Response, filename: string, rows: Record<string, unknown>[]) {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${safe}.csv"`);
  // Excel reads a UTF-8 file as the local codepage unless it sees a BOM.
  res.send('﻿' + toCsv(rows));
}
