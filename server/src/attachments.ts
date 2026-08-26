import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant } from './db.ts';
import type { Permission } from './auth.ts';

const uuid = z.string().uuid();
const DOCS = {
  sales_invoice: { table: 'sales_invoice', permission: 'write:sales' },
  purchase_invoice: { table: 'purchase_invoice', permission: 'write:accounts' },
  payment: { table: 'payment', permission: 'write:accounts' },
  grey_inward: { table: 'grey_inward', permission: 'write:store' },
  dyeing_issue: { table: 'dyeing_issue', permission: 'write:store' },
  dyeing_receipt: { table: 'dyeing_receipt', permission: 'write:store' },
  dispatch: { table: 'dispatch', permission: 'write:sales' },
  opening_stock: { table: 'opening_stock_batch', permission: 'write:owner' },
  location_transfer: { table: 'location_transfer', permission: 'write:store' },
  edition_document: { table: 'edition_document', permission: 'write:edition' }
} as const;
const docType = z.enum(Object.keys(DOCS) as [keyof typeof DOCS, ...(keyof typeof DOCS)[]]);

function canWrite(permissions: Permission[] | undefined, permission: string) {
  if(permission==='write:edition') return Boolean(permissions?.includes('write:store')||permissions?.includes('write:sales'));
  return Boolean(permissions?.includes(permission as Permission));
}

function decodedFile(dataBase64: string, contentType: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw new Error('attachment is not valid base64');
  const content = Buffer.from(dataBase64, 'base64');
  if (content.length < 1 || content.length > 5 * 1024 * 1024) {
    throw new Error('attachment must be between 1 byte and 5 MB');
  }
  const pdf = content.subarray(0, 5).toString() === '%PDF-';
  const jpeg = content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  const png = content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if ((contentType === 'application/pdf' && !pdf) ||
      (contentType === 'image/jpeg' && !jpeg) ||
      (contentType === 'image/png' && !png)) {
    throw new Error('attachment content does not match its declared PDF/JPEG/PNG type');
  }
  return content;
}

export function attachmentRouter() {
  const router = Router();

  router.get('/attachments', async (req, res, next) => {
    try {
      const query = z.object({ docType, docId: uuid }).parse(req.query);
      const { tenantId,userId } = req.session!;
      const rows = await withTenant(tenantId,userId,db => many(db,
        `select a.id,a.doc_type,a.doc_id,a.file_name,a.content_type,a.byte_size,a.sha256,
                a.note,a.status,a.created_at,u.full_name as created_by_name,
                a.removed_at,a.removal_reason
           from document_attachment a join app_user u on u.id=a.created_by
          where a.doc_type=$1 and a.doc_id=$2 order by a.created_at desc`,
        [query.docType,query.docId]));
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.post('/attachments', async (req, res, next) => {
    try {
      const body = z.object({
        docType,docId:uuid,fileName:z.string().trim().min(1).max(180),
        contentType:z.enum(['application/pdf','image/jpeg','image/png']),
        dataBase64:z.string().min(1).max(7_100_000),note:z.string().trim().max(500).default('')
      }).parse(req.body);
      const definition=DOCS[body.docType];
      if(!canWrite(req.session?.permissions,definition.permission)) {
        return res.status(403).json({error:`this profile cannot attach evidence to ${body.docType}`});
      }
      const content=decodedFile(body.dataBase64,body.contentType);
      const safeName=body.fileName.replace(/[\\/\u0000-\u001f]/g,'_');
      const sha256=createHash('sha256').update(content).digest('hex');
      const {tenantId,userId}=req.session!;
      const row=await withTenant(tenantId,userId,async db=>{
        const exists=await one<{id:string}>(db,
          `select id from ${definition.table} where id=$1`,[body.docId]);
        if(!exists) throw new Error(`${body.docType} document not found`);
        const attachment=await one<{id:string}>(db,
          `insert into document_attachment
             (tenant_id,doc_type,doc_id,file_name,content_type,byte_size,sha256,content,note,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
          [tenantId,body.docType,body.docId,safeName,body.contentType,content.length,sha256,content,body.note,userId]);
        if(!attachment) throw new Error('attachment insert returned nothing');
        await db.query(`insert into document_attachment_event
          (tenant_id,attachment_id,event,actor_id) values ($1,$2,'added',$3)`,
          [tenantId,attachment.id,userId]);
        return {id:attachment.id,fileName:safeName,byteSize:content.length,sha256};
      });
      res.status(201).json(row);
    } catch(error){next(error);}
  });

  router.get('/attachments/:id/download', async (req,res,next)=>{
    try{
      const id=uuid.parse(req.params.id);const {tenantId,userId}=req.session!;
      const file=await withTenant(tenantId,userId,db=>one<{
        file_name:string;content_type:string;content:Buffer;status:string
      }>(db,`select file_name,content_type,content,status from document_attachment where id=$1`,[id]));
      if(!file||file.status!=='active') return res.status(404).json({error:'active attachment not found'});
      res.setHeader('content-type',file.content_type);
      res.setHeader('content-disposition',`attachment; filename="${file.file_name.replace(/["\r\n]/g,'_')}"`);
      res.setHeader('x-content-type-options','nosniff');
      res.send(file.content);
    }catch(error){next(error);}
  });

  router.post('/attachments/:id/remove', async(req,res,next)=>{
    try{
      const id=uuid.parse(req.params.id);
      const body=z.object({reason:z.string().trim().min(3).max(300)}).parse(req.body);
      const {tenantId,userId}=req.session!;
      const out=await withTenant(tenantId,userId,async db=>{
        const current=await one<{id:string;doc_type:keyof typeof DOCS;status:string}>(db,
          `select id,doc_type,status from document_attachment where id=$1 for update`,[id]);
        if(!current) throw new Error('attachment not found');
        if(current.status==='removed') throw new Error('attachment is already removed');
        if(!canWrite(req.session?.permissions,DOCS[current.doc_type].permission)) {
          throw new Error(`this profile cannot remove evidence from ${current.doc_type}`);
        }
        await db.query(`update document_attachment set status='removed',removed_by=$2,
          removed_at=now(),removal_reason=$3 where id=$1`,[id,userId,body.reason]);
        await db.query(`insert into document_attachment_event
          (tenant_id,attachment_id,event,reason,actor_id) values ($1,$2,'removed',$3,$4)`,
          [tenantId,id,body.reason,userId]);
        return {id,removed:true};
      });
      res.json(out);
    }catch(error){next(error);}
  });
  return router;
}
