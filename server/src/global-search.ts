import { Router } from 'express';
import { z } from 'zod';
import { many, withTenant } from './db.ts';

export interface GlobalSearchResult {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  module: string;
  filter: string;
  status: string | null;
  occurred_on: string | null;
}

// Treat %, _ and \ as ordinary characters.  A search box must not become an
// accidental "return every row" endpoint just because an operator typed %.
const likeLiteral = (value: string) => value.replace(/[\\%_]/g, '\\$&');

export function globalSearchRouter() {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const query = z.object({
        q: z.string().trim().min(2).max(80),
        limit: z.coerce.number().int().min(1).max(50).default(40)
      }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const escaped = likeLiteral(query.q);
      const rows = await withTenant(tenantId, userId, db => many<GlobalSearchResult>(db,
        `with matches as (
           select 'piece'::text kind,p.id::text id,p.barcode title,
                  concat_ws(' · ',q.name,nullif(p.lot_no,''),p.status::text) subtitle,
                  'audit_trail'::text module,p.barcode search_term,p.status::text status,
                  p.updated_at occurred_on,
                  case when lower(p.barcode)=lower($2) then 0
                       when p.barcode ilike $3 escape '\\' then 1 else 2 end rank
             from piece p join quality q on q.id=p.quality_id
            where p.barcode ilike $1 escape '\\' or p.lot_no ilike $1 escape '\\'
           union all
           select 'ledger',l.id::text,l.code||' — '||l.name,
                  concat_ws(' · ',nullif(l.alias,''),l.gstin,l.mobile_e164),
                  'ledgers',l.code,case when l.is_active then 'active' else 'inactive' end,
                  l.updated_at,
                  case when lower(l.code)=lower($2) then 0
                       when l.code ilike $3 escape '\\' then 1 else 2 end
             from ledger_account l
            where l.code ilike $1 escape '\\' or l.name ilike $1 escape '\\'
               or l.alias ilike $1 escape '\\' or l.gstin ilike $1 escape '\\'
               or l.mobile_e164 ilike $1 escape '\\'
           union all
           select 'purchase_order',o.id::text,o.order_no,
                  concat_ws(' · ',l.name,o.order_date::text,nullif(o.remarks,'')),
                  'purchase_orders',o.order_no,o.status::text,o.created_at,
                  case when lower(o.order_no)=lower($2) then 0
                       when o.order_no ilike $3 escape '\\' then 1 else 2 end
             from grey_purchase_order o join ledger_account l on l.id=o.party_id
            where o.order_no ilike $1 escape '\\' or l.name ilike $1 escape '\\'
               or o.remarks ilike $1 escape '\\'
           union all
           select 'sales_order',o.id::text,o.order_no,
                  concat_ws(' · ',l.name,o.order_date::text,nullif(o.destination,'')),
                  'sales_orders',o.order_no,o.status::text,o.created_at,
                  case when lower(o.order_no)=lower($2) then 0
                       when o.order_no ilike $3 escape '\\' then 1 else 2 end
             from finish_sales_order o join ledger_account l on l.id=o.party_id
            where o.order_no ilike $1 escape '\\' or l.name ilike $1 escape '\\'
               or o.destination ilike $1 escape '\\' or o.remarks ilike $1 escape '\\'
           union all
           select 'dispatch',d.id::text,d.challan_no,
                  concat_ws(' · ',l.name,d.challan_date::text,d.lr_no,d.vehicle_no),
                  'delivery_challans',d.challan_no,d.status::text,d.created_at,
                  case when lower(d.challan_no)=lower($2) then 0
                       when d.challan_no ilike $3 escape '\\' then 1 else 2 end
             from dispatch d join ledger_account l on l.id=d.party_id
            where d.challan_no ilike $1 escape '\\' or l.name ilike $1 escape '\\'
               or d.lr_no ilike $1 escape '\\' or d.vehicle_no ilike $1 escape '\\'
           union all
           select 'sales_invoice',i.id::text,i.invoice_no,
                  concat_ws(' · ',l.name,i.invoice_date::text,l.gstin),
                  'sales_invoices',i.invoice_no,i.status::text,i.created_at,
                  case when lower(i.invoice_no)=lower($2) then 0
                       when i.invoice_no ilike $3 escape '\\' then 1 else 2 end
             from sales_invoice i join ledger_account l on l.id=i.party_id
            where i.invoice_no ilike $1 escape '\\' or l.name ilike $1 escape '\\'
               or l.gstin ilike $1 escape '\\'
           union all
           select 'purchase_invoice',i.id::text,i.our_ref||' / '||i.supplier_invoice_no,
                  concat_ws(' · ',l.name,i.invoice_date::text),
                  'purchase_invoices',i.our_ref,i.status::text,i.created_at,
                  case when lower(i.our_ref)=lower($2) or lower(i.supplier_invoice_no)=lower($2) then 0
                       when i.our_ref ilike $3 escape '\\' or i.supplier_invoice_no ilike $3 escape '\\' then 1 else 2 end
             from purchase_invoice i join ledger_account l on l.id=i.party_id
            where i.our_ref ilike $1 escape '\\' or i.supplier_invoice_no ilike $1 escape '\\'
               or l.name ilike $1 escape '\\'
           union all
           select 'payment',p.id::text,p.voucher_no,
                  concat_ws(' · ',l.name,p.payment_date::text,p.mode::text,p.instrument_no),
                  'payments',p.voucher_no,p.status::text,p.created_at,
                  case when lower(p.voucher_no)=lower($2) then 0
                       when p.voucher_no ilike $3 escape '\\' then 1 else 2 end
             from payment p join ledger_account l on l.id=p.party_id
            where p.voucher_no ilike $1 escape '\\' or l.name ilike $1 escape '\\'
               or p.instrument_no ilike $1 escape '\\' or p.narration ilike $1 escape '\\'
           union all
           select 'gst_note',n.id::text,n.note_no,
                  concat_ws(' · ',l.name,n.note_date::text,n.reason),
                  'gst_notes',n.note_no,n.status::text,n.created_at,
                  case when lower(n.note_no)=lower($2) then 0
                       when n.note_no ilike $3 escape '\\' then 1 else 2 end
             from gst_note n join ledger_account l on l.id=n.party_id
            where n.note_no ilike $1 escape '\\' or l.name ilike $1 escape '\\'
               or n.reason ilike $1 escape '\\'
           union all
           select 'eway_bill',e.id::text,coalesce(e.ewb_no,e.our_ref),
                  concat_ws(' · ',e.doc_no,e.doc_date::text,e.vehicle_no),
                  'eway_bills',coalesce(e.ewb_no,e.our_ref),e.status::text,e.created_at,
                  case when lower(coalesce(e.ewb_no,e.our_ref))=lower($2) then 0
                       when coalesce(e.ewb_no,e.our_ref) ilike $3 escape '\\' then 1 else 2 end
             from eway_bill e
            where e.our_ref ilike $1 escape '\\' or e.ewb_no ilike $1 escape '\\'
               or e.doc_no ilike $1 escape '\\' or e.vehicle_no ilike $1 escape '\\'
         ), ranked as (
           select matches.*,row_number() over (partition by kind order by rank,occurred_on desc nulls last) n
             from matches
         )
         select kind,id,title,subtitle,module,search_term as "filter",status,occurred_on
           from ranked where n <= 5
          order by rank,occurred_on desc nulls last,title
          limit $4`, [`%${escaped}%`, query.q, `${escaped}%`, query.limit]));
      res.json(rows);
    } catch (error) { next(error); }
  });

  return r;
}
