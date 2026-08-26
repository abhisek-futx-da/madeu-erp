import React, {useEffect, useState} from 'react';
import {Calculator, Edit3, PackagePlus, Plus, Save, Settings2, Trash2, X} from 'lucide-react';
import {api, ApiError} from '../lib/api';
import {useApi} from '../lib/useApi';
import {CustomFieldsPanel} from './CustomFieldsPanel';

type Edition = 'weaving' | 'dyeing' | 'exports' | 'logistics' | 'garments';
type Resource = {
  id: string; resource_type: string; code: string; name: string; uom: string;
  opening_qty: number; opening_value_paise: number; payload: Record<string, unknown>;
  quantity: number; value_paise: number; average_rate_paise: number; is_active: boolean;
};
type Line = {
  resourceId: string; lineKind: string; description: string; quantity: number;
  uom: string; rate: number; amount: number; payload: Record<string, unknown>;
};
type StoredLine = {
  resource_id: string | null; line_kind: string; description: string; quantity: number;
  uom: string; rate_paise: number; amount_paise: number; payload: Record<string, unknown>;
};
type Costing = {
  material_paise: number; labour_paise: number; machine_paise: number;
  logistics_duty_paise: number; other_paise: number; total_cost_paise: number;
};

const input='erp-input min-h-11 w-full';
const label='mb-1 block text-[11px] font-bold text-slate-700';
const kinds=['receipt','produce','return_in','issue','consume','return_out','labour','machine','freight','duty','overhead','subcontract','other'];
const stockKinds=new Set(['receipt','produce','return_in','issue','consume','return_out']);
const money=(paise:number)=>`₹${(Number(paise||0)/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const blankLine=():Line=>({resourceId:'',lineKind:'consume',description:'',quantity:0,uom:'',rate:0,amount:0,payload:{}});

export const EditionResourcePanel:React.FC<{
  edition:Edition; resourceTypes:string[]; canWrite:boolean; enabled:boolean;
}>=({edition,resourceTypes,canWrite,enabled})=>{
  const resources=useApi<Resource[]>(`/editions/${edition}/resources`);
  const emptyForm={id:'',resourceType:'',code:'',name:'',uom:'KGS',openingQty:0,openingValue:0,payload:{} as Record<string,unknown>,isActive:true};
  const[form,setForm]=useState(emptyForm);
  const[busy,setBusy]=useState(false);const[notice,setNotice]=useState('');const[custom,setCustom]=useState<Resource|null>(null);
  useEffect(()=>{if(resourceTypes.length&&!form.resourceType)setForm(current=>({...current,resourceType:resourceTypes[0]!}));},[resourceTypes,form.resourceType]);
  const saveResource=async()=>{setBusy(true);setNotice('');try{await api.post(`/editions/${edition}/resources`,{...form,id:form.id||undefined});const wasEditing=Boolean(form.id);setForm({...emptyForm,resourceType:resourceTypes[0]??''});resources.reload();setNotice(wasEditing?'Resource updated':'Resource added to the edition stock ledger');}catch(error){setNotice(error instanceof ApiError?error.message:String(error));}finally{setBusy(false);}};
  const editResource=(row:Resource)=>{setNotice('');setForm({id:row.id,resourceType:row.resource_type,code:row.code,name:row.name,uom:row.uom,openingQty:Number(row.opening_qty),openingValue:Number(row.opening_value_paise)/100,payload:row.payload??{},isActive:row.is_active});};
  return <section className="rounded border bg-white xl:col-span-2">
    <div className="flex items-center gap-2 border-b bg-slate-50 p-3"><PackagePlus className="h-4 w-4 text-blue-800"/><strong className="text-blue-950">Materials, machines and operating resources</strong><span className="ml-auto text-slate-500">Average-cost stock shared by every workflow in this edition</span></div>
    <div className="grid gap-4 p-4 xl:grid-cols-[420px_1fr]">
      <fieldset disabled={!canWrite||!enabled} className="grid gap-3 rounded border p-3">
        <legend className="px-2 font-bold text-blue-950">{form.id?'Edit resource':'Add resource'}</legend>
        <label><span className={label}>Resource type</span><select className={input} value={form.resourceType} onChange={event=>setForm({...form,resourceType:event.target.value})}>{resourceTypes.map(type=><option key={type} value={type}>{type.replaceAll('_',' ')}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-2"><label><span className={label}>Code</span><input aria-label="Edition resource code" className={input} value={form.code} onChange={event=>setForm({...form,code:event.target.value.toUpperCase()})}/></label><label><span className={label}>UOM</span><input aria-label="Edition resource UOM" className={input} value={form.uom} onChange={event=>setForm({...form,uom:event.target.value.toUpperCase()})}/></label></div>
        <label><span className={label}>Name</span><input aria-label="Edition resource name" className={input} value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></label>
        <div className="grid grid-cols-2 gap-2"><label><span className={label}>Opening quantity</span><input aria-label="Edition opening quantity" type="number" min="0" step="0.001" className={input} value={form.openingQty} onChange={event=>setForm({...form,openingQty:Number(event.target.value)})}/></label><label><span className={label}>Opening value (₹)</span><input aria-label="Edition opening value" type="number" min="0" step="0.01" className={input} value={form.openingValue} onChange={event=>setForm({...form,openingValue:Number(event.target.value)})}/></label></div>
        {form.id&&<label className="flex min-h-11 items-center gap-2 rounded border px-3"><input type="checkbox" checked={form.isActive} onChange={event=>setForm({...form,isActive:event.target.checked})}/>Active and available for new stock lines</label>}
        <div className="flex gap-2"><button disabled={busy||form.code.length<1||form.name.length<2||!form.resourceType} className="erp-btn erp-btn-primary min-h-11" onClick={()=>void saveResource()}>{form.id?<Save className="h-4 w-4"/>:<Plus className="h-4 w-4"/>}{form.id?'Save resource':'Add resource'}</button>{form.id&&<button className="erp-btn min-h-11" onClick={()=>setForm({...emptyForm,resourceType:resourceTypes[0]??''})}><X className="h-4 w-4"/>Cancel edit</button>}</div>
        {notice&&<p role="status" className="rounded bg-slate-100 p-2">{notice}</p>}
      </fieldset>
      <div className="overflow-auto" tabIndex={0} aria-label={`${edition} resource stock table`}><table className="w-full min-w-[720px]"><thead><tr><th className="p-2 text-left">Type</th><th className="p-2 text-left">Code / resource</th><th className="p-2 text-right">Stock</th><th className="p-2 text-right">Average rate</th><th className="p-2 text-right">Value</th><th></th></tr></thead><tbody>{(resources.data??[]).map(row=><tr className="border-t" key={row.id}><td className="p-2 capitalize">{row.resource_type.replaceAll('_',' ')}</td><td className="p-2"><b className="font-mono text-blue-900">{row.code}</b><span className="block">{row.name}</span></td><td className="p-2 text-right font-mono">{Number(row.quantity).toLocaleString('en-IN')} {row.uom}</td><td className="p-2 text-right font-mono">{money(row.average_rate_paise)}</td><td className="p-2 text-right font-mono">{money(row.value_paise)}</td><td className="p-2"><div className="flex gap-1">{canWrite&&<><button aria-label={`Edit resource ${row.code}`} className="erp-btn min-h-11" onClick={()=>editResource(row)}><Edit3 className="h-4 w-4"/></button><button aria-label={`Custom fields for resource ${row.code}`} className="erp-btn min-h-11" onClick={()=>setCustom(row)}><Settings2 className="h-4 w-4"/></button></>}</div></td></tr>)}{!resources.loading&&(resources.data??[]).length===0&&<tr><td colSpan={6} className="p-8 text-center text-slate-500">No resources yet. Add yarn, chemicals, vehicles, packaging, fabric, trims or machines required by this edition.</td></tr>}</tbody></table></div>
    </div>
    {custom&&<CustomFieldsPanel entityType="edition_resource" entityId={custom.id} label={custom.code} onClose={()=>setCustom(null)}/>} 
  </section>;
};

export const EditionLinesPanel:React.FC<{
  edition:Edition; document:{id:string;doc_no:string;status:string}; canWrite:boolean; onClose:()=>void;
}>=({edition,document,canWrite,onClose})=>{
  const data=useApi<{lines:StoredLine[];costing:Costing|null}>(`/editions/${edition}/documents/${document.id}/lines`);
  const resources=useApi<Resource[]>(`/editions/${edition}/resources`);
  const[lines,setLines]=useState<Line[]>([]);const[initialized,setInitialized]=useState(false);const[busy,setBusy]=useState(false);const[notice,setNotice]=useState('');
  useEffect(()=>{if(data.data&&!initialized){setLines(data.data.lines.map(line=>({resourceId:line.resource_id??'',lineKind:line.line_kind,description:line.description,quantity:Number(line.quantity),uom:line.uom,rate:Number(line.rate_paise)/100,amount:Number(line.amount_paise)/100,payload:line.payload})));setInitialized(true);}},[data.data,initialized]);
  const editable=canWrite&&['draft','in_progress'].includes(document.status);
  const update=(index:number,change:Partial<Line>)=>setLines(current=>current.map((line,i)=>i===index?{...line,...change}:line));
  const save=async()=>{setBusy(true);setNotice('');try{await api.post(`/editions/${edition}/documents/${document.id}/lines`,{lines:lines.map(line=>({resourceId:line.resourceId||null,lineKind:line.lineKind,description:line.description,quantity:line.quantity,uom:line.uom,ratePaise:Math.round(line.rate*100),amountPaise:Math.round(line.amount*100),payload:line.payload}))});data.reload();setNotice('Stock and costing lines saved');}catch(error){setNotice(error instanceof ApiError?error.message:String(error));}finally{setBusy(false);}};
  const cost=data.data?.costing;
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 p-3" role="dialog" aria-modal="true" aria-label={`Materials and costing for ${document.doc_no}`}>
    <section className="flex max-h-[94dvh] w-full max-w-7xl flex-col overflow-hidden rounded border bg-white shadow-2xl">
      <header className="flex items-center gap-2 border-b bg-blue-950 px-4 py-3 text-white"><Calculator className="h-4 w-4"/><strong>{document.doc_no} · materials and job costing</strong><span className="ml-auto uppercase">{document.status.replace('_',' ')}</span><button aria-label="Close materials and costing" onClick={onClose}><X className="h-5 w-5"/></button></header>
      {cost&&<div className="grid grid-cols-2 gap-2 border-b bg-slate-50 p-3 md:grid-cols-6">{([['Material',cost.material_paise],['Labour',cost.labour_paise],['Machine',cost.machine_paise],['Freight / duty',cost.logistics_duty_paise],['Other',cost.other_paise],['Total',cost.total_cost_paise]] as const).map(([name,value])=><div className="rounded border bg-white p-2" key={name}><span className="block text-[10px] uppercase text-slate-500">{name}</span><b className="font-mono">{money(value)}</b></div>)}</div>}
      <div className="flex-1 overflow-auto p-3" tabIndex={0}><table className="w-full min-w-[1100px]"><thead><tr><th className="p-2 text-left">Line type</th><th className="p-2 text-left">Resource</th><th className="p-2 text-left">Description</th><th className="p-2">Quantity</th><th className="p-2">UOM</th><th className="p-2">Rate ₹</th><th className="p-2">Amount ₹</th><th></th></tr></thead><tbody>{lines.map((line,index)=><tr className="border-t" key={index}><td className="p-1"><select disabled={!editable} aria-label={`Line type ${index+1}`} className={input} value={line.lineKind} onChange={event=>update(index,{lineKind:event.target.value})}>{kinds.map(kind=><option key={kind} value={kind}>{kind.replaceAll('_',' ')}</option>)}</select></td><td className="p-1"><select disabled={!editable||!stockKinds.has(line.lineKind)} aria-label={`Line resource ${index+1}`} className={input} value={line.resourceId} onChange={event=>{const resource=(resources.data??[]).find(row=>row.id===event.target.value);update(index,{resourceId:event.target.value,uom:resource?.uom??line.uom,description:line.description||resource?.name||''});}}><option value="">No stock resource</option>{(resources.data??[]).map(resource=><option value={resource.id} key={resource.id}>{resource.code} · {resource.name} · {Number(resource.quantity)} {resource.uom}</option>)}</select></td><td className="p-1"><input disabled={!editable} aria-label={`Line description ${index+1}`} className={input} value={line.description} onChange={event=>update(index,{description:event.target.value})}/></td><td className="p-1"><input disabled={!editable} aria-label={`Line quantity ${index+1}`} type="number" min="0" step="0.001" className={`${input} text-right`} value={line.quantity} onChange={event=>update(index,{quantity:Number(event.target.value)})}/></td><td className="p-1"><input disabled={!editable} aria-label={`Line UOM ${index+1}`} className={input} value={line.uom} onChange={event=>update(index,{uom:event.target.value.toUpperCase()})}/></td><td className="p-1"><input disabled={!editable} aria-label={`Line rate ${index+1}`} type="number" min="0" step="0.01" className={`${input} text-right`} value={line.rate} onChange={event=>{const rate=Number(event.target.value);update(index,{rate,amount:Number((line.quantity*rate).toFixed(2))});}}/></td><td className="p-1"><input disabled={!editable} aria-label={`Line amount ${index+1}`} type="number" min="0" step="0.01" className={`${input} text-right`} value={line.amount} onChange={event=>update(index,{amount:Number(event.target.value)})}/></td><td className="p-1">{editable&&<button aria-label={`Remove line ${index+1}`} className="erp-btn min-h-11" onClick={()=>setLines(current=>current.filter((_,i)=>i!==index))}><Trash2 className="h-4 w-4 text-red-700"/></button>}</td></tr>)}{lines.length===0&&<tr><td colSpan={8} className="p-8 text-center text-slate-500">No material or cost lines recorded.</td></tr>}</tbody></table></div>
      <footer className="flex flex-wrap items-center gap-2 border-t bg-slate-50 p-3">{editable&&<><button disabled={data.loading} className="erp-btn min-h-11" onClick={()=>setLines(current=>[...current,blankLine()])}><Plus className="h-4 w-4"/>Add line</button><button disabled={busy||data.loading||lines.some(line=>!line.description||(stockKinds.has(line.lineKind)&&(!line.resourceId||line.quantity<=0)))} className="erp-btn erp-btn-primary min-h-11" onClick={()=>void save()}><Save className="h-4 w-4"/>Save lines</button></>} {notice&&<span role="status" className="font-semibold">{notice}</span>}<button className="erp-btn ml-auto min-h-11" onClick={onClose}>Close</button></footer>
    </section>
  </div>;
};
