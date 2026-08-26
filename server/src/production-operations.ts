import { Router } from 'express';
import { z } from 'zod';
import { many, nextDocNumber, one, withTenant, type Db } from './db.ts';
import { requireWrite } from './auth.ts';
import { listQuery, paged, sendCsv } from './listing.ts';
import { round2, sumBy } from './money.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const barcode = z.string().trim().min(1).max(40);
const MAX_LINES = 1000;

interface TransferPiece {
  id: string; barcode: string; status: 'grey_in_stock' | 'received_finish' | 'cut_packed';
  current_qty: number; current_weight_kg: number | null; rack_code: string | null;
  business_location_id: string; held_by_ledger_id: string | null;
}

async function activeLocation(db: Db, id: string) {
  const location = await one<{ id: string; code: string; name: string }>(db,
    'select id,code,name from business_location where id=$1 and is_active', [id]);
  if (!location) throw new Error('active business location not found');
  return location;
}

export function productionOperationsRouter() {
  const router = Router();

  // --------------------------------------------------------- opening stock --

  router.get('/opening-stock', requireWrite('owner'), async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const { tenantId, userId } = req.session!;
      const page = await withTenant(tenantId, userId, db => paged<Record<string, unknown>>(db, {
        from: `(select b.id,b.batch_no,b.stock_date,b.fy_label,b.status::text,l.code as location_code,
                 l.name as location,count(bl.id)::int as pieces,
                 coalesce(sum(bl.original_qty),0) as quantity,
                 coalesce(sum(bl.grey_value+bl.jobwork_value+bl.other_value),0) as stock_value,
                 b.remarks,b.created_at
            from opening_stock_batch b join business_location l on l.id=b.business_location_id
            left join opening_stock_line bl on bl.batch_id=b.id
           group by b.id,l.code,l.name) x`,
        select: `x.*`,
        search: ['x.batch_no', 'x.location', 'x.remarks'], dateColumn: 'x.stock_date',
        orderBy: 'x.stock_date desc,x.batch_no desc'
      }, q));
      if (q.format === 'csv') return sendCsv(res, 'opening-stock', page.rows);
      res.json(page);
    } catch (error) { next(error); }
  });

  router.post('/opening-stock', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        fyLabel: z.string().regex(/^\d{4}-\d{2}$/), stockDate: isoDate,
        locationId: uuid, remarks: z.string().trim().max(500).default(''),
        lines: z.array(z.object({
          barcode, qualityId: uuid, designId: uuid.nullish(),
          gradeCode: z.string().trim().min(1).max(20), lotNo: z.string().trim().max(80).default(''),
          stockKind: z.enum(['grey','finish']), qty: z.coerce.number().finite().positive(),
          weightKg: z.coerce.number().finite().nonnegative().nullish(), rackCode: z.string().trim().max(30).nullish(),
          greyValue: z.coerce.number().finite().nonnegative().default(0),
          jobworkValue: z.coerce.number().finite().nonnegative().default(0),
          otherValue: z.coerce.number().finite().nonnegative().default(0)
        }).superRefine((line, ctx) => {
          if (line.stockKind === 'grey' && line.jobworkValue > 0) {
            ctx.addIssue({ code: 'custom', path: ['jobworkValue'], message: 'grey opening stock cannot carry job-work value' });
          }
        })).min(1).max(MAX_LINES)
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const result = await withTenant(tenantId, userId, async db => {
        await activeLocation(db, body.locationId);
        const batchNo = await nextDocNumber(db, tenantId, 'opening_stock', body.fyLabel);
        const batch = await one<{ id: string }>(db,
          `insert into opening_stock_batch
             (tenant_id,fy_label,batch_no,stock_date,business_location_id,remarks,created_by)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [tenantId,body.fyLabel,batchNo,body.stockDate,body.locationId,body.remarks,userId]);
        if (!batch) throw new Error('opening stock batch insert returned nothing');

        const pieces = await many<{ id: string; barcode: string }>(db,
          `insert into piece
             (tenant_id,barcode,quality_id,design_id,grade_code,lot_no,status,
              grey_qty,finish_qty,current_qty,uom,rack_code,
              grey_weight_kg,finish_weight_kg,current_weight_kg,
              grey_cost,jobwork_cost,other_cost,business_location_id)
           select $1,x.barcode,x.quality_id,x.design_id,x.grade_code,x.lot_no,
                  (case when x.stock_kind='grey' then 'grey_in_stock' else 'received_finish' end)::piece_status,
                  x.qty,case when x.stock_kind='finish' then x.qty end,x.qty,'MTR',x.rack_code,
                  x.weight_kg,case when x.stock_kind='finish' then x.weight_kg end,x.weight_kg,
                  x.grey_value,x.jobwork_value,x.other_value,$2
             from unnest($3::text[],$4::uuid[],$5::uuid[],$6::text[],$7::text[],$8::text[],
                         $9::numeric[],$10::numeric[],$11::text[],$12::numeric[],$13::numeric[],$14::numeric[])
                  as x(barcode,quality_id,design_id,grade_code,lot_no,stock_kind,qty,weight_kg,
                       rack_code,grey_value,jobwork_value,other_value)
           returning id,barcode`,
          [tenantId,body.locationId,
           body.lines.map(line => line.barcode),body.lines.map(line => line.qualityId),
           body.lines.map(line => line.designId ?? null),body.lines.map(line => line.gradeCode),
           body.lines.map(line => line.lotNo),body.lines.map(line => line.stockKind),
           body.lines.map(line => line.qty),body.lines.map(line => line.weightKg ?? null),
           body.lines.map(line => line.rackCode || null),body.lines.map(line => round2(line.greyValue)),
           body.lines.map(line => round2(line.jobworkValue)),body.lines.map(line => round2(line.otherValue))]);
        const ids = new Map(pieces.map(piece => [piece.barcode,piece.id]));
        const pieceIds = body.lines.map(line => {
          const id = ids.get(line.barcode);
          if (!id) throw new Error(`piece not created for barcode ${line.barcode}`);
          return id;
        });

        await db.query(
          `insert into opening_stock_line
             (tenant_id,batch_id,piece_id,sno,stock_kind,original_qty,original_weight_kg,
              grey_value,jobwork_value,other_value)
           select $1,$2,x.piece_id,x.sno,x.stock_kind,x.qty,x.weight_kg,
                  x.grey_value,x.jobwork_value,x.other_value
             from unnest($3::uuid[],$4::int[],$5::text[],$6::numeric[],$7::numeric[],
                         $8::numeric[],$9::numeric[],$10::numeric[])
                  as x(piece_id,sno,stock_kind,qty,weight_kg,grey_value,jobwork_value,other_value)`,
          [tenantId,batch.id,pieceIds,body.lines.map((_,index) => index+1),
           body.lines.map(line => line.stockKind),body.lines.map(line => line.qty),
           body.lines.map(line => line.weightKg ?? null),body.lines.map(line => round2(line.greyValue)),
           body.lines.map(line => round2(line.jobworkValue)),body.lines.map(line => round2(line.otherValue))]);

        await db.query(
          `insert into piece_movement
             (tenant_id,piece_id,event,from_status,to_status,qty_before,qty_after,
              weight_before_kg,weight_after_kg,doc_type,doc_id,created_by,to_rack,to_location_id,note)
           select $1,x.piece_id,'inward',null,
                  (case when x.stock_kind='grey' then 'grey_in_stock' else 'received_finish' end)::piece_status,
                  0,x.qty,null,x.weight_kg,'opening_stock',$2,$3,x.rack_code,$4,'audited opening stock'
             from unnest($5::uuid[],$6::text[],$7::numeric[],$8::numeric[],$9::text[])
                  as x(piece_id,stock_kind,qty,weight_kg,rack_code)`,
          [tenantId,batch.id,userId,body.locationId,pieceIds,body.lines.map(line => line.stockKind),
           body.lines.map(line => line.qty),body.lines.map(line => line.weightKg ?? null),
           body.lines.map(line => line.rackCode || null)]);

        return { id: batch.id,batchNo,pieces: pieceIds.length,
          quantity: body.lines.reduce((total,line) => total+line.qty,0),
          stockValue: sumBy(body.lines,line => line.greyValue+line.jobworkValue+line.otherValue) };
      });
      res.status(201).json(result);
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------ location stock --

  router.get('/location-stock', async (req, res, next) => {
    try {
      const query = z.object({ locationId: uuid.optional() }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId,userId,db => many(db,
        `select business_location_id,location_code,location,rack_code,status::text,quality,
                grade_code,pieces,quantity,stock_value
           from v_location_stock where ($1::uuid is null or business_location_id=$1)
          order by location_code,rack_code nulls last,status,quality,grade_code`,
        [query.locationId ?? null]));
      res.json(rows);
    } catch (error) { next(error); }
  });

  // ----------------------------------------------------- godown transfer --

  router.get('/location-transfers', async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const { tenantId,userId } = req.session!;
      const page = await withTenant(tenantId,userId,db => paged<Record<string,unknown>>(db,{
        from: `(select t.id,t.transfer_no,t.transfer_date,t.status::text,f.code as from_code,
                 f.name as from_location,d.code as to_code,d.name as to_location,
                 count(l.id)::int as pieces,coalesce(sum(l.transferred_qty),0) as quantity,
                 t.remarks,t.cancellation_reason,t.created_at
            from location_transfer t join business_location f on f.id=t.from_location_id
            join business_location d on d.id=t.to_location_id
            left join location_transfer_line l on l.transfer_id=t.id
           group by t.id,f.code,f.name,d.code,d.name) x`,
        select: `x.*`,
        search: ['x.transfer_no','x.from_location','x.to_location','x.remarks'],dateColumn:'x.transfer_date',
        orderBy:'x.transfer_date desc,x.transfer_no desc'
      },q));
      if (q.format==='csv') return sendCsv(res,'location-transfers',page.rows);
      res.json(page);
    } catch (error) { next(error); }
  });

  router.post('/location-transfers',requireWrite('store'),async (req,res,next) => {
    try {
      const body = z.object({
        transferDate: isoDate,fromLocationId:uuid,toLocationId:uuid,
        remarks:z.string().trim().max(500).default(''),
        lines:z.array(z.object({ barcode,toRack:z.string().trim().max(30).nullish() })).min(1).max(MAX_LINES)
      }).refine(value => value.fromLocationId!==value.toLocationId,
        { path:['toLocationId'],message:'destination must differ from source' }).parse(req.body);
      if (new Set(body.lines.map(line => line.barcode)).size!==body.lines.length) {
        throw new Error('a barcode may appear only once in a transfer');
      }
      const { tenantId,userId }=req.session!;
      const result=await withTenant(tenantId,userId,async db => {
        await activeLocation(db,body.fromLocationId); await activeLocation(db,body.toLocationId);
        const fy=await one<{label:string}>(db,
          `select label from financial_year where $1::date between starts_on and ends_on and status='open'`,
          [body.transferDate]);
        if (!fy) throw new Error('transfer date is outside the open financial year');
        const pieces=await many<TransferPiece>(db,
          `select id,barcode,status::text,current_qty,current_weight_kg,rack_code,
                  business_location_id,held_by_ledger_id
             from piece where barcode=any($1::text[]) for update`,
          [body.lines.map(line => line.barcode)]);
        if (pieces.length!==body.lines.length) throw new Error('one or more transfer barcodes are unknown');
        const byBarcode=new Map(pieces.map(piece => [piece.barcode,piece]));
        for (const line of body.lines) {
          const piece=byBarcode.get(line.barcode)!;
          if (piece.business_location_id!==body.fromLocationId) throw new Error(`${line.barcode}: piece is not at the source location`);
          if (piece.held_by_ledger_id || !['grey_in_stock','received_finish','cut_packed'].includes(piece.status)) {
            throw new Error(`${line.barcode}: only available mill stock can be transferred`);
          }
        }
        const transferNo=await nextDocNumber(db,tenantId,'location_transfer',fy.label);
        const transfer=await one<{id:string}>(db,
          `insert into location_transfer
             (tenant_id,transfer_no,transfer_date,from_location_id,to_location_id,remarks,created_by)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [tenantId,transferNo,body.transferDate,body.fromLocationId,body.toLocationId,body.remarks,userId]);
        if (!transfer) throw new Error('location transfer insert returned nothing');
        const ordered=body.lines.map(line => ({ line,piece:byBarcode.get(line.barcode)! }));
        await db.query(
          `insert into location_transfer_line
             (tenant_id,transfer_id,piece_id,sno,from_rack,to_rack,transferred_qty)
           select $1,$2,x.piece_id,x.sno,x.from_rack,x.to_rack,x.qty
             from unnest($3::uuid[],$4::int[],$5::text[],$6::text[],$7::numeric[])
                  as x(piece_id,sno,from_rack,to_rack,qty)`,
          [tenantId,transfer.id,ordered.map(row => row.piece.id),ordered.map((_,index)=>index+1),
           ordered.map(row => row.piece.rack_code),ordered.map(row => row.line.toRack || null),
           ordered.map(row => row.piece.current_qty)]);
        await db.query(
          `insert into piece_movement
             (tenant_id,piece_id,event,from_status,to_status,qty_before,qty_after,
              weight_before_kg,weight_after_kg,doc_type,doc_id,created_by,from_rack,to_rack,
              from_location_id,to_location_id,note)
           select $1,x.piece_id,'transfer',x.status::piece_status,x.status::piece_status,x.qty,x.qty,
                  x.weight_kg,x.weight_kg,'location_transfer',$2,$3,x.from_rack,x.to_rack,$4,$5,$6
             from unnest($7::uuid[],$8::text[],$9::numeric[],$10::numeric[],$11::text[],$12::text[])
                  as x(piece_id,status,qty,weight_kg,from_rack,to_rack)`,
          [tenantId,transfer.id,userId,body.fromLocationId,body.toLocationId,body.remarks || 'godown transfer',
           ordered.map(row => row.piece.id),ordered.map(row => row.piece.status),
           ordered.map(row => row.piece.current_qty),ordered.map(row => row.piece.current_weight_kg),
           ordered.map(row => row.piece.rack_code),ordered.map(row => row.line.toRack || null)]);
        return {id:transfer.id,transferNo,pieces:ordered.length,
          quantity:ordered.reduce((total,row)=>total+Number(row.piece.current_qty),0)};
      });
      res.status(201).json(result);
    } catch(error){next(error);}
  });

  router.post('/location-transfers/:id/cancel',requireWrite('store'),async(req,res,next)=>{
    try{
      const id=uuid.parse(req.params.id);
      const body=z.object({reason:z.string().trim().min(3).max(300)}).parse(req.body);
      const {tenantId,userId}=req.session!;
      const result=await withTenant(tenantId,userId,async db=>{
        const transfer=await one<{id:string;status:string;from_location_id:string;to_location_id:string}>(db,
          'select id,status::text,from_location_id,to_location_id from location_transfer where id=$1 for update',[id]);
        if(!transfer) throw new Error('location transfer not found');
        if(transfer.status==='cancelled') throw new Error('location transfer is already cancelled');
        const lines=await many<TransferPiece & {from_rack:string|null;to_rack:string|null;
          latest_doc_type:string;latest_doc_id:string;latest_from_location_id:string|null;latest_to_location_id:string|null}>(db,
          `select p.id,p.barcode,p.status::text,p.current_qty,p.current_weight_kg,p.rack_code,
                  p.business_location_id,p.held_by_ledger_id,l.from_rack,l.to_rack,
                  latest.doc_type as latest_doc_type,latest.doc_id as latest_doc_id,
                  latest.from_location_id as latest_from_location_id,
                  latest.to_location_id as latest_to_location_id
             from location_transfer_line l join piece p on p.id=l.piece_id
             join lateral (select doc_type,doc_id,from_location_id,to_location_id
                             from piece_movement where piece_id=p.id order by id desc limit 1) latest on true
            where l.transfer_id=$1 order by l.sno for update of p`,[id]);
        for(const line of lines){
          if(line.business_location_id!==transfer.to_location_id || line.rack_code!==line.to_rack || line.held_by_ledger_id
             || line.latest_doc_type!=='location_transfer' || line.latest_doc_id!==id
             || line.latest_from_location_id!==transfer.from_location_id
             || line.latest_to_location_id!==transfer.to_location_id){
            throw new Error(`${line.barcode}: piece moved after this transfer; reverse the later document first`);
          }
        }
        await db.query(
          `insert into piece_movement
             (tenant_id,piece_id,event,from_status,to_status,qty_before,qty_after,
              weight_before_kg,weight_after_kg,doc_type,doc_id,created_by,from_rack,to_rack,
              from_location_id,to_location_id,note)
           select $1,x.piece_id,'transfer',x.status::piece_status,x.status::piece_status,x.qty,x.qty,
                  x.weight_kg,x.weight_kg,'location_transfer',$2,$3,x.to_rack,x.from_rack,$4,$5,$6
             from unnest($7::uuid[],$8::text[],$9::numeric[],$10::numeric[],$11::text[],$12::text[])
                  as x(piece_id,status,qty,weight_kg,from_rack,to_rack)`,
          [tenantId,id,userId,transfer.to_location_id,transfer.from_location_id,
           `cancelled: ${body.reason}`,lines.map(line=>line.id),lines.map(line=>line.status),
           lines.map(line=>line.current_qty),lines.map(line=>line.current_weight_kg),
           lines.map(line=>line.from_rack),lines.map(line=>line.to_rack)]);
        await db.query(
          `update location_transfer set status='cancelled',cancelled_by=$2,cancelled_at=now(),
                  cancellation_reason=$3 where id=$1`,[id,userId,body.reason]);
        return {id,cancelled:true,pieces:lines.length};
      });
      res.json(result);
    }catch(error){next(error);}
  });

  return router;
}
